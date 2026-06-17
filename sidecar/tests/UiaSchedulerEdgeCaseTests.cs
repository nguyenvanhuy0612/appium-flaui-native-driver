using System;
using System.Threading;
using System.Threading.Tasks;
using FlaUiSidecar;
using Xunit;

namespace FlaUiSidecar.Tests;

/// <summary>
/// Additional coverage for <see cref="UiaScheduler"/> stability branches not exercised by the base suite:
/// disposed-guard, work-thrown-exception propagation, cooperative-cancel without poison, alternating
/// good/frozen ops, and recovery (a fresh worker serves ops after the previous one was poisoned).
/// Cross-platform (no real UIA); frozen COM is simulated with an uncancellable sleep.
/// </summary>
public class UiaSchedulerEdgeCaseTests
{
    [Fact]
    public async Task RunAsync_AfterDispose_ThrowsObjectDisposed()
    {
        var s = new UiaScheduler();
        s.Dispose();
        await Assert.ThrowsAsync<ObjectDisposedException>(() =>
            s.RunAsync(_ => 1, TimeSpan.FromSeconds(1)));
    }

    [Fact]
    public void Dispose_IsIdempotent()
    {
        var s = new UiaScheduler();
        s.Dispose();
        s.Dispose(); // must not throw
    }

    [Fact]
    public async Task WorkThatThrows_PropagatesTheException_NotTimeout()
    {
        using var s = new UiaScheduler();
        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            s.RunAsync(_ => throw new InvalidOperationException("op blew up"), TimeSpan.FromSeconds(5)));
        Assert.Equal("op blew up", ex.Message);
        // Scheduler stays usable after an op throws (the worker only fails the TCS, it doesn't die).
        Assert.Equal(7, await s.RunAsync(_ => 7, TimeSpan.FromSeconds(5)));
        Assert.Equal(0, s.PoisonedThreadCount); // a thrown op does NOT poison the worker
    }

    [Fact]
    public async Task WorkReturningNull_IsAValidResult()
    {
        using var s = new UiaScheduler();
        Assert.Null(await s.RunAsync(_ => null, TimeSpan.FromSeconds(5)));
    }

    [Fact]
    public async Task CooperativeCancel_DoesNotPoison_AndNextOpRunsOnSameGeneration()
    {
        using var s = new UiaScheduler();
        await Assert.ThrowsAsync<TimeoutException>(() =>
            s.RunAsync(token =>
            {
                var sw = System.Diagnostics.Stopwatch.StartNew();
                while (!token.IsCancellationRequested && sw.Elapsed < TimeSpan.FromSeconds(10))
                    Thread.Sleep(5);
                return null;
            }, TimeSpan.FromMilliseconds(250)));

        Assert.Equal(0, s.PoisonedThreadCount);
        // The same (un-poisoned) worker must keep serving — many quick ops in a row.
        for (var i = 0; i < 5; i++)
            Assert.Equal(i, await s.RunAsync(_ => (object?)i, TimeSpan.FromSeconds(5)));
        Assert.Equal(0, s.PoisonedThreadCount);
    }

    [Fact]
    public async Task FrozenOp_PoisonsOnce_ThenRecovers_AndGoodOpsRunAgain()
    {
        using var s = new UiaScheduler();
        await Assert.ThrowsAsync<TimeoutException>(() =>
            s.RunAsync(_ => { Thread.Sleep(Timeout.Infinite); return null; }, TimeSpan.FromMilliseconds(250)));
        Assert.Equal(1, s.PoisonedThreadCount);

        // The replacement worker serves a burst of ops without further poisoning.
        for (var i = 0; i < 10; i++)
            Assert.Equal("ok", await s.RunAsync(_ => "ok", TimeSpan.FromSeconds(5)));
        Assert.Equal(1, s.PoisonedThreadCount); // no additional poison from healthy ops
    }

    [Fact]
    public async Task AlternatingFrozenAndGood_PoisonCountTracksFrozenOpsBelowBudget()
    {
        using var s = new UiaScheduler();
        // Two frozen ops (each below the budget of 5) interleaved with good ops. Poison count must equal the
        // number of frozen ops, and good ops must keep succeeding throughout.
        for (var round = 1; round <= 2; round++)
        {
            await Assert.ThrowsAsync<TimeoutException>(() =>
                s.RunAsync(_ => { Thread.Sleep(Timeout.Infinite); return null; }, TimeSpan.FromMilliseconds(250)));
            Assert.Equal(round, s.PoisonedThreadCount);
            Assert.Equal("good", await s.RunAsync(_ => "good", TimeSpan.FromSeconds(5)));
        }
    }

    [Fact]
    public async Task PoisonBudget_ExactlyAtThreshold_SurfacesFatal()
    {
        // MaxPoisonedThreads is 5 (internal). The 5th poison must surface SchedulerFatalException; earlier
        // ones only time out. We assert the fatal arrives on exactly the 5th frozen op.
        using var s = new UiaScheduler();
        for (var i = 1; i <= 4; i++)
        {
            await Assert.ThrowsAsync<TimeoutException>(() =>
                s.RunAsync(_ => { Thread.Sleep(Timeout.Infinite); return null; }, TimeSpan.FromMilliseconds(150)));
            Assert.Equal(i, s.PoisonedThreadCount);
        }
        await Assert.ThrowsAsync<SchedulerFatalException>(() =>
            s.RunAsync(_ => { Thread.Sleep(Timeout.Infinite); return null; }, TimeSpan.FromMilliseconds(150)));
        Assert.Equal(5, s.PoisonedThreadCount);
    }

    [Fact]
    public void SchedulerFatalException_MessageMentionsCount()
    {
        var ex = new SchedulerFatalException(5);
        Assert.Contains("5", ex.Message);
        Assert.Contains("poisoned", ex.Message);
    }

    [Fact]
    public async Task TokenPassedToWork_IsCancelledOnTimeout()
    {
        using var s = new UiaScheduler();
        var observedCancel = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        await Assert.ThrowsAsync<TimeoutException>(() =>
            s.RunAsync(token =>
            {
                // Spin cooperatively until cancellation is observed, then record it.
                var sw = System.Diagnostics.Stopwatch.StartNew();
                while (!token.IsCancellationRequested && sw.Elapsed < TimeSpan.FromSeconds(5))
                    Thread.Sleep(5);
                observedCancel.TrySetResult(token.IsCancellationRequested);
                return null;
            }, TimeSpan.FromMilliseconds(200)));

        // The work's token must have been cancelled by the watchdog (cooperative cancel path).
        var wasCancelled = await observedCancel.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.True(wasCancelled);
    }
}
