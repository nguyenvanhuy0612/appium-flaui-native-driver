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
var shouldCloseApp = true;
var forceQuit = false;            // ms:forcequit — kill instead of graceful close (F10)
string? appPath = null;            // remembered for `windows: launchApp`
var opTimeout = TimeSpan.FromSeconds(30); // per-op watchdog (flaui:operationTimeout, F5)

// Read an optional millisecond cap from the session caps.
static TimeSpan? Ms(JsonElement caps, string name) =>
    caps.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number
        ? TimeSpan.FromMilliseconds(v.GetDouble())
        : null;

app.MapGet("/status", () => Results.Json(new { ok = true, ready = true }));

app.MapPost("/session", async (HttpRequest req) =>
{
  // Body parse + setup are guarded so a malformed body / bad cap yields the {ok:false,error} envelope
  // rather than a raw Kestrel 500 (F18).
  JsonElement caps;
  try
  {
    using var doc = await JsonDocument.ParseAsync(req.Body);
    caps = doc.RootElement.Clone();
    var backend = caps.TryGetProperty("backend", out var b) ? b.GetString() : "uia3";
    automation = backend == "uia2" ? new UIA2Automation() : new UIA3Automation();
    // anti-hang layer 1 — UIA-level timeouts (flaui:connectionTimeout / flaui:transactionTimeout, F5).
    automation.ConnectionTimeout = Ms(caps, "connectionTimeout") ?? TimeSpan.FromSeconds(60);
    automation.TransactionTimeout = Ms(caps, "transactionTimeout") ?? TimeSpan.FromSeconds(60);
    // per-op watchdog (flaui:operationTimeout, F5).
    opTimeout = Ms(caps, "operationTimeout") ?? TimeSpan.FromSeconds(30);
    // element registry cap (flaui:elementTableMax, F5) — rebuild with the requested size.
    if (caps.TryGetProperty("elementTableMax", out var etm) && etm.ValueKind == JsonValueKind.Number)
        registry = new ElementRegistry(etm.GetInt32());
    interp = new OpInterpreter(automation, registry);
    shouldCloseApp = !caps.TryGetProperty("shouldCloseApp", out var sc) || sc.ValueKind != JsonValueKind.False;
    forceQuit = caps.TryGetProperty("forcequit", out var fq) && fq.ValueKind == JsonValueKind.True;
  }
  catch (JsonException ex) { return Err("invalid argument", $"malformed /session body: {ex.Message}"); }
  catch (Exception ex) { return Err("unknown error", ex.Message); }

    return await RunOp(() =>
    {
        FlaUI.Core.AutomationElements.AutomationElement root;
        if (caps.TryGetProperty("appTopLevelWindow", out var h) && h.GetString() is { Length: > 0 } hex)
        {
            // Attach to an existing top-level window by HWND (hex, with or without 0x). Invalid hex is a
            // user error → ArgumentException → W3C "invalid argument" (F17), not an opaque unknown error.
            var raw = hex.StartsWith("0x", StringComparison.OrdinalIgnoreCase) ? hex[2..] : hex;
            if (!long.TryParse(raw, System.Globalization.NumberStyles.HexNumber,
                    System.Globalization.CultureInfo.InvariantCulture, out var hwnd))
                throw new InvalidArgumentException($"appTopLevelWindow is not a valid hex HWND: '{hex}'");
            root = automation!.FromHandle(new IntPtr(hwnd));
        }
        else if (caps.TryGetProperty("app", out var appEl) &&
                 string.Equals(appEl.GetString(), "Root", StringComparison.OrdinalIgnoreCase))
        {
            // Desktop session: the whole desktop tree is the root (nova2's `app: 'Root'`).
            root = automation!.GetDesktop();
        }
        else
        {
            appPath = caps.GetProperty("app").GetString()!;
            var psi = new System.Diagnostics.ProcessStartInfo(appPath)
            {
                Arguments = caps.TryGetProperty("appArguments", out var aa) ? aa.GetString() ?? string.Empty : string.Empty,
                WorkingDirectory = caps.TryGetProperty("appWorkingDir", out var wd) ? wd.GetString() ?? string.Empty : string.Empty,
                UseShellExecute = true,
            };
            launchedApp = Application.Launch(psi);
            root = launchedApp.GetMainWindow(automation!);
        }
        return interp!.OpenSession(root);
    });
});

app.MapDelete("/session", async () => await RunOp(() =>
{
    if (shouldCloseApp)
    {
        if (launchedApp is not null) CloseOrKillLaunchedApp();
        else interp?.CloseRootWindow();   // attached session: close via WindowPattern
    }
    return new { done = true };
}));

// Close the app we launched. ms:forcequit (or a failed graceful close) escalates to Kill (F10).
void CloseOrKillLaunchedApp()
{
    if (launchedApp is null) return;
    if (forceQuit) { try { launchedApp.Kill(); } catch { /* best effort */ } return; }
    try { launchedApp.Close(); }
    catch { try { launchedApp.Kill(); } catch { /* best effort */ } }
}

app.MapPost("/op", async (HttpRequest req) =>
{
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
            var root = launchedApp.GetMainWindow(automation!);
            return interp!.OpenSession(root); // re-root the session on the relaunched app
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
// to a W3C "timeout" error. Timeout = op.timeoutMs (flaui powerShellCommandTimeout) or 60s default.
async Task<IResult> RunPowerShell(JsonElement op)
{
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
    finally { p?.Dispose(); }
}

// Every UIA-touching op runs on the scheduler's dedicated worker, bounded by the watchdog (layer 2),
// and all exceptions are mapped to W3C error envelopes here.
async Task<IResult> RunOp(Func<object?> work)
{
    try
    {
        var value = await scheduler.RunAsync(_ => work(), opTimeout);
        return Results.Json(new { ok = true, value });
    }
    catch (TimeoutException ex) { return Err("timeout", ex.Message); }
    catch (SchedulerFatalException ex) { return Err("unknown error", ex.Message); } // → TS layer-5 recycle
    catch (StaleElementException ex) { return Err("stale element reference", ex.Message); }
    catch (ElementNotFoundException ex) { return Err("no such element", ex.Message); }
    catch (InvalidArgumentException ex) { return Err("invalid argument", ex.Message); }
    catch (ArgumentException ex) { return Err("invalid selector", ex.Message); }
    catch (Exception ex) { return Err("unknown error", ex.Message); }
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

await app.WaitForShutdownAsync();
