using System.Reflection;
using FlaUI.Core;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Identifiers;
using FlaUI.Core.Patterns;
using FlaUI.Core.Tools;
using FlaUI.Core.WindowsAPI;

namespace FlaUiSidecar;

/// <summary>
/// FlaUI-idiomatic property/attribute resolver (Phase A). One entry point — <see cref="Resolve"/> — that
/// the W3C getAttribute/getProperty/getAttributes paths route through. Resolves, for any requested name:
///   1. Direct UIA element properties (Name, BoundingRectangle, ProviderDescription, IsDialog, …)
///   2. Is&lt;Pattern&gt;PatternAvailable flags, derived generically from FlaUI's pattern table
///      (PatternId.AvailabilityProperty.Name IS the inspect flag name — no hand-maintained list).
///   3. LegacyIAccessible.&lt;Prop&gt; (+ `legacy*` shorthand aliases) with inspect-style Role/State text,
///      plus a UIA-empty → LegacyIAccessible fallback for Name/Value.
///   4. Pattern dot-notation &lt;Pattern&gt;.&lt;Prop&gt; (Value.Value, Toggle.ToggleState, Window.CanMaximize,
///      RangeValue.Value, ExpandCollapse.ExpandCollapseState, Scroll.*, Selection.*, Grid.RowCount, …) via
///      reflection over el.Patterns.&lt;Pattern&gt;.PatternOrDefault then the typed AutomationProperty.
///
/// Value-format policy (see DECISIONS / report): the resolver returns native CLR values (bool, int, string,
/// enum) wherever it can; the JSON layer serialises them faithfully. Two families are stringified to match
/// inspect.exe exactly because their text form IS the property's value:
///   • LegacyIAccessible.Role / .State → "push button (0x2B)" / "focusable (0x100000)" (Oleacc text + hex).
///   • BoundingRectangle → structured {x,y,width,height} (fixes the old "[object Object]" coercion bug).
/// Booleans stay native here; the TS getAttribute() coerces to String() per W3C, while the page-source /
/// "all" dump renders bools as True/False (PageSourceBuilder already does, unchanged).
///
/// AUTHORED ON macOS — FlaUI calls require Windows to build/run. The pure helpers (name lists, hex/flag
/// formatting) are FlaUI-free and unit-tested cross-platform via PropertyResolverLogic.
/// </summary>
public static class PropertyResolver
{
    /// <summary>Resolve a single requested attribute/property name to a value (or null when not applicable).
    /// Never throws for a plausible UIA property / pattern / legacy name — returns null instead, so the W3C
    /// layer answers 200+null rather than 400. Throws ArgumentException only for genuinely malformed input.</summary>
    public static object? Resolve(AutomationElement el, AutomationBase automation, string name)
    {
        if (string.IsNullOrWhiteSpace(name))
            throw new ArgumentException("empty attribute name");

        // 1. Is<Pattern>PatternAvailable flags (generic, from the framework's pattern table).
        if (PropertyResolverLogic.LooksLikePatternAvailabilityFlag(name))
            return ResolvePatternAvailability(el, automation, name);

        // 2. LegacyIAccessible.<Prop> and `legacy*` shorthand aliases.
        if (PropertyResolverLogic.TryNormalizeLegacyName(name, out var legacyProp))
            return ResolveLegacy(el, legacyProp);

        // 3. Pattern dot-notation: <Pattern>.<Prop> (e.g. Value.Value, Window.CanMaximize).
        var dot = name.IndexOf('.');
        if (dot > 0 && dot < name.Length - 1)
            return ResolveDotNotation(el, name.Substring(0, dot), name.Substring(dot + 1));

        // 4. Direct UIA element property (incl. the special-cased rect/handle/value formatting).
        if (TryResolveDirect(el, name, out var direct))
            return direct;

        // Unknown but plausible-looking single token (e.g. a UIA prop FlaUI doesn't surface): be permissive
        // and return null rather than 400, matching inspect's "property not present" semantics.
        if (PropertyResolverLogic.IsPlausiblePropertyToken(name))
            return null;

        throw new ArgumentException($"unknown attribute: {name}");
    }

