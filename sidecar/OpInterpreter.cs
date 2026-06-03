using System.Text.Json;
using FlaUI.Core;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Conditions;
using FlaUI.Core.Definitions;
using FlaUI.Core.Exceptions;

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
            // TODO (Windows pass): replace with FlaUI's real true-condition. FlaUI exposes
            // `new TrueCondition()` / ConditionFactory helpers — confirm the exact symbol on Windows.
            "true" => new TrueCondition(),
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
}

public sealed class StaleElementException(string id) : Exception($"stale element: {id}");
