# Plan: robust PowerShell execution in the sidecar (multi-line + encoding)

## Problem
`RunPowerShell` (sidecar/Program.cs) runs `powershell.exe -NoProfile -NonInteractive -Command -`
and writes the script to **stdin**. Multi-line scripts fed this way SILENTLY FAIL: only the leading
statements execute, `for {...}` / `if {...}` block bodies are dropped, exit code is 0, stdout empty,
no error. Verified on a real client: a `\n`-joined recombine script produced a 0-byte output file; the
same logic as a single line produced the correct bytes. So the driver currently does **not** reliably
support multi-line PowerShell. (NovaWindows2 used a persistent session, so it was never exposed.)

Secondary: the sidecar does not set stdin/stdout encoding, so non-ASCII script content (Unicode,
Chinese, Chinese inside `#` comments) is at risk of being mangled in transit.

## Phase 1 — Fix multi-line execution (no temp file) [DONE — validated 17/17]
Implemented in `sidecar/Program.cs` `RunPowerShell`. Encoding decision CONFIRMED by tests: default
(no encoding set) mangles CJK to `?`; UTF-8 on both ends + child `[Console]::InputEncoding/OutputEncoding`
= UTF-8 round-trips CJK/emoji/Chinese-in-comments correctly. Validation harness:
`sidecar/tests/RunPowerShell.validation.ps1` (17/17 pass on a real Windows client). Negatives all surface
errors on stderr (no more silent 0-byte success).

DEPLOYED to client qa-win37: .NET 10 SDK installed user-level (~/.dotnet), sidecar published win-x64,
swapped into ~/.appium/node_modules/appium-flaui-native-driver/prebuilt/win-x64 (old build backed up to
prebuilt/win-x64.bak). No Appium restart needed — the sidecar spawns per session. E2E verified through
the REAL driver: `tests/manual/powershell-multiline-e2e.mjs` → 6/6 pass (multi-line for-loop & if/else,
Chinese, Chinese-in-#comment, emoji, multi-line file-IO round-trip). The C# change compiles and runs.

Change the invocation so PowerShell reads the WHOLE stdin as one script and runs it, instead of
letting `-Command -` parse stdin line-by-line:

    powershell.exe -NoProfile -NonInteractive -Command "& ([ScriptBlock]::Create([Console]::In.ReadToEnd()))"

- Keep writing the script to stdin (unchanged), keep the CTS timeout, process-tree kill, and the
  concurrent stdout/stderr drain.
- Use `ArgumentList` instead of a single arguments string (clean quoting of the `-Command` value).
- **Encoding (decided by tests):** set `StandardInputEncoding` and `StandardOutputEncoding`/
  `StandardErrorEncoding` to UTF-8 (no BOM) so Unicode/Chinese survive both directions. If the child
  must also be told its input encoding, prepend `[Console]::InputEncoding=[Text.Encoding]::UTF8;` /
  `$OutputEncoding` handling — exact form to be confirmed by the encoding tests below.
- Handles both multi-line scripts AND large single-line payloads (~46 KB chunk writes) — verified.
- Why not alternatives: `-EncodedCommand` breaks on large scripts (command-line arg limit ~32767);
  temp `.ps1` requires a guaranteed-writable path (see Phase 3).

Validation: comprehensive positive + negative test matrix run through the EXACT sidecar mechanism
(.NET Process, RedirectStandardInput, Write+Close, ReadToEnd) on a real Windows client. See test matrix.

## Phase 2 — Surface exit code / stderr CAUTIOUSLY [follow-up]
The sidecar already returns `{stdout, stderr, exitCode}`; the TS `execute()` drops all but stdout.
- Do **NOT** auto-fail on `ExitCode != 0`. PowerShell's process exit code reflects the last native
  command's exit / a stale `$LASTEXITCODE`; many commands set a non-zero code mid-run yet succeed.
  (NovaWindows2 deliberately ignores process exit code — it resets `$LASTEXITCODE=0` per command and
  only flags NATIVE-exe failures via an explicit `[NativeExit] N` sentinel, plus stderr-as-error gated
  by a `treatStderrAsError` cap.)
- Plan: keep returning exitCode/stderr for diagnostics; only treat as failure when the script itself
  throws a terminating error (lands on stderr) or via an opt-in cap. Default behavior stays permissive.

## Phase 3 — Temp `.ps1` fallback, only if forced [contingency]
If a script legitimately needs `$input` / `[Console]::In` itself (conflicts with ReadToEnd), fall back
to writing a temp `.ps1` in the **sidecar exe directory** (`AppContext.BaseDirectory` — a location the
sidecar can always write) and run `-File`, deleting it afterward. Not needed given Phase 1 evidence.

## Test matrix (positive + negative; run on real Windows PowerShell)
Positive (must execute correctly, exact output/bytes):
- single-line `Write-Output`
- multi-line: var + `for` loop + write
- multi-line with `if {...}` block and `throw` in the untaken branch
- special chars in values: `' " backtick $ ; | & {} [] () < > % ^ @`
- Unicode / Chinese string value: `你好世界`, emoji
- `#` comment containing Chinese, then a real statement on the next line
- environment variables: `$env:USERNAME`, `$env:TEMP`, `$env:COMPUTERNAME`
- here-string (`@"..."@` / `@'...'@`)
- pipeline + cmdlets
- large single-line payload (~46 KB `Set-Content -Value`)
- the real chunk-recombine script (multi-line) → byte-perfect round-trip (SHA256 match)
- path with forward slashes and backslashes

Negative (must NOT silently corrupt; error must be observable on stderr / non-empty):
- syntax error (unterminated string, unbalanced brace)
- explicit `throw "..."`
- non-existent cmdlet (`Get-NoSuchThing`)
- runtime error (`1/0`)
- the recombine `throw "Missing chunk"` path when a chunk is absent
