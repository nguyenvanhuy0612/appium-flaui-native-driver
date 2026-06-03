using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using FlaUI.Core.AutomationElements;

namespace FlaUiSidecar;

/// <summary>
/// RuntimeId → AutomationElement with FIFO eviction. Stale ids are reported to the caller, which maps
/// them to a W3C 'stale element reference'.
///
/// On eviction the underlying COM object is released (F7) so a long-running session that touches many
/// elements does not leak RCWs/native UIA handles. The cap is configurable (F5) via flaui:elementTableMax.
/// </summary>
public sealed class ElementRegistry
{
    private readonly int _max;
    private readonly ConcurrentDictionary<string, AutomationElement> _map = new();
    private readonly ConcurrentQueue<string> _order = new();

    public ElementRegistry(int max = 10_000) { _max = max > 0 ? max : 10_000; }

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
        {
            if (_map.TryRemove(oldest, out var evicted)) ReleaseCom(evicted);
        }
    }

    /// <summary>Release the COM wrapper backing an evicted element (best effort). FlaUI's
    /// AutomationElement wraps a native UIA pointer (UIA3FrameworkAutomationElement.NativeElement is an
    /// RCW); dropping the managed reference alone does not release the RCW promptly, so do it explicitly.
    /// The native member is UIA3-specific and not on the cross-backend base type, so reach it via
    /// reflection — this keeps the code compile-safe across UIA2/UIA3 and tolerant of FlaUI internals.</summary>
    private static void ReleaseCom(AutomationElement? el)
    {
        if (el is null) return;
        try
        {
            var fae = el.FrameworkAutomationElement;
            if (fae is null) return;
            var nativeProp = fae.GetType().GetProperty("NativeElement");
            var native = nativeProp?.GetValue(fae);
            if (native is not null && Marshal.IsComObject(native))
                Marshal.ReleaseComObject(native);
        }
        catch { /* best effort — never let cleanup throw into the op path */ }
    }
}
