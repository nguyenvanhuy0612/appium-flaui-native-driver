using System.Text;
using System.Xml;
using FlaUI.Core;
using FlaUI.Core.AutomationElements;

namespace FlaUiSidecar;

/// <summary>
/// Builds the page-source XML via iterative stack-based DFS (no recursion → safe on deep trees), producing
/// a correctly NESTED tree. Tag = ControlType leaf (matches nova2's ProgrammaticName leaf, e.g. "Button").
/// Attribute set mirrors nova2's schema: the full UIA element property list, x/y relative to the start
/// element, and pattern-specific attributes (Window / Transform) — so nova2 XPath/tests transfer.
///
/// Traversal and property reads are LIVE (one COM round-trip each): correct but O(props×nodes).
/// TODO (perf): single CacheRequest pass by re-fetching the start element UNDER the active cache.
/// TODO: rawView via a raw-view TreeWalker (currently control view only).
/// </summary>
public static class PageSourceBuilder
{
    public static string Build(AutomationBase automation, AutomationElement start, bool rawView)
    {
        var rootRect = SafeRect(start);
        var sb = new StringBuilder();
        using var writer = XmlWriter.Create(sb, new XmlWriterSettings { OmitXmlDeclaration = false, Indent = false });

        writer.WriteStartDocument();
        // A null marker on the stack means "write the matching end-tag for the element opened most recently".
        var stack = new Stack<AutomationElement?>();
        WriteNode(writer, start, rootRect);
        stack.Push(null);
        PushChildrenReversed(stack, start);

        while (stack.Count > 0)
        {
            var el = stack.Pop();
            if (el is null) { writer.WriteEndElement(); continue; }
            WriteNode(writer, el, rootRect);
            stack.Push(null);
            PushChildrenReversed(stack, el);
        }
        writer.WriteEndDocument();
        writer.Flush();
        return sb.ToString();
    }

    // Push children reversed so they pop in document (left-to-right) order. Live query (no cache).
    private static void PushChildrenReversed(Stack<AutomationElement?> stack, AutomationElement el)
    {
        AutomationElement[] children;
        try { children = el.FindAllChildren(); }
        catch { children = Array.Empty<AutomationElement>(); }
        for (var i = children.Length - 1; i >= 0; i--) stack.Push(children[i]);
    }

    private static void WriteNode(XmlWriter w, AutomationElement el, System.Drawing.Rectangle rootRect)
    {
        var p = el.Properties;
        var tag = Safe(() => (object?)p.ControlType.ValueOrDefault)?.ToString() ?? "Custom";
        w.WriteStartElement(tag);

        // nova2 attribute schema (element properties).
        WriteAttr(w, "AcceleratorKey", Safe(() => p.AcceleratorKey.ValueOrDefault));
        WriteAttr(w, "AccessKey", Safe(() => p.AccessKey.ValueOrDefault));
        WriteAttr(w, "AutomationId", Safe(() => p.AutomationId.ValueOrDefault));
        WriteAttr(w, "ClassName", Safe(() => p.ClassName.ValueOrDefault));
        WriteAttr(w, "ControlType", tag);
        WriteAttr(w, "FrameworkId", Safe(() => p.FrameworkId.ValueOrDefault));
        WriteAttr(w, "HasKeyboardFocus", Safe(() => (object?)p.HasKeyboardFocus.ValueOrDefault));
        WriteAttr(w, "HelpText", Safe(() => p.HelpText.ValueOrDefault));
        WriteAttr(w, "IsContentElement", Safe(() => (object?)p.IsContentElement.ValueOrDefault));
        WriteAttr(w, "IsControlElement", Safe(() => (object?)p.IsControlElement.ValueOrDefault));
        WriteAttr(w, "IsEnabled", Safe(() => (object?)p.IsEnabled.ValueOrDefault));
        WriteAttr(w, "IsKeyboardFocusable", Safe(() => (object?)p.IsKeyboardFocusable.ValueOrDefault));
        WriteAttr(w, "IsOffscreen", Safe(() => (object?)p.IsOffscreen.ValueOrDefault));
        WriteAttr(w, "IsPassword", Safe(() => (object?)p.IsPassword.ValueOrDefault));
        WriteAttr(w, "IsRequiredForForm", Safe(() => (object?)p.IsRequiredForForm.ValueOrDefault));
        WriteAttr(w, "ItemStatus", Safe(() => p.ItemStatus.ValueOrDefault));
        WriteAttr(w, "ItemType", Safe(() => p.ItemType.ValueOrDefault));
        WriteAttr(w, "LocalizedControlType", Safe(() => p.LocalizedControlType.ValueOrDefault));
        WriteAttr(w, "Name", Safe(() => p.Name.ValueOrDefault));
        WriteAttr(w, "Orientation", Safe(() => (object?)p.Orientation.ValueOrDefault));
        WriteAttr(w, "ProcessId", Safe(() => (object?)p.ProcessId.ValueOrDefault));
        WriteAttr(w, "RuntimeId", RuntimeIdOf(el));

        // Coordinates relative to the start element (nova2 convention).
        var r = SafeRect(el);
        WriteAttr(w, "x", r.X - rootRect.X);
        WriteAttr(w, "y", r.Y - rootRect.Y);
        WriteAttr(w, "width", r.Width);
        WriteAttr(w, "height", r.Height);

        // Pattern-specific attributes (only when the pattern is supported, as nova2 does).
        var win = SafePattern(() => el.Patterns.Window.PatternOrDefault);
        if (win is not null)
        {
            WriteAttr(w, "CanMaximize", Safe(() => (object?)win.CanMaximize.ValueOrDefault));
            WriteAttr(w, "CanMinimize", Safe(() => (object?)win.CanMinimize.ValueOrDefault));
            WriteAttr(w, "IsModal", Safe(() => (object?)win.IsModal.ValueOrDefault));
            WriteAttr(w, "WindowVisualState", Safe(() => (object?)win.WindowVisualState.ValueOrDefault));
        }
        var tf = SafePattern(() => el.Patterns.Transform.PatternOrDefault);
        if (tf is not null)
        {
            WriteAttr(w, "CanRotate", Safe(() => (object?)tf.CanRotate.ValueOrDefault));
            WriteAttr(w, "CanResize", Safe(() => (object?)tf.CanResize.ValueOrDefault));
            WriteAttr(w, "CanMove", Safe(() => (object?)tf.CanMove.ValueOrDefault));
        }
    }

    private static string RuntimeIdOf(AutomationElement el)
    {
        try { return string.Join('.', el.Properties.RuntimeId.ValueOrDefault ?? Array.Empty<int>()); }
        catch { return string.Empty; }
    }

    private static System.Drawing.Rectangle SafeRect(AutomationElement el)
    {
        try { return el.Properties.BoundingRectangle.ValueOrDefault; }
        catch { return default; }
    }

    private static object? Safe(Func<object?> f)
    {
        try { return f(); } catch { return null; }
    }

    private static T? SafePattern<T>(Func<T?> f) where T : class
    {
        try { return f(); } catch { return null; }
    }

    private static void WriteAttr(XmlWriter w, string name, object? value) =>
        w.WriteAttributeString(name, value?.ToString() ?? string.Empty);
}
