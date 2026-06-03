using System.Text;
using System.Xml;
using FlaUI.Core;
using FlaUI.Core.AutomationElements;

namespace FlaUiSidecar;

/// <summary>
/// Builds the page-source XML via iterative stack-based DFS (no recursion → safe on deep trees), producing
/// a correctly NESTED tree (XPath depends on nesting). The tag name is the ControlType leaf (e.g. "Button");
/// attributes follow the nova2 schema so existing XPath/tests transfer.
///
/// VERIFIED on Windows (Notepad). Traversal is LIVE (FindAllChildren + live property reads): correct but
/// one round-trip per node. TODO (perf): re-introduce a single CacheRequest pass by re-fetching the start
/// element UNDER the active cache (the earlier cache attempt failed because `start` was obtained outside the
/// cache, so `CachedChildren` threw). TODO (schema parity): tag from ControlType.ProgrammaticName, relative
/// x/y/width/height, pattern-specific attributes (CanMaximize/IsModal/WindowVisualState), and rawView via a
/// raw TreeWalker.
/// </summary>
public static class PageSourceBuilder
{
    public static string Build(AutomationBase automation, AutomationElement start, bool rawView)
    {
        var sb = new StringBuilder();
        using var writer = XmlWriter.Create(sb, new XmlWriterSettings { OmitXmlDeclaration = false, Indent = false });

        writer.WriteStartDocument();
        // A null marker on the stack means "write the matching end-tag for the element opened most recently".
        var stack = new Stack<AutomationElement?>();
        WriteNode(writer, start);
        stack.Push(null);
        PushChildrenReversed(stack, start);

        while (stack.Count > 0)
        {
            var el = stack.Pop();
            if (el is null) { writer.WriteEndElement(); continue; }
            WriteNode(writer, el);
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

    private static void WriteNode(XmlWriter w, AutomationElement el)
    {
        var ct = el.Properties.ControlType.ValueOrDefault;
        var tag = ct.ToString(); // programmatic-name leaf; refine to match nova2 later
        w.WriteStartElement(tag);
        WriteAttr(w, "Name", el.Properties.Name.ValueOrDefault);
        WriteAttr(w, "AutomationId", el.Properties.AutomationId.ValueOrDefault);
        WriteAttr(w, "ClassName", el.Properties.ClassName.ValueOrDefault);
        WriteAttr(w, "ControlType", ct.ToString());
        WriteAttr(w, "RuntimeId", string.Join('.', el.Properties.RuntimeId.ValueOrDefault ?? Array.Empty<int>()));
        WriteAttr(w, "IsEnabled", SafeBool(() => el.Properties.IsEnabled.ValueOrDefault));
        WriteAttr(w, "IsOffscreen", SafeBool(() => el.Properties.IsOffscreen.ValueOrDefault));
    }

    private static string SafeBool(Func<bool> f)
    {
        try { return f().ToString(); } catch { return string.Empty; }
    }

    private static void WriteAttr(XmlWriter w, string name, object? value) =>
        w.WriteAttributeString(name, value?.ToString() ?? string.Empty);
}
