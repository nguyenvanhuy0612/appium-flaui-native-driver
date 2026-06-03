using System.Text;
using System.Xml;
using FlaUI.Core;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Conditions;
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
            // FlaUI 4.x: the property is TreeFilter (ConditionBase) and the match-all condition is the
            // TrueCondition.Default singleton. Both views currently include all elements; a faithful
            // control-view filter for the non-raw case is a later (schema-parity) refinement.
            TreeFilter = TrueCondition.Default,
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
            // Stack-based DFS produces a correctly NESTED tree (XPath depends on nesting). Each frame is
            // an element whose start-tag has already been written; a null marker means "write the matching
            // end-tag for the most recently opened element". No recursion → safe on deep trees.
            writer.WriteStartDocument();
            var stack = new Stack<AutomationElement?>();
            WriteNode(writer, start);
            stack.Push(null); // closes <start>
            PushChildrenReversed(stack, start);

            while (stack.Count > 0)
            {
                var el = stack.Pop();
                if (el is null) { writer.WriteEndElement(); continue; }
                WriteNode(writer, el);
                stack.Push(null); // closes this element after its subtree
                PushChildrenReversed(stack, el);
            }
            writer.WriteEndDocument();
        }

        writer.Flush();
        return sb.ToString();
    }

    // Push children in reverse so they pop in document order (preserving left-to-right sibling order).
    private static void PushChildrenReversed(Stack<AutomationElement?> stack, AutomationElement el)
    {
        var children = el.CachedChildren;
        for (var i = children.Length - 1; i >= 0; i--) stack.Push(children[i]);
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