    // ── 1. Pattern-availability flags ────────────────────────────────────────────────────────
    // Enumerate FlaUI's pattern table for the current framework; each PatternId carries the exact UIA
    // availability PropertyId whose .Name equals the inspect flag (e.g. "IsInvokePatternAvailable",
    // "IsTextPattern2Available"). We map requested-name → PatternId by that name, then read .IsSupported.
    private static object? ResolvePatternAvailability(AutomationElement el, AutomationBase automation, string name)
    {
        foreach (var pid in automation.PatternLibrary.AllForCurrentFramework)
        {
            var flag = pid.AvailabilityProperty?.Name;
            if (flag is null) continue;
            // Accept both FlaUI's authoritative flag name and inspect's transposed "2" variants
            // (e.g. inspect "IsTransform2PatternAvailable" vs FlaUI "IsTransformPattern2Available").
            if (string.Equals(flag, name, StringComparison.OrdinalIgnoreCase) ||
                string.Equals(PropertyResolverLogic.NormalizeAvailabilityFlag(flag), PropertyResolverLogic.NormalizeAvailabilityFlag(name), StringComparison.OrdinalIgnoreCase))
            {
                try { return el.IsPatternSupported(pid); }
                catch { return false; }
            }
        }
        // A plausible Is*PatternAvailable name the framework doesn't know → false (not 400).
        return false;
    }

    /// <summary>All Is*PatternAvailable flags for an element, keyed by inspect's flag name.</summary>
    public static Dictionary<string, object?> AllPatternAvailability(AutomationElement el, AutomationBase automation)
    {
        var dict = new Dictionary<string, object?>();
        foreach (var pid in automation.PatternLibrary.AllForCurrentFramework)
        {
            var flag = pid.AvailabilityProperty?.Name;
            if (flag is null) continue;
            try { dict[flag] = el.IsPatternSupported(pid); }
            catch { dict[flag] = false; }
        }
        return dict;
    }

    // ── 2. LegacyIAccessible.<Prop> ──────────────────────────────────────────────────────────
    private static object? ResolveLegacy(AutomationElement el, string prop)
    {
        var p = el.Patterns.LegacyIAccessible.PatternOrDefault;
        if (p is null) return null;
        return prop switch
        {
            "Name" => p.Name.ValueOrDefault,
            "Value" => p.Value.ValueOrDefault,
            "Description" => p.Description.ValueOrDefault,
            "Help" => p.Help.ValueOrDefault,
            "KeyboardShortcut" => p.KeyboardShortcut.ValueOrDefault,
            "DefaultAction" => p.DefaultAction.ValueOrDefault,
            "ChildId" => p.ChildId.ValueOrDefault,
            "Role" => FormatRole(p.Role.ValueOrDefault),
            "State" => FormatState(p.State.ValueOrDefault),
            _ => null,
        };
    }

    // Inspect renders the MSAA role/state via Oleacc.GetRoleText/GetStateText, then appends the raw hex.
    // FlaUI wraps the same Oleacc calls in AccessibilityTextResolver, so we get identical localized text.
    internal static string FormatRole(AccessibilityRole role)
    {
        string text;
        try { text = AccessibilityTextResolver.GetRoleText(role); } catch { text = role.ToString(); }
        return PropertyResolverLogic.WithHex(text, (uint)role);
    }

    internal static string FormatState(AccessibilityState state)
    {
        string text;
        try { text = AccessibilityTextResolver.GetStateText(state); } catch { text = state.ToString(); }
        return PropertyResolverLogic.WithHex(text, (uint)state);
    }

    // ── 3. Pattern dot-notation via reflection ───────────────────────────────────────────────
    // el.Patterns is IFrameworkPatterns; its members (Value, Toggle, Window, RangeValue, …) are
    // IAutomationPattern<T> with a .PatternOrDefault. We resolve the pattern object by the prefix name,
    // then reflect the requested property → it's an AutomationProperty<T> → read .ValueOrDefault.
    private static object? ResolveDotNotation(AutomationElement el, string patternName, string propName)
    {
        var patterns = el.Patterns;
        var accessor = patterns.GetType()
            .GetProperties(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
            .FirstOrDefault(pi => string.Equals(pi.Name, patternName, StringComparison.OrdinalIgnoreCase)
                                  && IsAutomationPattern(pi.PropertyType));
        // Explicit-interface members (the real shape of IFrameworkPatterns) aren't enumerable as public
        // props on the concrete type; resolve through the interface map instead.
        object? patternHolder = accessor is not null
            ? accessor.GetValue(patterns)
            : GetInterfacePattern(patterns, patternName);
        if (patternHolder is null) return null;

        // IAutomationPattern<T>.PatternOrDefault → the pattern instance (or null when unsupported).
        var pod = patternHolder.GetType().GetProperty("PatternOrDefault");
        object? pattern;
        try { pattern = pod?.GetValue(patternHolder); } catch { return null; }
        if (pattern is null) return null;

        var member = pattern.GetType().GetProperty(propName,
            BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase);
        if (member is null) return null;

        object? raw;
        try { raw = member.GetValue(pattern); } catch { return null; }
        return UnwrapAutomationProperty(raw);
    }

