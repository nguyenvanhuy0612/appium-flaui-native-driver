using FlaUiSidecar;
using Xunit;

public class UiaSchedulerTests
{
    [Fact]
    public async Task FastWork_ReturnsResult()
    {
        using var s = new UiaScheduler();
        var r = await s.RunAsync(_ => 42, TimeSpan.FromSeconds(5));
        Assert.Equal(42, r);
    }

    [Fact]
    public async Task HungWork_TimesOut_AndSchedulerStaysUsable()
    {
        using var s = new UiaScheduler();
        // A work item that ignores cancellation (simulates frozen COM).
        await Assert.ThrowsAsync<TimeoutException>(() =>
            s.RunAsync(_ => { Thread.Sleep(Timeout.Infinite); return null; }, TimeSpan.FromMilliseconds(300)));

        // After poisoning + replacement, the next op must still work (fail-fast + session survives).
        var r = await s.RunAsync(_ => "alive", TimeSpan.FromSeconds(5));
        Assert.Equal("alive", r);
        Assert.True(s.PoisonedThreadCount >= 1);
    }

    [Fact]
    public async Task CooperativeCancellation_StopsWork_WithoutPoisoning()
    {
        using var s = new UiaScheduler();
        // Work that DOES honor the token: it should not poison the worker.
        await Assert.ThrowsAsync<TimeoutException>(() =>
            s.RunAsync(token =>
            {
                var sw = System.Diagnostics.Stopwatch.StartNew();
                while (!token.IsCancellationRequested && sw.Elapsed < TimeSpan.FromSeconds(10))
                    Thread.Sleep(10);
                return null;
            }, TimeSpan.FromMilliseconds(300)));

        var r = await s.RunAsync(_ => "ok", TimeSpan.FromSeconds(5));
        Assert.Equal("ok", r);
        Assert.Equal(0, s.PoisonedThreadCount); // cooperative work => no thread abandoned
    }
}
