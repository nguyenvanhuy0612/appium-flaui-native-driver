using System.Collections.Concurrent;

namespace FlaUiSidecar;

/// <summary>
/// Runs UIA work on a dedicated worker thread, one op at a time, each bounded by a wall-clock watchdog.
/// If a work item ignores cancellation (COM frozen), the thread is "poisoned": a fresh worker is spun up
/// and the frozen one is abandoned. The calling (RPC) thread is never blocked beyond the timeout.
///
/// Concurrency (F3): the design is ONE op at a time. Kestrel may dispatch overlapping requests, so
/// RunAsync is serialized with a SemaphoreSlim(1,1) — the enqueue→await for a given op completes (or
/// times out) before the next op is admitted. Poison-count increment and worker replacement are done
/// under a lock so they are atomic. Unbounded poison growth is treated as fatal: past a small threshold
/// we surface a SchedulerFatalException so the layer-5 recycle path replaces the whole sidecar.
///
/// This type is intentionally free of FlaUI/UIA dependencies so its stability logic can be unit-tested
/// cross-platform (see sidecar/tests/UiaSchedulerTests.cs). Real UIA hangs are exercised on Windows.
/// </summary>
public sealed class UiaScheduler : IDisposable
{
    /// <summary>Abandoned-thread budget before we declare the scheduler unrecoverable.</summary>
    private const int MaxPoisonedThreads = 5;

    private readonly BlockingCollection<WorkItem> _queue = new();
    private readonly SemaphoreSlim _gate = new(1, 1);   // serializes in-flight ops (F3)
    private readonly object _workerLock = new();        // guards _worker + _poisonedThreadCount
    private Thread _worker;
    private int _poisonedThreadCount;
    private volatile bool _disposed;

    /// <summary>How many worker threads have been abandoned due to an unresponsive (frozen) work item.</summary>
    public int PoisonedThreadCount
    {
        get { lock (_workerLock) return _poisonedThreadCount; }
    }

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
    /// Run work with a wall-clock timeout, serialized so only one op runs at a time. On timeout: cancel,
    /// fail fast, and if the worker does not pick up the next item promptly, poison it and replace it.
    /// </summary>
    public async Task<object?> RunAsync(Func<CancellationToken, object?> work, TimeSpan timeout)
    {
        if (_disposed) throw new ObjectDisposedException(nameof(UiaScheduler));
        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            using var cts = new CancellationTokenSource();
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
        finally
        {
            _gate.Release();
        }
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
        int count;
        lock (_workerLock)
        {
            count = ++_poisonedThreadCount;
            // The old worker is left to die whenever its frozen COM call returns (or at process exit).
            // A fresh worker consumes from the same queue, so subsequent ops proceed.
            _worker = StartWorker();
        }
        // Bound poisoned-thread growth: too many abandoned STA threads means the host is unhealthy.
        // Surface a fatal signal so the TS layer-5 circuit breaker recycles the whole sidecar.
        if (count >= MaxPoisonedThreads)
            throw new SchedulerFatalException(count);
    }

    public void Dispose()
    {
        _disposed = true;
        _queue.CompleteAdding();
        _gate.Dispose();
    }

    private sealed record WorkItem(Func<CancellationToken, object?> Work, CancellationToken Token)
    {
        public TaskCompletionSource<object?> Tcs { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
    }
}

/// <summary>Raised when abandoned (poisoned) worker threads exceed the budget — the scheduler can no
/// longer be trusted and the sidecar should be recycled (anti-hang layer 5).</summary>
public sealed class SchedulerFatalException(int poisonedThreads)
    : Exception($"UIA scheduler unrecoverable: {poisonedThreads} poisoned worker threads");