    private static bool IsAutomationPattern(Type t) =>
        t.IsGenericType && t.GetGenericTypeDefinition().Name.StartsWith("IAutomationPattern");

    // Walk the IFrameworkPatterns interface map to find the named pattern accessor (explicit impl).
    private static object? GetInterfacePattern(object patterns, string patternName)
    {
        var iface = patterns.GetType().GetInterfaces()
            .FirstOrDefault(i => i.Name == "IFrameworkPatterns");
        var prop = iface?.GetProperty(patternName,
            BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase);
        if (prop is null) return null;
        try { return prop.GetValue(patterns); } catch { return null; }
    }

    // raw is typically AutomationProperty<T>; unwrap to its ValueOrDefault. Enums are stringified
    // (ToggleState/ExpandCollapseState/WindowVisualState read like inspect); rects/elements pass through.
    private static object? UnwrapAutomationProperty(object? raw)
    {
        if (raw is null) return null;
        var t = raw.GetType();
        if (t.IsGenericType && t.GetGenericTypeDefinition().Name.StartsWith("AutomationProperty"))
        {
            var vod = t.GetProperty("ValueOrDefault");
            object? v;
            try { v = vod?.GetValue(raw); } catch { return null; }
            return Normalize(v);
        }
        return Normalize(raw);
    }

    private static object? Normalize(object? v)
    {
        if (v is null) return null;
        if (v.GetType().IsEnum) return v.ToString();
        if (v is System.Drawing.Rectangle r)
            return new { x = r.X, y = r.Y, width = r.Width, height = r.Height };
        if (v is AutomationElement) return null; // not serialisable here; callers use dedicated ops
        return v;
    }

    // ── 4. Direct UIA element properties ─────────────────────────────────────────────────────
    private static bool TryResolveDirect(AutomationElement el, string name, out object? value)
    {
        value = name switch
        {
            "Name" => NameWithLegacyFallback(el),
            "Text" => GetText(el),
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
            "Value" => ValueWithLegacyFallback(el),
            "IsSelected" => el.Patterns.SelectionItem.PatternOrDefault?.IsSelected.ValueOrDefault,
            "BoundingRectangle" => RectOf(el),
            "NativeWindowHandle" => "0x" + el.Properties.NativeWindowHandle.ValueOrDefault.ToInt64().ToString("X"),
            "HasKeyboardFocus" => el.Properties.HasKeyboardFocus.ValueOrDefault,
            "AcceleratorKey" => el.Properties.AcceleratorKey.ValueOrDefault,
            "AccessKey" => el.Properties.AccessKey.ValueOrDefault,
            "IsContentElement" => el.Properties.IsContentElement.ValueOrDefault,
            "IsControlElement" => el.Properties.IsControlElement.ValueOrDefault,
            "IsKeyboardFocusable" => el.Properties.IsKeyboardFocusable.ValueOrDefault,
            "IsPassword" => el.Properties.IsPassword.ValueOrDefault,
            "IsRequiredForForm" => el.Properties.IsRequiredForForm.ValueOrDefault,
            "ItemStatus" => el.Properties.ItemStatus.ValueOrDefault,
            "ItemType" => el.Properties.ItemType.ValueOrDefault,
            "Orientation" => el.Properties.Orientation.ValueOrDefault.ToString(),
            "ProviderDescription" => el.Properties.ProviderDescription.ValueOrDefault,
            "IsDialog" => SafeBool(() => el.Properties.IsDialog.ValueOrDefault),
            _ => Sentinel,
        };
        return !ReferenceEquals(value, Sentinel);
    }

