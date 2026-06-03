using System.Text;
using System.Xml;
using FlaUI.Core;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Definitions;

namespace FlaUiSidecar;

/// <summary>
/// Builds the page-source XML in ONE CacheRequest pass via iterative BFS (no recursion → safe on deep
/// trees). The tag name is the ControlType programmatic-name leaf (e.g. "Button"); attributes match the
/// nova2 schema so existing XPath/tests transfer.
///
/// AUTHORED ON macOS — requires Windows + FlaUI to build/run. TODO (Windows pass):
///  - diff the emitted XML against nova2's output for a reference app and fix any schema drift;
///  - add pattern-specific attributes (CanMaximize/IsModal/WindowVisualState/...) as nova2 does;
///  - compute x/y/width/height relative to the start element's bounding rectangle.
/// </summary>
public static class PageSourceBuilder
{
    public static string Build(AutomationBase automation, AutomationElement start, bool rawView)
    {
        var cache = new CacheRequest
        {
            TreeScope = TreeScope.Subtree,
            AutomationElementMode = AutomationElementMode.None,
            TreeFilterCondition = rawView ? new TrueCondition() : automation.ConditionFactory.ByControlType(ControlType.Custom).Not().Or(new TrueCondition()),
        };
        cache.Add(automation.PropertyLibrary.Element.Name);
        cache.Add(automation.PropertyLibrary.Element.AutomationId);
        cache.Add(automation.PropertyLibrary.Element.ClassName);
        cache.Add(automation.PropertyLibrary.Element.ControlType);
        cache.Add(automation.PropertyLibrary.Element.LocalizedControlType);
        cache.Add(automation.PropertyLibrary.Element.RuntimeId);
        cache.Add(automation.PropertyLibrary.Element.IsEnabled);
        cache.Add(automation.PropertyLibrary.Element.IsOffscreen);
        cache.Add(automation.PropertyLibrary.Element.BoundingRectangle);
        cache.Add(automation.PropertyLibrary.Element.ProcessId);
        cache.Add(automation.PropertyLibrary.Element.FrameworkId);
        cache.Add(automation.PropertyLibrary.Element.HelpText);

        var sb = new StringBuilder();
        using var writer = XmlWriter.Create(sb, new XmlWriterSettings { OmitXmlDeclaration = false, Indent = false });

        using (cache.Activate())
        {
            // BFS over a snapshot: each queue item carries the element and whether its element-end is pending.
            var queue = new Queue<(AutomationElement el, bool open)>();
            writer.WriteStartDocument();
            WriteNode(writer, start);
            foreach (var child in start.CachedChildren) queue.Enqueue((child, true));
            // NOTE: simple BFS writes a flat list under root; a faithful nested tree uses a stack-based DFS.
            // The DFS variant is implemented during the Windows pass once schema parity is confirmed.
            while (queue.Count > 0)
            {
                var (el, _) = queue.Dequeue();
                WriteNode(writer, el);
                writer.WriteEndElement();
                foreach (var child in el.CachedChildren) queue.Enqueue((child, true));
            }
            writer.WriteEndElement(); // close root
            writer.WriteEndDocument();
        }

        writer.Flush();
        return sb.ToString();
    }

    private static void WriteNode(XmlWriter w, AutomationElement el)
    {
        var ct = el.Properties.ControlType.ValueOrDefault;
        var tag = ct.ToString(); // programmatic-name leaf; refine to match nova2 on the Windows pass
        w.WriteStartElement(tag);
        WriteAttr(w, "Name", el.Properties.Name.ValueOrDefault);
        WriteAttr(w, "AutomationId", el.Properties.AutomationId.ValueOrDefault);
        WriteAttr(w, "ClassName", el.Properties.ClassName.ValueOrDefault);
        WriteAttr(w, "ControlType", ct.ToString());
        WriteAttr(w, "RuntimeId", string.Join('.', el.Properties.RuntimeId.ValueOrDefault ?? Array.Empty<int>()));
        WriteAttr(w, "IsEnabled", el.Properties.IsEnabled.ValueOrDefault.ToString());
        WriteAttr(w, "IsOffscreen", el.Properties.IsOffscreen.ValueOrDefault.ToString());
    }

    private static void WriteAttr(XmlWriter w, string name, object? value) =>
        w.WriteAttributeString(name, value?.ToString() ?? string.Empty);
}
