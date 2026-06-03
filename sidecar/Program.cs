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

app.MapGet("/status", () => Results.Json(new { ok = true, ready = true }));

app.MapPost("/session", async (HttpRequest req) =>
{
    using var doc = await JsonDocument.ParseAsync(req.Body);
    var caps = doc.RootElement.Clone();
    var backend = caps.TryGetProperty("backend", out var b) ? b.GetString() : "uia3";
    automation = backend == "uia2" ? new UIA2Automation() : new UIA3Automation();
    automation.ConnectionTimeout = TimeSpan.FromSeconds(60);   // anti-hang layer 1
    automation.TransactionTimeout = TimeSpan.FromSeconds(60);
    interp = new OpInterpreter(automation, registry);
    shouldCloseApp = !caps.TryGetProperty("shouldCloseApp", out var sc) || sc.ValueKind != JsonValueKind.False;

    return await RunOp(() =>
    {
        FlaUI.Core.AutomationElements.AutomationElement root;
        if (caps.TryGetProperty("appTopLevelWindow", out var h) && h.GetString() is { Length: > 0 } hex)
        {
            // Attach to an existing top-level window by HWND (hex, with or without 0x).
            var hwnd = Convert.ToInt64(hex.StartsWith("0x", StringComparison.OrdinalIgnoreCase) ? hex[2..] : hex, 16);
            root = automation!.FromHandle(new IntPtr(hwnd));
        }
        else
        {
            var appPath = caps.GetProperty("app").GetString()!;
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
        if (launchedApp is not null) { try { launchedApp.Close(); } catch { /* best effort */ } }
        else interp?.CloseRootWindow();   // attached session: close via WindowPattern
    }
    return new { done = true };
}));

app.MapPost("/op", async (HttpRequest req) =>
{
    using var doc = await JsonDocument.ParseAsync(req.Body);
    var op = doc.RootElement.Clone();
    return await RunOp(() => op.GetProperty("op").GetString() switch
    {
        "find" => interp!.Find(op),
        "attributes" => interp!.Attributes(op),
        "action" => interp!.Action(op),
        "source" => interp!.Source(op),
        "input" => interp!.Input(op),
        var o => throw new NotSupportedException($"op not implemented: {o}"),
    });
});

// Every UIA-touching op runs on the scheduler's dedicated worker, bounded by the watchdog (layer 2),
// and all exceptions are mapped to W3C error envelopes here.
async Task<IResult> RunOp(Func<object?> work)
{
    try
    {
        var value = await scheduler.RunAsync(_ => work(), TimeSpan.FromSeconds(30));
        return Results.Json(new { ok = true, value });
    }
    catch (TimeoutException ex) { return Err("timeout", ex.Message); }
    catch (StaleElementException ex) { return Err("stale element reference", ex.Message); }
    catch (ElementNotFoundException ex) { return Err("no such element", ex.Message); }
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
