namespace FlaUiSidecar;

/// <summary>
/// FlaUI-free pure logic for the property resolver: name classification, legacy-name normalization,
/// availability-flag normalization, and inspect-style hex formatting. Split out so it can be unit-tested
/// cross-platform (the C# test project deliberately avoids the Windows-only FlaUI dependency).
/// </summary>
public static class PropertyResolverLogic
{
    /// <summary>Direct UIA element properties the resolver/"all" dump exposes (order = inspect-ish).</summary>
    public static readonly string[] DirectAttributeNames =
    {
        "Name", "ControlType", "LocalizedControlType", "BoundingRectangle", "IsEnabled", "IsOffscreen",
        "IsKeyboardFocusable", "HasKeyboardFocus", "AccessKey", "AcceleratorKey", "ProcessId", "RuntimeId",
        "FrameworkId", "ClassName", "AutomationId", "NativeWindowHandle", "ProviderDescription",
        "IsPassword", "HelpText", "IsDialog", "IsContentElement", "IsControlElement", "IsRequiredForForm",
        "ItemStatus", "ItemType", "Orientation", "Value", "IsSelected", "ClickablePoint",
    };

    /// <summary>Availability flags inspect.exe lists that FlaUI's pattern table for the current framework
    /// does not surface (so they never come back from PatternLibrary). Included in the "all" dump as a
    /// best-effort <c>false</c> for inspect parity; FlaUI cannot determine their real support.</summary>
    public static readonly string[] ExtraAvailabilityFlags =
    {
        "IsCustomNavigationPatternAvailable", "IsSelectionPattern2Available",
    };

    /// <summary>LegacyIAccessible.* sub-properties (inspect alphabetical order).</summary>
    public static readonly string[] LegacyProps =
    {
        "ChildId", "DefaultAction", "Description", "Help", "KeyboardShortcut", "Name", "Role", "State", "Value",
    };

    /// <summary>True for names shaped like an availability flag (Is&lt;X&gt;PatternAvailable or
    /// Is&lt;X&gt;Pattern&lt;n&gt;Available / Is&lt;X&gt;&lt;n&gt;Available).</summary>
    public static bool LooksLikePatternAvailabilityFlag(string name) =>
        name.StartsWith("Is", StringComparison.Ordinal) && name.EndsWith("Available", StringComparison.Ordinal)
        && name.Contains("Pattern", StringComparison.Ordinal);

    /// <summary>Collapse the cosmetic differences between inspect's and FlaUI's "2"-pattern flag names so
    /// e.g. "IsTransform2PatternAvailable" (inspect) and "IsTransformPattern2Available" (FlaUI) compare equal.
    /// Strategy: l-case, drop the literal "pattern" token and any digits, leaving the stable core.</summary>
    public static string NormalizeAvailabilityFlag(string flag)
    {
        var s = flag.ToLowerInvariant().Replace("pattern", string.Empty);
        var sb = new System.Text.StringBuilder(s.Length);
        foreach (var c in s) if (!char.IsDigit(c)) sb.Append(c);
        return sb.ToString();
    }

    /// <summary>Normalize a requested name into a canonical LegacyIAccessible sub-property, accepting:
    ///   • "LegacyIAccessible.&lt;Prop&gt;" (exact dotted form, any case)
    ///   • "legacy&lt;Prop&gt;" shorthand (e.g. legacyName, legacyrole, legacy.role).
    /// Returns false for non-legacy names.</summary>
    public static bool TryNormalizeLegacyName(string name, out string prop)
    {
        prop = string.Empty;
        const string dotted = "LegacyIAccessible.";
        if (name.StartsWith(dotted, StringComparison.OrdinalIgnoreCase))
            return TryCanonicalLegacyProp(name.Substring(dotted.Length), out prop);

        if (name.StartsWith("legacy", StringComparison.OrdinalIgnoreCase))
        {
            var rest = name.Substring("legacy".Length).TrimStart('.', '_');
            if (rest.Length == 0) return false;
            return TryCanonicalLegacyProp(rest, out prop);
        }
        return false;
    }

    private static bool TryCanonicalLegacyProp(string raw, out string prop)
    {
        foreach (var p in LegacyProps)
        {
            if (string.Equals(p, raw, StringComparison.OrdinalIgnoreCase)) { prop = p; return true; }
        }
        prop = string.Empty;
        return false;
    }

    /// <summary>A name that looks like a real UIA/pattern property token (alpha, optional dot) — used to
    /// decide "return null" (permissive) vs "throw invalid selector" (genuinely malformed input).</summary>
    public static bool IsPlausiblePropertyToken(string name)
    {
        if (name.Length == 0 || name.Length > 128) return false;
        foreach (var c in name)
            if (!char.IsLetterOrDigit(c) && c != '.' && c != '_') return false;
        return char.IsLetter(name[0]);
    }

    /// <summary>"text (0xHEX)" — inspect's render for MSAA role/state (uppercase hex, no leading zeros).</summary>
    public static string WithHex(string text, uint value) =>
        $"{text} (0x{value:X})";
}
