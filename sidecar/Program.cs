using System.Linq;
using System.Text.Json;
using FlaUI.Core;
using FlaUI.UIA2;
using FlaUI.UIA3;
using FlaUiSidecar;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;

// ── FlaUI sidecar entry point ──────────────────────────────────────────────────────────────
// Minimal Kestrel host on loopback. Prints its port on stdout line 1 (handshake), serves the
// op API, and self-exits when the parent process goes away (stdin EOF heartbeat).
// AUTHORED ON macOS — requires Windows + FlaUI to build/run. See docs/NEXT-STEPS.md.

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls("http://127.0.0.1:0"); // OS-chosen free port, loopback only
var app = builder.Build();

var scheduler = new UiaScheduler();
var registry = new ElementRegistry();
AutomationBase? automation = null;
OpInterpreter? interp = null;
Application? launchedApp = null;   // set only when WE launched the app (not when attaching)
var attached = false;              // true when we attached to a PRE-EXISTING app/window — never close it on teardown
var shouldCloseApp = true;
var forceQuit = false;            // ms:forcequit — kill instead of graceful close (F10)
string? appPath = null;            // remembered for `windows: launchApp`
var opTimeout = TimeSpan.FromSeconds(30); // per-op watchdog (flaui:operationTimeout, F5)

// E — orphan guard: self-exit after this much inactivity, independent of the parent heartbeat. Bounds
// leaked sidecars when clients open sessions and never close them. Default 5 min; ≤0 disables. Set from
// flaui:idleTimeout at /session. lastActivity is bumped by Touch() on every /session and /op.
var idleTimeout = TimeSpan.FromMinutes(5);
var activityLock = new object();
var lastActivity = DateTime.UtcNow;
void Touch() { lock (activityLock) lastActivity = DateTime.UtcNow; }
// P0-2 — requests currently executing. The idle guard must NEVER self-exit while an op is in flight (a long
// op keeps lastActivity stale otherwise and the guard would kill the sidecar mid-op). Bumped around RunOp /
// RunPowerShell (which wrap every /session, /op and DELETE).
var inFlight = 0;

// Read an optional millisecond cap from the session caps.
static TimeSpan? Ms(JsonElement caps, string name) =>
    caps.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number
        ? TimeSpan.FromMilliseconds(v.GetDouble())
        : null;

app.MapGet("/status", () => Results.Json(new { ok = true, ready = true }));

