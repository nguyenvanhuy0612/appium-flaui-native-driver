using FlaUiSidecar;
using Xunit;

namespace FlaUiSidecar.Tests;

/// <summary>
/// Cross-platform unit tests for the FlaUI-free property-resolver logic (name classification, legacy-name
/// normalization, availability-flag normalization, hex formatting). The FlaUI-bound resolution itself is
/// exercised by the Windows E2E verify, not here.
/// </summary>
public class PropertyResolverLogicTests
{
    [Theory]
    [InlineData("IsInvokePatternAvailable", true)]
    [InlineData("IsLegacyIAccessiblePatternAvailable", true)]
    [InlineData("IsTextPattern2Available", true)]
    [InlineData("IsTransform2PatternAvailable", true)]
    [InlineData("IsSelectionPattern2Available", true)]
    [InlineData("Name", false)]
    [InlineData("LegacyIAccessible.Name", false)]
    [InlineData("Value.Value", false)]
    public void Classifies_availability_flags(string name, bool expected) =>
        Assert.Equal(expected, PropertyResolverLogic.LooksLikePatternAvailabilityFlag(name));

    [Fact]
    public void Normalizes_inspect_vs_flaui_pattern2_flag_names()
    {
        // inspect: "IsTransform2PatternAvailable" — FlaUI: "IsTransformPattern2Available" → compare equal.
        Assert.Equal(
            PropertyResolverLogic.NormalizeAvailabilityFlag("IsTransform2PatternAvailable"),
            PropertyResolverLogic.NormalizeAvailabilityFlag("IsTransformPattern2Available"));
        // inspect & FlaUI agree on these (text pattern 2 / selection pattern 2).
        Assert.Equal(
            PropertyResolverLogic.NormalizeAvailabilityFlag("IsTextPattern2Available"),
            PropertyResolverLogic.NormalizeAvailabilityFlag("IsTextPattern2Available"));
        // Distinct patterns must NOT collide.
        Assert.NotEqual(
            PropertyResolverLogic.NormalizeAvailabilityFlag("IsInvokePatternAvailable"),
            PropertyResolverLogic.NormalizeAvailabilityFlag("IsValuePatternAvailable"));
    }

    [Theory]
    [InlineData("LegacyIAccessible.Name", "Name")]
    [InlineData("LegacyIAccessible.role", "Role")]
    [InlineData("legacyName", "Name")]
    [InlineData("legacyRole", "Role")]
    [InlineData("legacy.DefaultAction", "DefaultAction")]
    [InlineData("LEGACYIACCESSIBLE.STATE", "State")]
    public void Normalizes_legacy_names(string input, string expected)
    {
        Assert.True(PropertyResolverLogic.TryNormalizeLegacyName(input, out var prop));
        Assert.Equal(expected, prop);
    }

    [Theory]
    [InlineData("Name")]
    [InlineData("Value.Value")]
    [InlineData("legacyBogus")]          // legacy* with an unknown sub-prop is NOT a legacy name
    [InlineData("LegacyIAccessible.Nope")]
    public void Rejects_non_legacy_names(string input) =>
        Assert.False(PropertyResolverLogic.TryNormalizeLegacyName(input, out _));

    [Theory]
    [InlineData("Name", true)]
    [InlineData("Value.Value", true)]
    [InlineData("LegacyIAccessible.Role", true)]
    [InlineData("Window_State", true)]
    [InlineData("", false)]
    [InlineData("  ", false)]
    [InlineData("1bad", false)]
    [InlineData("has space", false)]
    [InlineData("weird$char", false)]
    public void Classifies_plausible_tokens(string name, bool expected) =>
        Assert.Equal(expected, PropertyResolverLogic.IsPlausiblePropertyToken(name));

    [Theory]
    [InlineData("push button", 0x2Bu, "push button (0x2B)")]
    [InlineData("focusable", 0x100000u, "focusable (0x100000)")]
    [InlineData("", 0u, " (0x0)")]
    public void Formats_hex_like_inspect(string text, uint value, string expected) =>
        Assert.Equal(expected, PropertyResolverLogic.WithHex(text, value));

    [Fact]
    public void Direct_and_legacy_name_lists_cover_inspect_families()
    {
        Assert.Contains("BoundingRectangle", PropertyResolverLogic.DirectAttributeNames);
        Assert.Contains("NativeWindowHandle", PropertyResolverLogic.DirectAttributeNames);
        Assert.Contains("Value", PropertyResolverLogic.DirectAttributeNames);
        Assert.Contains("ProviderDescription", PropertyResolverLogic.DirectAttributeNames);
        Assert.Contains("IsDialog", PropertyResolverLogic.DirectAttributeNames);
        foreach (var p in new[] { "Name", "Role", "State", "DefaultAction", "Value", "ChildId" })
            Assert.Contains(p, PropertyResolverLogic.LegacyProps);
    }
}
