using System.Collections.Concurrent;

namespace FlaUiSidecar;

/// <summary>
/// Runs UIA work on a dedicated worker thread, one op at a time, each bounded by a wall-clock watchdog.
/// If a work item ignores cancellation (COM frozen), the thread is "poisoned": a fresh worker is spun up
/// and the frozen one is abandoned. The calling (RPC) thread is never blocked beyond the timeout.
///
/// This type is intentionally free of FlaUI/UIA dependencies so its stability logic can be unit-tested
/// cross-platform (see sidecar/tests/UiaSchedulerTests.cs). Real UIA hangs are exercised on Windows.
/// </summary>
public sealed class UiaScheduler : IDisposable
{
    private readonly BlockingCollection<WorkItem> _queue = new();
    private Thread _worker;
    private volatile bool _disposed;

    /// <summary>How many worker threads have been abandoned due to an unresponsive (frozen) work item.</summary>
    public int PoisonedThreadCount { get; private set; }

    public UiaScheduler() { _worker = StartWorker(); }

    private Thread StartWorker()
    {
        var t = new Thread(WorkerLoop) { IsBackground = true, Name = "uia-worker" };
        // UIA prefers STA. SetApartmentState is a no-op/throws on non-Windows, so guard it.
        if (OperatingSystem.IsWindows())
        {
            t.SetApartmentState(ApartmentState.STA);
        }
        t.Start();
        return t;
    }

    private void WorkerLoop()
    {
        foreach (var item in _queue.GetConsumingEnumerable())
        {
            if (item.Token.IsCancellationRequested) { item.Tcs.TrySetCanceled(); continue; }
            try { item.Tcs.TrySetResult(item.Work(item.Token)); }
            catch (Exception ex) { item.Tcs.TrySetException(ex); }
        }
    }

    /// <summary>
    /// Run work with a wall-clock timeout. On timeout: cancel, fail fast, and if the worker does not pick
    /// up the next item promptly, poison it and replace it.
    /// </summary>
    public async Task<object?> RunAsync(Func<CancellationToken, object?> work, TimeSpan timeout)
    {
        if (_disposed) throw new ObjectDisposedException(nameof(UiaScheduler));
        var cts = new CancellationTokenSource();
        var item = new WorkItem(work, cts.Token);
        _queue.Add(item);

        var completed = await Task.WhenAny(item.Tcs.Task, Task.Delay(timeout)).ConfigureAwait(false);
        if (completed != item.Tcs.Task)
        {
            cts.Cancel();                       // ask the work to stop (cooperative)
            // Probe: is the worker responsive? Enqueue a no-op with a short grace period.
            if (!await WorkerResponsiveAsync(TimeSpan.FromSeconds(2)).ConfigureAwait(false))
            {
                PoisonAndReplaceWorker();       // COM truly frozen — abandon the thread
            }
            throw new TimeoutException("UIA operation exceeded the watchdog timeout.");
        }
        return await item.Tcs.Task.ConfigureAwait(false);
    }

    private async Task<bool> WorkerResponsiveAsync(TimeSpan grace)
    {
        var probe = new WorkItem(_ => null, CancellationToken.None);
        _queue.Add(probe);
        var done = await Task.WhenAny(probe.Tcs.Task, Task.Delay(grace)).ConfigureAwait(false);
        return done == probe.Tcs.Task;
    }

    private void PoisonAndReplaceWorker()
    {
        PoisonedThreadCount++;
        // The old worker is left to die whenever its frozen COM call returns (or at process exit).
        // A fresh worker consumes from the same queue, so subsequent ops proceed.
        _worker = StartWorker();
    }

    public void Dispose() { _disposed = true; _queue.CompleteAdding(); }

    private sealed record WorkItem(Func<CancellationToken, object?> Work, CancellationToken Token)
    {
        public TaskCompletionSource<object?> Tcs { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
    }
}