app.MapPost("/session", async (HttpRequest req) =>
{
  Touch();
  // Body parse + setup are guarded so a malformed body / bad cap yields the {ok:false,error} envelope
  // rather than a raw Kestrel 500 (F18).
  JsonElement caps;
  try
  {
    using var doc = await JsonDocument.ParseAsync(req.Body);
    caps = doc.RootElement.Clone();
    var backend = caps.TryGetProperty("backend", out var b) ? b.GetString() : "uia3";
    automation = backend == "uia2" ? new UIA2Automation() : new UIA3Automation();
    // per-op watchdog (flaui:operationTimeout, F5). Read FIRST so the UIA timeouts can nest below it.
    opTimeout = Ms(caps, "operationTimeout") ?? TimeSpan.FromSeconds(30);
    // anti-hang layer 1 — UIA-level timeouts (flaui:connectionTimeout / flaui:transactionTimeout, F5).
    // D (nested timeouts): default these just BELOW the watchdog so a frozen provider's COM call
    // self-aborts and returns an error *before* the watchdog has to poison the STA worker (the graceful
    // path). Capped at 20s but always ≤ opTimeout-5s so the nesting holds even for a small operationTimeout.
    var uiaDefault = OpLogic.UiaDefault(opTimeout);
    automation.ConnectionTimeout = Ms(caps, "connectionTimeout") ?? uiaDefault;
    automation.TransactionTimeout = Ms(caps, "transactionTimeout") ?? uiaDefault;
    // E — orphan guard idle self-exit (flaui:idleTimeout, ms; ≤0 disables; default 5 min).
    idleTimeout = Ms(caps, "idleTimeout") ?? TimeSpan.FromMinutes(5);
    // element registry cap (flaui:elementTableMax, F5) — rebuild with the requested size.
    if (caps.TryGetProperty("elementTableMax", out var etm) && etm.ValueKind == JsonValueKind.Number)
        registry = new ElementRegistry(etm.GetInt32());
    interp = new OpInterpreter(automation, registry);
    shouldCloseApp = !caps.TryGetProperty("shouldCloseApp", out var sc) || sc.ValueKind != JsonValueKind.False;
    forceQuit = caps.TryGetProperty("forcequit", out var fq) && fq.ValueKind == JsonValueKind.True;
  }
  catch (JsonException ex) { return Err("invalid argument", $"malformed /session body: {ex.Message}"); }
  catch (Exception ex) { return Err("unknown error", ex.Message); }

    // How long to wait for the app's top-level window to surface (ms:waitForAppLaunch, min 10s).
    var rootWait = TimeSpan.FromSeconds(
        caps.TryGetProperty("waitForAppLaunch", out var wfa) && wfa.ValueKind == JsonValueKind.Number
            ? Math.Max(wfa.GetDouble(), 10) : 10);
    // Poll budget for an ATTACH target (appTopLevelWindow/processName/appName) to appear before we throw
    // "no … found" (ms:createSessionTimeout, default 60s). The 'app' launch path keeps using rootWait.
    var attachBudget = OpLogic.CreateSessionTimeout(
        caps.TryGetProperty("createSessionTimeout", out var cstEl) && cstEl.ValueKind == JsonValueKind.Number
            ? cstEl.GetDouble() : (double?)null);
    // P0-1 — /session setup runs far longer than a per-op: give the watchdog a budget that covers the full
    // attach poll + window-surface waits instead of the 30s per-op default (which would poison the worker on
    // a slow attach/launch). The TS RPC timeout (driver.ts) sits above this in turn.
    var setupTimeout = OpLogic.SessionSetupTimeout(attachBudget, rootWait);

    return await RunOp(() =>
    {
        FlaUI.Core.AutomationElements.AutomationElement root;
        var bringToFront = true; // foreground the app at session start (launch/attach); cleared for 'Root'.

        if (caps.TryGetProperty("appTopLevelWindow", out var h) && h.GetString() is { Length: > 0 } hex)
        {
            // Attach to an existing top-level window by HWND (hex, with or without 0x). Invalid hex is a
            // user error → InvalidArgumentException → W3C "invalid argument" (F17), not an opaque unknown error.
            if (!OpLogic.TryParseHwnd(hex, out var hwnd))
                throw new InvalidArgumentException($"appTopLevelWindow is not a valid hex HWND: '{hex}'");
            // Poll until the HWND resolves to a live element (it may not exist yet), up to the attach budget.
            root = PollForAttach(
                () => { try { var el = automation!.FromHandle(new IntPtr(hwnd)); _ = el.Properties.NativeWindowHandle.ValueOrDefault; return el; } catch { return null; } },
                attachBudget, $"no window found for appTopLevelWindow '{hex}'");
            attached = true;
        }
        else if (caps.TryGetProperty("processName", out var pnEl) && pnEl.GetString() is { Length: > 0 } processNameRaw)
        {
            // Attach by EXACT executable name (case-insensitive, trailing ".exe" optional). Prefer the newest
            // process that has a visible main window; root at its OUTERMOST window. Not launched → never close.
            // Tried BEFORE appName: an exact process identifier is deterministic, whereas an appName regex can
            // match several windows — prefer the precise identifier over the fuzzy pattern.
            var exe = OpLogic.NormalizeProcessName(processNameRaw);
            root = PollForAttach(
                () => { var pid = FindPidByProcessName(exe); return pid is int p ? ResolveAppRoot(p, rootWait) : null; },
                attachBudget, $"no running process matches processName '{processNameRaw}'");
            attached = true;
        }
        else if (caps.TryGetProperty("appName", out var anEl) && anEl.GetString() is { Length: > 0 } appNamePattern)
        {
            // Attach by WINDOW TITLE: appName is a case-insensitive, unanchored regex matched against each
            // top-level window's Name. Prefer a visible/foreground window, newest if several. Bad regex →
            // InvalidArgumentException ("invalid argument"). We did not launch it → never close it on teardown.
            var rx = OpLogic.CompileAppNameRegex(appNamePattern);
            root = PollForAttach(() => FindWindowByTitle(rx), attachBudget,
                $"no top-level window title matches appName '{appNamePattern}'");
            attached = true;
        }
        else if (caps.TryGetProperty("app", out var appEl) &&
                 string.Equals(appEl.GetString(), "Root", StringComparison.OrdinalIgnoreCase))
        {
            // Desktop session: the whole desktop tree is the root (the `app: 'Root'` mode).
            root = automation!.GetDesktop();
            bringToFront = false; // no single app window to foreground for a whole-desktop session
        }
        else
        {
            appPath = caps.GetProperty("app").GetString()!;
            // `app` = LAUNCH the application (open a new process). Attaching to a RUNNING app is the job of the
            // dedicated attach modes (processName / appName / appTopLevelWindow); `app` must NOT silently
            // attach to an existing instance (that broke multi-instance apps like Notepad). The ONE exception
            // is a single-instance app: a second launch is handed off to the running instance and the new
            // process exits without its own window — ResolveAppRoot fails fast once that PID is gone, so we
            // fall back to attaching the survivor. (Appium is flexible, not strict.)
            var psi = new System.Diagnostics.ProcessStartInfo(appPath)
            {
                Arguments = caps.TryGetProperty("appArguments", out var aa) ? aa.GetString() ?? string.Empty : string.Empty,
                WorkingDirectory = caps.TryGetProperty("appWorkingDir", out var wd) ? wd.GetString() ?? string.Empty : string.Empty,
                UseShellExecute = true,
            };
            launchedApp = Application.Launch(psi);
            try { root = ResolveAppRoot(launchedApp.ProcessId, rootWait); }
            catch
            {
                // Single-instance hand-off: the launched process exited without a window → attach the survivor.
                // The `app` cap means "manage this app's lifecycle", so we KEEP ownership (attach a handle,
                // leave `attached` = false) → it is still closed on teardown per shouldCloseApp, even though it
                // was already running. (Explicit attach modes — processName/appName/appTopLevelWindow — do NOT.)
                var alt = FindPidByExe(appPath) ?? throw new ArgumentException($"app launched but no window appeared for '{appPath}'");
                root = ResolveAppRoot(alt, rootWait);
                launchedApp = Application.Attach(alt); // owned → CloseOrKillLaunchedApp() closes it on teardown
            }
        }
        return interp!.OpenSession(root, bringToFront);
    }, setupTimeout);
});

