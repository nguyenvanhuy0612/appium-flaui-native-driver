using System.Collections.Concurrent;
using FlaUI.Core.AutomationElements;

namespace FlaUiSidecar;

/// <summary>
/// RuntimeId → AutomationElement with FIFO eviction. Stale ids are reported to the caller, which maps
/// them to a W3C 'stale element reference'.
///
/// TODO (csharp-sidecar-engineer, Windows pass): extract the eviction/ordering logic to accept a plain
/// (string id, object element) pair so it can be unit-tested without FlaUI types. See the plan,
/// Task 1.5 / ElementRegistryTests note.
/// </summary>
public sealed class ElementRegistry
{
    private readonly int _max;
    private readonly ConcurrentDictionary<string, AutomationElement> _map = new();
    private readonly ConcurrentQueue<string> _order = new();

    public ElementRegistry(int max = 10_000) { _max = max; }

    public string Register(AutomationElement el)
    {
        var id = string.Join('.', el.Properties.RuntimeId.Value);
        if (_map.TryAdd(id, el)) { _order.Enqueue(id); EvictIfNeeded(); }
        else { _map[id] = el; }
        return id;
    }

    public bool TryGet(string id, out AutomationElement? el) => _map.TryGetValue(id, out el);

    private void EvictIfNeeded()
    {
        while (_map.Count > _max && _order.TryDequeue(out var oldest))
            _map.TryRemove(oldest, out _);
    }
}
