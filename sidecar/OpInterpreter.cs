using System.Text.Json;
using FlaUI.Core;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Conditions;
using FlaUI.Core.Definitions;

namespace FlaUiSidecar;

/// <summary>
/// Maps structured JSON ops (the seam, ADR-003) to FlaUI calls. Skeleton supports `find` only;
/// attributes/action/source/input arrive in later phases.
/// AUTHORED ON macOS — requires Windows + FlaUI to build/run.
/// </summary>
public sealed class OpInterpreter
{
    private readonly AutomationBase _automation;
    private readonly ElementRegistry _registry;
    private AutomationElement? _root;

    public OpInterpreter(AutomationBase automation, ElementRegistry registry)
    {
        _automation = automation;
        _registry = registry;
    }

    public object OpenSession(AutomationElement root)
    {
        _root = root;
        return new { rootId = _registry.Register(root) };
    }

    public object Find(JsonElement op)
    {
        var startId = op.GetProperty("startId").GetString()!;
        var multiple = op.GetProperty("multiple").GetBoolean();
        var scope = ParseScope(op.GetProperty("scope").GetString()!);
        var start = startId == "root" ? _root! : ResolveOrThrow(startId);
        var cond = BuildCondition(op.GetProperty("condition"));

        if (multiple)
        {
            var els = start.FindAll(scope, cond);
            return new { elements = els.Select(Basic).ToArray() };
        }

        var found = start.FindFirst(scope, cond) ?? throw new ElementNotFoundException();
        return Basic(found);
        // Note: FlaUI 4.x has no ElementNotFoundException; FindFirst signals "not found" by returning
        // null. We raise a sidecar-local ElementNotFoundException (below) so Program.cs maps it to the
        // W3C "no such element" error envelope.
    }

    /// <summary>Bulk attribute fetch (Phase 2). `names` is an array, or "all".</summary>
    public object Attributes(JsonElement op)
    {
        var el = ResolveOrThrow(op.GetProperty("id").GetString()!);
        var namesEl = op.GetProperty("names");
        var dict = new Dictionary<string, object?>();
        if (namesEl.ValueKind == JsonValueKind.String && namesEl.GetString() == "all")
        {
            foreach (var n in AllAttributeNames) dict[n] = ReadAttribute(el, n);
        }
        else
        {
            foreach (var n in namesEl.EnumerateArray()) dict[n.GetString()!] = ReadAttribute(el, n.GetString()!);
        }
        return dict;
    }

    /// <summary>Element action via a UIA pattern. Write-style actions return {done:true}; read-style
    /// actions (getValue/isMultiple/selection/getAttributes) return their data.</summary>
    public object? Action(JsonElement op)
    {
        var el = ResolveOrThrow(op.GetProperty("id").GetString()!);
        var action = op.GetProperty("action").GetString();
        var args = op.TryGetProperty("args", out var a) ? a : default;
        switch (action)
        {
            // ── read-style ──
            case "getValue":
                return new { value = el.Patterns.Value.PatternOrDefault?.Value.ValueOrDefault };
            case "isMultiple":
                return new { value = el.Patterns.Selection.PatternOrDefault?.CanSelectMultiple.ValueOrDefault };
            case "selectedItem":
            {
                var sel = el.Patterns.Selection.PatternOrDefault?.Selection.ValueOrDefault;
                return sel is { Length: > 0 } ? Basic(sel[0]) : null;
            }
            case "allSelectedItems":
            {
                var sel = el.Patterns.Selection.PatternOrDefault?.Selection.ValueOrDefault
                          ?? Array.Empty<AutomationElement>();
                return new { elements = sel.Select(Basic).ToArray() };
            }
            case "getAttributes":
            {
                var dict = new Dictionary<string, object?>();
                foreach (var n in AllAttributeNames) dict[n] = ReadAttribute(el, n);
                return dict;
            }
            // ── write-style ──
            case "invoke": el.Patterns.Invoke.Pattern.Invoke(); break;
            case "toggle": el.Patterns.Toggle.Pattern.Toggle(); break;
            case "expand": el.Patterns.ExpandCollapse.Pattern.Expand(); break;
            case "collapse": el.Patterns.ExpandCollapse.Pattern.Collapse(); break;
            case "select": el.Patterns.SelectionItem.Pattern.Select(); break;
            case "addToSelection": el.Patterns.SelectionItem.Pattern.AddToSelection(); break;
            case "removeFromSelection": el.Patterns.SelectionItem.Pattern.RemoveFromSelection(); break;
            case "scrollIntoView": el.Patterns.ScrollItem.Pattern.ScrollIntoView(); break;
            case "setFocus": el.Focus(); break;
            case "setValue": el.Patterns.Value.Pattern.SetValue(args.GetProperty("value").GetString()); break;
            case "maximize": el.Patterns.Window.Pattern.SetWindowVisualState(WindowVisualState.Maximized); break;
            case "minimize": el.Patterns.Window.Pattern.SetWindowVisualState(WindowVisualState.Minimized); break;
            case "restore": el.Patterns.Window.Pattern.SetWindowVisualState(WindowVisualState.Normal); break;
            case "close": el.Patterns.Window.Pattern.Close(); break;
            default: throw new ArgumentException($"unsupported action: {action}");
        }
        return new { done = true };
    }