app.MapDelete("/session", async () => await RunOp(() =>
{
    // ATTACHED sessions: we connected to a pre-existing app/window we did NOT start — never close or kill
    // it (FlaUI's Close()/Kill() terminate the process regardless of attach-vs-launch). Just let the
    // sidecar exit and release UIA refs. Only a session we actually LAUNCHED is closed per shouldCloseApp.
    if (!attached && shouldCloseApp)
    {
        if (launchedApp is not null) CloseOrKillLaunchedApp();
        else interp?.CloseRootWindow();
    }
    return new { done = true };
}));

// Close the app we launched. ms:forcequit (or a failed graceful close) escalates to Kill (F10).
void CloseOrKillLaunchedApp()
{
    if (launchedApp is null) return;
    var app = launchedApp;
    if (forceQuit) { try { app.Kill(); } catch { /* best effort */ } return; }
    // Graceful close, but BOUNDED: Application.Close() waits for the app to exit, so a "Save changes?"
    // confirm dialog or a wedged app would block teardown forever. A hang is NOT an exception, so the
    // catch alone cannot escalate — run Close() on a worker and force Kill() if it doesn't return in time.
    try
    {
        var closing = System.Threading.Tasks.Task.Run(() => { try { app.Close(); } catch { /* best effort */ } });
        if (!closing.Wait(TimeSpan.FromSeconds(5)))
        {
            try { app.Kill(); } catch { /* best effort */ }
        }
    }
    catch { try { app.Kill(); } catch { /* best effort */ } }
}