    private static readonly object Sentinel = new();

    // UIA-empty → LegacyIAccessible fallback (inspect/MSAA semantics): a blank direct Name/Value falls
    // back to the LegacyIAccessible equivalent (some Win32 controls only expose the MSAA value).
    private static object? NameWithLegacyFallback(AutomationElement el)
    {
        var n = el.Properties.Name.ValueOrDefault;
        if (!string.IsNullOrEmpty(n)) return n;
        var legacy = el.Patterns.LegacyIAccessible.PatternOrDefault?.Name.ValueOrDefault;
        return string.IsNullOrEmpty(legacy) ? n : legacy;
    }

    private static object? ValueWithLegacyFallback(AutomationElement el)
    {
        var v = el.Patterns.Value.PatternOrDefault?.Value.ValueOrDefault;
        if (!string.IsNullOrEmpty(v)) return v;
        var legacy = el.Patterns.LegacyIAccessible.PatternOrDefault?.Value.ValueOrDefault;
        return string.IsNullOrEmpty(legacy) ? v : legacy;
    }

    /// <summary>W3C "Get Element Text" (GET /element/:id/text). FlaUI-native precedence:
    ///   1. TextPattern.DocumentRange.GetText(-1) — the rendered text of text/document controls
    ///      (Edit/Document/RichEdit); -1 = no length cap.
    ///   2. ValuePattern.Value — editable controls that expose a value but no TextPattern.
    ///   3. Name — labels, buttons, and most other controls (a Button's caption IS its Name).
    ///   4. LegacyIAccessible.Value — Win32/MSAA-only controls whose value never reaches UIA.
    /// Returns "" rather than null so the W3C endpoint always answers a string. Each step is wrapped so an
    /// unsupported/throwing pattern degrades to the next instead of failing the whole read.</summary>
    internal static string GetText(AutomationElement el)
    {
        // 1. TextPattern (text & document controls).
        try
        {
            var tp = el.Patterns.Text.PatternOrDefault;
            var doc = tp?.DocumentRange;
            if (doc is not null)
            {
                var t = doc.GetText(-1);
                if (!string.IsNullOrEmpty(t)) return t;
            }
        }
        catch { /* fall through */ }

        // 2. ValuePattern.Value.
        try
        {
            var v = el.Patterns.Value.PatternOrDefault?.Value.ValueOrDefault;
            if (!string.IsNullOrEmpty(v)) return v;
        }
        catch { /* fall through */ }

        // 3. Name.
        try
        {
            var n = el.Properties.Name.ValueOrDefault;
            if (!string.IsNullOrEmpty(n)) return n;
        }
        catch { /* fall through */ }

        // 4. LegacyIAccessible.Value.
        try
        {
            var legacy = el.Patterns.LegacyIAccessible.PatternOrDefault?.Value.ValueOrDefault;
            if (!string.IsNullOrEmpty(legacy)) return legacy;
        }
        catch { /* fall through */ }

        return string.Empty;
    }

    private static object? SafeBool(Func<bool> f)
    {
        try { return f(); } catch { return null; }
    }

    internal static object RectOf(AutomationElement el)
    {
        var r = el.Properties.BoundingRectangle.ValueOrDefault;
        return new { x = (int)r.X, y = (int)r.Y, width = (int)r.Width, height = (int)r.Height };
    }

    // ── "all" dump ───────────────────────────────────────────────────────────────────────────
    /// <summary>The full reachable attribute set for an element: every direct UIA property we expose, the
    /// LegacyIAccessible.* family, and all Is*PatternAvailable flags — inspect-comparable.</summary>
    public static Dictionary<string, object?> All(AutomationElement el, AutomationBase automation)
    {
        var dict = new Dictionary<string, object?>();
        foreach (var n in PropertyResolverLogic.DirectAttributeNames)
        {
            try { TryResolveDirect(el, n, out var v); dict[n] = v; }
            catch { dict[n] = null; }
        }
        foreach (var prop in PropertyResolverLogic.LegacyProps)
        {
            try { dict["LegacyIAccessible." + prop] = ResolveLegacy(el, prop); }
            catch { dict["LegacyIAccessible." + prop] = null; }
        }
        foreach (var kv in AllPatternAvailability(el, automation)) dict[kv.Key] = kv.Value;
        return dict;
    }
}