    /// <summary>Page source as XML, built in one CacheRequest pass (Phase 2). Schema must match nova2.</summary>
    public object Source(JsonElement op)
    {
        var startId = op.GetProperty("startId").GetString()!;
        var rawView = op.TryGetProperty("rawView", out var r) && r.GetBoolean();
        var start = startId == "root" ? _root! : ResolveOrThrow(startId);
        var xml = PageSourceBuilder.Build(_automation, start, rawView);
        return new { source = xml };
    }

    private object Basic(AutomationElement e)
    {
        _registry.Register(e);
        return new
        {
            runtimeId = string.Join('.', e.Properties.RuntimeId.Value),
            name = e.Properties.Name.ValueOrDefault,
            automationId = e.Properties.AutomationId.ValueOrDefault,
            className = e.Properties.ClassName.ValueOrDefault,
            controlType = e.Properties.ControlType.ValueOrDefault.ToString(),
        };
    }

    private AutomationElement ResolveOrThrow(string id) =>
        _registry.TryGet(id, out var el) && el is not null ? el : throw new StaleElementException(id);

    private ConditionBase BuildCondition(JsonElement c)
    {
        var cf = _automation.ConditionFactory;
        return c.GetProperty("kind").GetString() switch
        {
            // FlaUI 4.x exposes a singleton match-all condition via TrueCondition.Default
            // (the ctor is private). FlaUI.Core.Conditions.
            "true" => TrueCondition.Default,
            "property" => BuildProperty(cf, c),
            "and" => c.GetProperty("children").EnumerateArray().Select(BuildCondition)
                       .Aggregate((a, b) => a.And(b)),
            "or" => c.GetProperty("children").EnumerateArray().Select(BuildCondition)
                      .Aggregate((a, b) => a.Or(b)),
            "not" => BuildCondition(c.GetProperty("child")).Not(),
            var k => throw new ArgumentException($"unknown condition kind: {k}"),
        };
    }

    private static PropertyCondition BuildProperty(ConditionFactory cf, JsonElement c)
    {
        var prop = c.GetProperty("prop").GetString();
        var val = c.GetProperty("value");
        return prop switch
        {
            "AutomationId" => cf.ByAutomationId(val.GetString()!),
            "Name" => cf.ByName(val.GetString()!),
            "ClassName" => cf.ByClassName(val.GetString()!),
            "ControlType" => cf.ByControlType(Enum.Parse<ControlType>(val.GetString()!)),
            _ => throw new ArgumentException($"unsupported property: {prop}"),
        };
    }

    private static TreeScope ParseScope(string s) => s switch
    {
        "element" => TreeScope.Element,
        "children" => TreeScope.Children,
        "descendants" => TreeScope.Descendants,
        "subtree" => TreeScope.Subtree,
        _ => TreeScope.Descendants,
    };

    internal static readonly string[] AllAttributeNames =
    {
        "Name", "AutomationId", "ClassName", "ControlType", "LocalizedControlType",
        "RuntimeId", "IsEnabled", "IsOffscreen", "ProcessId", "FrameworkId", "HelpText",
    };

    /// <summary>Read a single attribute by its schema name. TODO (Windows pass): extend to pattern-specific
    /// attributes (e.g. Window.CanMaximize) and confirm property accessors.</summary>
    internal static object? ReadAttribute(AutomationElement el, string name) => name switch
    {
        "Name" => el.Properties.Name.ValueOrDefault,
        "AutomationId" => el.Properties.AutomationId.ValueOrDefault,
        "ClassName" => el.Properties.ClassName.ValueOrDefault,
        "ControlType" => el.Properties.ControlType.ValueOrDefault.ToString(),
        "LocalizedControlType" => el.Properties.LocalizedControlType.ValueOrDefault,
        "RuntimeId" => string.Join('.', el.Properties.RuntimeId.ValueOrDefault ?? Array.Empty<int>()),
        "IsEnabled" => el.Properties.IsEnabled.ValueOrDefault,
        "IsOffscreen" => el.Properties.IsOffscreen.ValueOrDefault,
        "ProcessId" => el.Properties.ProcessId.ValueOrDefault,
        "FrameworkId" => el.Properties.FrameworkId.ValueOrDefault,
        "HelpText" => el.Properties.HelpText.ValueOrDefault,
        // ValuePattern.Value — e.g. the text of an Edit control (lets getAttribute("Value") read it back).
        "Value" => el.Patterns.Value.PatternOrDefault?.Value.ValueOrDefault,
        // SelectionItemPattern.IsSelected — null when the pattern is unsupported (treated as false upstream).
        "IsSelected" => el.Patterns.SelectionItem.PatternOrDefault?.IsSelected.ValueOrDefault,
        // BoundingRectangle as a plain {x,y,width,height} object (used by W3C getElementRect).
        "BoundingRectangle" => RectOf(el),
        _ => throw new ArgumentException($"unknown attribute: {name}"),
    };

    private static object RectOf(AutomationElement el)
    {
        var r = el.Properties.BoundingRectangle.ValueOrDefault;
        return new { x = (int)r.X, y = (int)r.Y, width = (int)r.Width, height = (int)r.Height };
    }
}

public sealed class StaleElementException(string id) : Exception($"stale element: {id}");

/// <summary>Raised when a single-element find yields no match (FlaUI's FindFirst returned null).
/// Mapped to the W3C "no such element" error in Program.cs.</summary>
public sealed class ElementNotFoundException() : Exception("no such element matched the condition");