// ── App-root resolution (the "outermost window" selection) ────────────────────────────────────
// Root a session at the app's OUTERMOST window so owned/inner dialogs (UIA descendants of the owner)
// fall inside its subtree. We use the structural UIA signal (a top-level window is a DIRECT child of the
// desktop) rather than the CLR Process.MainWindowHandle heuristic, which can latch onto a modal child.
FlaUI.Core.AutomationElements.AutomationElement ResolveAppRoot(int pid, TimeSpan wait)
{
    var deadline = DateTime.UtcNow + wait;
    FlaUI.Core.AutomationElements.AutomationElement? modalOnly = null;
    while (true)
    {
        try { if (System.Diagnostics.Process.GetProcessById(pid).HasExited) break; }
        catch { break; } // process gone (e.g. single-instance launcher that handed off and exited)

        // Direct desktop children of this process == its true top-level windows (nested/owned dialogs are
        // descendants, so they are excluded here — exactly the root candidates we want).
        var tops = automation!.GetDesktop().FindAllChildren(cf =>
            cf.ByControlType(FlaUI.Core.Definitions.ControlType.Window).And(cf.ByProcessId(pid)));
        var nonModal = tops.Where(w => !IsModalSafe(w)).ToArray();
        if (nonModal.Length == 1) return nonModal[0];
        if (nonModal.Length > 1) return PickOutermost(nonModal, pid);
        if (tops.Length > 0) modalOnly ??= tops[0]; // only modal windows up so far — keep as a fallback
        if (DateTime.UtcNow >= deadline) break;
        System.Threading.Thread.Sleep(150);
    }
    if (modalOnly is not null) return modalOnly;
    // Last resort: the CLR main-window heuristic (validated only by being non-null).
    try { var w = Application.Attach(pid).GetMainWindow(automation!, TimeSpan.FromSeconds(2)); if (w is not null) return w; }
    catch { /* fall through */ }
    throw new ArgumentException($"no top-level window found for process {pid} — is the app showing a window on the interactive desktop?");
}

bool IsModalSafe(FlaUI.Core.AutomationElements.AutomationElement w)
{
    try { var p = w.Patterns.Window.PatternOrDefault; return p is not null && p.IsModal.ValueOrDefault; }
    catch { return false; }
}

// Disambiguate when a process has >1 non-modal top-level window: prefer the CLR main-window handle, else
// the most-populated window (the real frame, not an empty popup/host window).
FlaUI.Core.AutomationElements.AutomationElement PickOutermost(FlaUI.Core.AutomationElements.AutomationElement[] cands, int pid)
{
    try
    {
        var mainH = System.Diagnostics.Process.GetProcessById(pid).MainWindowHandle;
        if (mainH != IntPtr.Zero)
        {
            var match = cands.FirstOrDefault(w => HandleOf(w) == mainH.ToInt64());
            if (match is not null) return match;
        }
    }
    catch { /* ignore */ }
    return cands.OrderByDescending(ChildCountSafe).First();
}

long HandleOf(FlaUI.Core.AutomationElements.AutomationElement w)
{
    try { return w.Properties.NativeWindowHandle.ValueOrDefault.ToInt64(); } catch { return 0; }
}

int ChildCountSafe(FlaUI.Core.AutomationElements.AutomationElement w)
{
    try { return w.FindAllChildren().Length; } catch { return 0; }
}

// Newest running process whose executable matches a path/name (extension optional). Null if none.
int? FindPidByExe(string nameOrPath)
{
    var exe = System.IO.Path.GetFileNameWithoutExtension(nameOrPath);
    return FindPidByProcessName(exe);
}

