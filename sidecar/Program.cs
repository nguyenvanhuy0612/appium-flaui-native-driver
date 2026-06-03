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

app.MapGet("/status", () => Results.Json(new { ok = true, ready = true }));

app.MapPost("/session", async (HttpRequest req) =>
{
    using var doc = await JsonDocument.ParseAsync(req.Body);
    var caps = doc.RootElement;
    var backend = caps.TryGetProperty("backend", out var b) ? b.GetString() : "uia3";
    automation = backend == "uia2" ? new UIA2Automation() : new UIA3Automation();
    automation.ConnectionTimeout = TimeSpan.FromSeconds(60);   // anti-hang layer 1
    automation.TransactionTimeout = TimeSpan.FromSeconds(60);
    interp = new OpInterpreter(automation, registry);

    var appPath = caps.GetProperty("app").GetString()!;
    return await RunOp(() =>
    {
        var launched = Application.Launch(appPath);
        var root = launched.GetMainWindow(automation!);
        return interp!.OpenSession(root);
    });
});

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
