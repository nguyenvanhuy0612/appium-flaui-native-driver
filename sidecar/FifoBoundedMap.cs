using System.Collections.Generic;

namespace FlaUiSidecar;

/// <summary>
/// A thread-safe, bounded key→value map with insertion-order (FIFO) eviction of the OLDEST entry once the
/// capacity is exceeded. Re-registering an existing key updates the value AND moves the key to the most-recent
/// position ("touch"), so a frequently-used (live) entry is never evicted while it is still in use — this is
/// the bug ElementRegistry had (a live element kept its oldest slot and could be evicted prematurely, causing
/// spurious stale-element errors in long sessions).
///
/// FlaUI-free on purpose so it can be unit-tested cross-platform. The optional <c>onEvict</c> callback lets a
/// caller release a resource (e.g. a COM wrapper) exactly once per eviction, on the thread that performs the
/// eviction, under the same lock the map uses.
/// </summary>
public sealed class FifoBoundedMap<TKey, TValue> where TKey : notnull
{
    private readonly int _max;
    private readonly Action<TValue>? _onEvict;
    private readonly object _lock = new();
    // Value + a node into the recency list, so an O(1) touch can move the key without rescanning.
    private readonly Dictionary<TKey, LinkedListNode<KeyValuePair<TKey, TValue>>> _map = new();
    private readonly LinkedList<KeyValuePair<TKey, TValue>> _order = new(); // First = oldest, Last = newest

    /// <param name="max">Capacity; values ≤ 0 fall back to 10000 (parity with ElementRegistry's default).</param>
    /// <param name="onEvict">Optional callback fired once per evicted value (best-effort: a throwing callback
    /// is swallowed so eviction never corrupts the map).</param>
    public FifoBoundedMap(int max = 10_000, Action<TValue>? onEvict = null)
    {
        _max = max > 0 ? max : 10_000;
        _onEvict = onEvict;
    }

    public int Capacity => _max;

    public int Count { get { lock (_lock) return _map.Count; } }

    /// <summary>Insert a new key (appended as newest) or update an existing key's value AND move it to the
    /// most-recent position (touch). Returns true if this call evicted at least one oldest entry.</summary>
    public bool Set(TKey key, TValue value)
    {
        List<TValue>? evicted = null;
        lock (_lock)
        {
            if (_map.TryGetValue(key, out var existing))
            {
                // Update value + touch: move to newest so re-touched (live) entries survive.
                _order.Remove(existing);
                var refreshed = _order.AddLast(new KeyValuePair<TKey, TValue>(key, value));
                _map[key] = refreshed;
            }
            else
            {
                var node = _order.AddLast(new KeyValuePair<TKey, TValue>(key, value));
                _map[key] = node;
                while (_map.Count > _max)
                {
                    var oldest = _order.First!;
                    _order.RemoveFirst();
                    _map.Remove(oldest.Value.Key);
                    (evicted ??= new List<TValue>()).Add(oldest.Value.Value);
                }
            }
        }
        if (evicted is not null && _onEvict is not null)
            foreach (var v in evicted)
                try { _onEvict(v); } catch { /* best effort — cleanup must never throw into the op path */ }
        return evicted is not null;
    }

    public bool TryGet(TKey key, out TValue? value)
    {
        lock (_lock)
        {
            if (_map.TryGetValue(key, out var node)) { value = node.Value.Value; return true; }
            value = default;
            return false;
        }
    }
}