// Pick a PID by EXACT process name (already normalized: no path, ".exe" stripped). Prefers the newest
// process (by StartTime) that has a visible main window; falls back to the newest overall, then any.
// Case-insensitivity is provided by Process.GetProcessesByName itself. Null if no such process.
int? FindPidByProcessName(string exe)
{
    if (string.IsNullOrEmpty(exe)) return null;
    var procs = System.Diagnostics.Process.GetProcessesByName(exe);
    if (procs.Length == 0) return null;
    System.Diagnostics.Process? bestVisible = null, bestAny = null;
    foreach (var p in procs)
    {
        try
        {
            if (bestAny is null || p.StartTime > bestAny.StartTime) bestAny = p;
            if (p.MainWindowHandle != IntPtr.Zero && (bestVisible is null || p.StartTime > bestVisible.StartTime))
                bestVisible = p;
        }
        catch { bestAny ??= p; }
    }
    return (bestVisible ?? bestAny)?.Id;
}

// Find a top-level window (desktop child Window/Pane) whose Name (title) matches the appName regex. Prefers
// a VISIBLE / foreground window, newest (highest native handle ≈ most-recently-created) if several match.
// Returns null when nothing matches yet (the caller polls). FlaUI-bound, so it stays in Program.cs.
FlaUI.Core.AutomationElements.AutomationElement? FindWindowByTitle(System.Text.RegularExpressions.Regex rx)
{
    FlaUI.Core.AutomationElements.AutomationElement[] tops;
    try
    {
        tops = automation!.GetDesktop().FindAllChildren(cf =>
            cf.ByControlType(FlaUI.Core.Definitions.ControlType.Window)
              .Or(cf.ByControlType(FlaUI.Core.Definitions.ControlType.Pane)));
    }
    catch { return null; }

    var matches = tops.Where(w => { try { return OpLogic.MatchesAppName(rx, w.Properties.Name.ValueOrDefault); } catch { return false; } }).ToArray();
    if (matches.Length == 0) return null;
    // Prefer the foreground window if it is among the matches; otherwise the newest visible; else the newest.
    var fg = Win32.GetForeground().ToInt64();
    var foreground = matches.FirstOrDefault(w => HandleOf(w) == fg && fg != 0);
    if (foreground is not null) return foreground;
    var visible = matches.Where(IsOffscreenSafe).ToArray();
    var pool = visible.Length > 0 ? visible : matches;
    return pool.OrderByDescending(HandleOf).First();
}

// True when a window is on-screen (NOT offscreen) per UIA — used to prefer visible appName matches.
bool IsOffscreenSafe(FlaUI.Core.AutomationElements.AutomationElement w)
{
    try { return !w.Properties.IsOffscreen.ValueOrDefault; } catch { return true; }
}

// Poll a resolver (returns the resolved root or null when the target isn't up yet) on a ~250ms interval up
// to the attach budget. Throws ArgumentException(notFoundMsg) → W3C "invalid selector" once the budget is
// spent and nothing surfaced. A budget of 0/negative still makes one attempt.
FlaUI.Core.AutomationElements.AutomationElement PollForAttach(
    Func<FlaUI.Core.AutomationElements.AutomationElement?> resolve, TimeSpan budget, string notFoundMsg)
{
    var deadline = DateTime.UtcNow + budget;
    while (true)
    {
        var hit = resolve();
        if (hit is not null) return hit;
        if (DateTime.UtcNow >= deadline) break;
        System.Threading.Thread.Sleep(250);
    }
    throw new ArgumentException(notFoundMsg);
}

app.MapPost("/op", async (HttpRequest req) =>
{
    Touch();
    // Guard the body parse + op-name extraction (F18): malformed JSON or a missing `op` field must map to
    // a clean W3C error envelope, never a raw 500.
    JsonElement op;
    string? kind;
    try
    {
        using var doc = await JsonDocument.ParseAsync(req.Body);
        op = doc.RootElement.Clone();
        if (op.ValueKind != JsonValueKind.Object || !op.TryGetProperty("op", out var kindEl))
            return Err("invalid argument", "request body is missing the 'op' field");
        kind = kindEl.GetString();
    }
    catch (JsonException ex) { return Err("invalid argument", $"malformed /op body: {ex.Message}"); }
    // PowerShell runs out-of-scheduler (no UIA involved; may legitimately run longer than the watchdog).
    if (kind == "powershell") return await RunPowerShell(op);
    return await RunOp(() => kind switch
    {
        "find" => interp!.Find(op),
        "attributes" => interp!.Attributes(op),
        "action" => interp!.Action(op),
        "source" => interp!.Source(op),
        "input" => interp!.Input(op),
        "screenshot" => interp!.Screenshot(op),
        "clipboard" => interp!.Clipboard(op),
        "file" => interp!.File(op),
        "walk" => interp!.Walk(op),
        "window" => interp!.Window(op),
        "app" => HandleApp(op),
        var o => throw new NotSupportedException($"op not implemented: {o}"),
    });
});

