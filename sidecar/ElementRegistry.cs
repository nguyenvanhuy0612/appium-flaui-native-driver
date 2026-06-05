using System.Runtime.InteropServices;
using FlaUI.Core.AutomationElements;

namespace FlaUiSidecar;

/// <summary>
/// RuntimeId → AutomationElement with bounded, insertion-order eviction. Stale ids are reported to the
/// caller, which maps them to a W3C 'stale element reference'.
///
/// On eviction the underlying COM object is released (F7) so a long-running session that touches many
/// elements does not leak RCWs/native UIA handles. The cap is configurable (F5) via flaui:elementTableMax.
///
/// The bounded-FIFO mechanics (incl. the bug fix where re-registering a live id moves it to the most-recent
/// slot so it is not evicted prematurely) live in <see cref="FifoBoundedMap{TKey,TValue}"/>; this class
/// keeps the FlaUI-specific bits: deriving the RuntimeId key and releasing COM on eviction.
/// </summary>
public sealed class ElementRegistry
{
    private readonly FifoBoundedMap<string, AutomationElement> _map;

    public ElementRegistry(int max = 10_000)
    {
        _map = new FifoBoundedMap<string, AutomationElement>(max, ReleaseCom);
    }

    public string Register(AutomationElement el)
    {
        var id = string.Join('.', el.Properties.RuntimeId.Value);
        // Re-registering an existing id updates the value AND touches it (FifoBoundedMap), so a frequently
        // used element keeps a recent FIFO position and is not evicted while still live.
        _map.Set(id, el);
        return id;
    }

    public bool TryGet(string id, out AutomationElement? el) => _map.TryGet(id, out el);

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
