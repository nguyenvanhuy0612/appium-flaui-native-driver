# Manual Windows validation harness for the sidecar's RunPowerShell (Program.cs).
# Replicates the patched invocation EXACTLY -- UTF-8 in/out + run the whole stdin as one scriptblock:
#   powershell -NoProfile -NonInteractive -Command
#     "[Console]::InputEncoding=[Text.Encoding]::UTF8; [Console]::OutputEncoding=[Text.Encoding]::UTF8;
#      & ([ScriptBlock]::Create([Console]::In.ReadToEnd()))"
# (Harness writes UTF-8 bytes to BaseStream because Windows PowerShell 5.1 lacks
#  ProcessStartInfo.StandardInputEncoding; the .NET sidecar sets StandardInputEncoding=UTF8 instead.)
# Covers multi-line, special chars, CJK/emoji, Chinese in `#` comments, env vars, pipelines, a ~46KB
# single-line payload, the real chunk-recombine round-trip (SHA256), and negatives (errors must be
# observable on stderr, never silent).
#   powershell -NoProfile -ExecutionPolicy Bypass -File RunPowerShell.validation.ps1
# Last run: 17/17 pass (client qa-win37, Windows PowerShell 5.1).
$utf8=New-Object System.Text.UTF8Encoding($false)
$childCmd='[Console]::InputEncoding=[Text.Encoding]::UTF8; [Console]::OutputEncoding=[Text.Encoding]::UTF8; & ([ScriptBlock]::Create([Console]::In.ReadToEnd()))'
# Faithful replica of the patched sidecar RunPowerShell (UTF-8 both ends, ScriptBlock from stdin, concurrent drain)
function Run($script){
  $psi=New-Object Diagnostics.ProcessStartInfo('powershell.exe',"-NoProfile -NonInteractive -Command `"$childCmd`"")
  $psi.RedirectStandardInput=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true;$psi.UseShellExecute=$false
  $psi.StandardOutputEncoding=$utf8;$psi.StandardErrorEncoding=$utf8
  $p=[Diagnostics.Process]::Start($psi)
  $ot=$p.StandardOutput.ReadToEndAsync();$et=$p.StandardError.ReadToEndAsync()
  $b=$utf8.GetBytes($script);$p.StandardInput.BaseStream.Write($b,0,$b.Length);$p.StandardInput.BaseStream.Flush();$p.StandardInput.Close()
  $p.WaitForExit()
  return @{exit=$p.ExitCode;out=$ot.Result;err=$et.Result}
}
function Trim($s){ $s -replace "`r?`n$","" }
$cn=[char]0x4F60+[char]0x597D+[char]0x4E16+[char]0x754C; $emoji=[char]::ConvertFromUtf32(0x1F600)
$dir='C:\Temp\ph1'; Remove-Item -Recurse -Force $dir -EA SilentlyContinue; New-Item -ItemType Directory -Force $dir|Out-Null
$pass=0;$fail=0
function Check($name,$cond,$info){ if($cond){$script:pass++;"PASS  $name"}else{$script:fail++;"FAIL  $name  >> $info"} }

# ---------- POSITIVE ----------
$r=Run "Write-Output 'hello'";                Check 'P1 single-line'      ((Trim $r.out) -eq 'hello') $r.out
$r=Run "`$s=''`nfor(`$i=1;`$i -le 3;`$i++){ `$s+=`$i }`nWrite-Output `$s"; Check 'P2 multiline for-loop' ((Trim $r.out) -eq '123') "out=$($r.out) err=$($r.err)"
$r=Run "if(`$false){ throw 'x' }`nelse { Write-Output 'OK' }"; Check 'P3 multiline if/else' ((Trim $r.out) -eq 'OK') "out=$($r.out) err=$($r.err)"
$r=Run "Write-Output @'`na`"b'c`$x;e|f&g{}[]()<>%^@`n'@"; Check 'P4 special-chars' ((Trim $r.out) -eq 'a"b''c$x;e|f&g{}[]()<>%^@') $r.out
$r=Run ("Write-Output '{0}'" -f $cn);          Check 'P5 chinese-string'   ((Trim $r.out) -eq $cn) ("hex="+(($utf8.GetBytes((Trim $r.out))|%{$_.ToString('x2')}) -join ''))
$r=Run ("# {0} this is a chinese comment`n`$v='{0}'; Write-Output `$v" -f $cn); Check 'P6 chinese-#comment' ((Trim $r.out) -eq $cn) $r.out
$r=Run ("Write-Output '{0}'" -f $emoji);        Check 'P7 emoji'            ((Trim $r.out) -eq $emoji) $r.out
$r=Run 'Write-Output $env:COMPUTERNAME';        Check 'P8 env-var'          ((Trim $r.out) -eq $env:COMPUTERNAME) $r.out
$r=Run "Write-Output (1..5 | Measure-Object -Sum).Sum"; Check 'P9 pipeline' ((Trim $r.out) -eq '15') $r.out
$r=Run "Write-Output @`"`nline1`nline2`n`"@"; Check 'P10 here-string' ((((Trim $r.out) -replace "`r`n","`n")) -eq "line1`nline2") "out=[$($r.out)]"
# P11 large single-line ~46KB
$bytes=New-Object byte[] 34606;(New-Object Random).NextBytes($bytes);$b64=[Convert]::ToBase64String($bytes)
$r=Run ("Set-Content -LiteralPath 'C:/Temp/ph1/big.b64' -Value '$b64'; Write-Output 'WROTE'"); Check 'P11 large-46KB' (((Trim $r.out) -eq 'WROTE') -and ((Get-Item 'C:\Temp\ph1\big.b64').Length -ge 46000)) "out=$($r.out)"
# P12 real recombine round-trip (the actual production script, multi-line) hash match
$srcHash=[BitConverter]::ToString((New-Object Security.Cryptography.SHA256Managed).ComputeHash($bytes))
Set-Content -LiteralPath 'C:/Temp/ph1/c.p12.part0.b64' -Value $b64
$rec="`$out=[System.IO.File]::OpenWrite('C:/Temp/ph1/c.p12')`n`$out.SetLength(0)`nfor(`$i=0;`$i -lt 1;`$i++){`n  `$cp=Join-Path 'C:\Temp\ph1' ('c.p12.part'+`$i.ToString('D1')+'.b64')`n  if(-not(Test-Path -LiteralPath `$cp)){`$out.Close();throw `"Missing chunk: `$cp`"}`n  `$by=[Convert]::FromBase64String((Get-Content -LiteralPath `$cp -Raw))`n  `$out.Write(`$by,0,`$by.Length)`n}`n`$out.Close()`nWrite-Output 'Transfer complete'"
$r=Run $rec
$outHash=[BitConverter]::ToString((New-Object Security.Cryptography.SHA256Managed).ComputeHash([IO.File]::ReadAllBytes('C:\Temp\ph1\c.p12')))
Check 'P12 recombine-roundtrip' (((Trim $r.out) -eq 'Transfer complete') -and ($srcHash -eq $outHash)) "out=$($r.out) match=$($srcHash -eq $outHash) err=$($r.err)"

# ---------- NEGATIVE (error must be OBSERVABLE: non-empty stderr) ----------
$r=Run "Write-Output 'unterminated";           Check 'N1 syntax-error'     ($r.err.Trim().Length -gt 0) "err=$($r.err)"
$r=Run "throw 'boom'";                          Check 'N2 throw'            ($r.err -match 'boom') "err=$($r.err)"
$r=Run "Get-NoSuchThing12345";                  Check 'N3 bad-cmdlet'       ($r.err.Trim().Length -gt 0) "err=$($r.err)"
$r=Run "1/0";                                   Check 'N4 divide-by-zero'   ($r.err.Trim().Length -gt 0) "err=$($r.err)"
$r=Run "`$out=[System.IO.File]::OpenWrite('C:/Temp/ph1/x')`nfor(`$i=0;`$i -lt 1;`$i++){`n  `$cp=Join-Path 'C:\Temp\ph1' 'nope.b64'`n  if(-not(Test-Path -LiteralPath `$cp)){`$out.Close();throw `"Missing chunk: `$cp`"}`n}"; Check 'N5 missing-chunk-throw' ($r.err -match 'Missing chunk') "err=$($r.err)"

Remove-Item -Recurse -Force $dir -EA SilentlyContinue
"==== RESULT: pass=$pass fail=$fail ===="