object HandleApp(JsonElement op)
{
    var action = op.GetProperty("action").GetString();
    switch (action)
    {
        case "launch":
        {
            if (string.IsNullOrEmpty(appPath)) throw new ArgumentException("no app was configured at session start");
            launchedApp = Application.Launch(appPath);
            var root = ResolveAppRoot(launchedApp.ProcessId, TimeSpan.FromSeconds(10));
            return interp!.OpenSession(root, true); // re-root + foreground the relaunched app (outermost window)
        }
        case "close":
            if (launchedApp is not null) CloseOrKillLaunchedApp();
            else interp?.CloseRootWindow();
            return new { done = true };
        case "activate":
        {
            var name = op.GetProperty("process").GetString()!;
            name = name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? name[..^4] : name;
            var proc = System.Diagnostics.Process.GetProcessesByName(name)
                           .FirstOrDefault(p => p.MainWindowHandle != IntPtr.Zero)
                       ?? throw new ArgumentException($"no process with a main window: {name}");
            automation!.FromHandle(proc.MainWindowHandle).Focus();
            return new { done = true };
        }
        default: throw new ArgumentException($"unsupported app action: {action}");
    }
}

// PowerShell child process, BOUNDED (F4): stdin write + stdout/stderr reads run concurrently to avoid the
// redirect-pipe deadlock (a child filling its stdout pipe blocks until the parent drains it); the whole
// thing is under a CancellationTokenSource so a runaway script is killed (entire process tree) and mapped
// to a W3C "timeout" error. Timeout = the per-call op.timeoutMs when present, else a 60s default.
async Task<IResult> RunPowerShell(JsonElement op)
{
    System.Threading.Interlocked.Increment(ref inFlight); // P0-2 — block idle self-exit while a script runs
    var timeout = op.TryGetProperty("timeoutMs", out var tm) && tm.ValueKind == JsonValueKind.Number
        ? TimeSpan.FromMilliseconds(tm.GetDouble())
        : TimeSpan.FromSeconds(60);
    using var cts = new CancellationTokenSource(timeout);
    System.Diagnostics.Process? p = null;
    try
    {
        var script = op.GetProperty("script").GetString()!;
        var psi = new System.Diagnostics.ProcessStartInfo("powershell.exe", "-NoProfile -NonInteractive -Command -")
        {
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        p = System.Diagnostics.Process.Start(psi)!;
        // Drain stdout/stderr CONCURRENTLY while writing stdin (deadlock-free).
        Task<string> outTask = p.StandardOutput.ReadToEndAsync(cts.Token);
        Task<string> errTask = p.StandardError.ReadToEndAsync(cts.Token);
        await p.StandardInput.WriteAsync(script.AsMemory(), cts.Token);
        p.StandardInput.Close();
        await p.WaitForExitAsync(cts.Token);
        var stdout = await outTask;
        var stderr = await errTask;
        return Results.Json(new { ok = true, value = new { stdout, stderr, exitCode = p.ExitCode } });
    }
    catch (OperationCanceledException)
    {
        try { p?.Kill(entireProcessTree: true); } catch { /* best effort */ }
        return Err("timeout", $"PowerShell command exceeded {timeout.TotalSeconds:0}s and was terminated.");
    }
    catch (Exception ex)
    {
        try { p?.Kill(entireProcessTree: true); } catch { /* best effort */ }
        return Err("unknown error", ex.Message);
    }
    finally { p?.Dispose(); System.Threading.Interlocked.Decrement(ref inFlight); Touch(); }
}

// Every UIA-touching op runs on the scheduler's dedicated worker, bounded by the watchdog (layer 2),
// and all exceptions are mapped to W3C error envelopes here.
// timeoutOverride lets the /session setup pass its own (longer) watchdog budget (P0-1); normal ops keep
// the per-op opTimeout. inFlight is bumped for the duration so the idle guard can't self-exit mid-op (P0-2),
// and Touch() runs at the END so the idle window restarts only once the op has actually finished.
async Task<IResult> RunOp(Func<object?> work, TimeSpan? timeoutOverride = null)
{
    System.Threading.Interlocked.Increment(ref inFlight);
    try
    {
        var value = await scheduler.RunAsync(_ => work(), timeoutOverride ?? opTimeout);
        return Results.Json(new { ok = true, value });
    }
    catch (TimeoutException ex) { return Err("timeout", ex.Message); }
    catch (SchedulerFatalException ex) { return Err("backend fatal", ex.Message); } // → TS transport-failure path (markDead / recycle), P1-4
    catch (StaleElementException ex) { return Err("stale element reference", ex.Message); }
    catch (ElementNotFoundException ex) { return Err("no such element", ex.Message); }
    catch (InvalidElementStateException ex) { return Err("invalid element state", ex.Message); } // W3C §12.5.2 (TS maps to InvalidElementStateError)
    catch (InvalidArgumentException ex) { return Err("invalid argument", ex.Message); }
    catch (ArgumentException ex) { return Err("invalid selector", ex.Message); }
    catch (Exception ex) { return Err("unknown error", ex.Message); }
    finally { System.Threading.Interlocked.Decrement(ref inFlight); Touch(); }
}
IResult Err(string type, string message) => Results.Json(new { ok = false, error = new { type, message } });

await app.StartAsync();
Console.WriteLine($"PORT={new Uri(app.Urls.First()).Port}");
Console.Out.Flush();

// Heartbeat: parent death (stdin EOF) => self-exit, no orphan process.
_ = Task.Run(async () =>
{
    using var stdin = Console.OpenStandardInput();
    var buf = new byte[1];
    try { while (await stdin.ReadAsync(buf) > 0) { } } catch { /* ignore */ }
    Environment.Exit(0);
});

// E — orphan guard: independent idle watcher. If no /session or /op arrives within idleTimeout, the
// sidecar self-exits so a leaked/forgotten session can't linger (~180MB) regardless of the parent's
// newCommandTimeout config. Best-effort closes an app WE launched (mirrors shouldCloseApp); never an
// attached app. The TS side sees the exit and fails the (now dead) session honestly on the next command.
_ = Task.Run(async () =>
{
    while (true)
    {
        await Task.Delay(TimeSpan.FromSeconds(15));
        if (idleTimeout <= TimeSpan.Zero) continue;
        TimeSpan idle;
        lock (activityLock) idle = DateTime.UtcNow - lastActivity;
        // P0-2 — never self-exit while an op is in flight, no matter how stale lastActivity looks.
        if (!OpLogic.ShouldSelfExit(System.Threading.Volatile.Read(ref inFlight), idle, idleTimeout)) continue;
        // Best-effort close, but it must NEVER gate the self-exit (the orphan guard exists precisely for a
        // wedged app). Bound the cleanup and self-exit regardless. (CloseOrKillLaunchedApp is itself bounded.)
        try { if (!attached && shouldCloseApp && launchedApp is not null) System.Threading.Tasks.Task.Run(CloseOrKillLaunchedApp).Wait(TimeSpan.FromSeconds(6)); }
        catch { /* best effort */ }
        Console.Error.WriteLine(
            $"[sidecar] idle {idle.TotalSeconds:0}s exceeded {idleTimeout.TotalSeconds:0}s — self-exit (orphan guard)");
        Environment.Exit(0);
    }
});

await app.WaitForShutdownAsync();
