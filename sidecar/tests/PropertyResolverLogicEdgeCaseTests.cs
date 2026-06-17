using FlaUiSidecar;
using Xunit;

namespace FlaUiSidecar.Tests;

/// <summary>
/// Additional edge-case coverage for <see cref="PropertyResolverLogic"/>: availability-flag classification
/// + normalization corner cases, legacy-name normalization oddities, plausible-token boundaries, and hex
/// formatting at the 32-bit boundary. Documents CURRENT behavior; FlaUI-free.
/// </summary>
public class PropertyResolverLogicEdgeCaseTests
{
    // ── LooksLikePatternAvailabilityFlag ───────────────────────────────────────────────────────────
    [Theory]
    [InlineData("IsAvailable", false)]                  // no "Pattern" token
    [InlineData("IsScrollPatternAvailable", true)]
    [InlineData("isInvokePatternAvailable", false)]     // Ordinal: lowercase "is" prefix is NOT matched
    [InlineData("IsInvokePatternAVAILABLE", false)]     // Ordinal: suffix case must match exactly
    [InlineData("IsPatternAvailable", true)]            // minimal Is + Pattern + Available
    [InlineData("PatternAvailableIs", false)]           // wrong order (must start Is, end Available)
    [InlineData("IsInvokePattern", false)]              // missing "Available"
    [InlineData("InvokePatternAvailable", false)]       // missing leading "Is"
    public void LooksLikePatternAvailabilityFlag_Boundaries(string name, bool expected) =>
        Assert.Equal(expected, PropertyResolverLogic.LooksLikePatternAvailabilityFlag(name));

    // ── NormalizeAvailabilityFlag ──────────────────────────────────────────────────────────────────
    [Fact]
    public void NormalizeAvailabilityFlag_StripsPatternTokenAndAllDigits()
    {
        // "pattern" token and every digit are removed; the rest is lowercased.
        Assert.Equal("isinvokeavailable",
            PropertyResolverLogic.NormalizeAvailabilityFlag("IsInvokePatternAvailable"));
    }

    [Fact]
    public void NormalizeAvailabilityFlag_DigitsAnywhereRemoved()
    {
        // Inspect's "2" before "Pattern" vs FlaUI's "2" after collapse to the same normalized core.
        var a = PropertyResolverLogic.NormalizeAvailabilityFlag("IsItemContainer2PatternAvailable");
        var b = PropertyResolverLogic.NormalizeAvailabilityFlag("IsItemContainerPattern2Available");
        Assert.Equal(a, b);
        Assert.DoesNotContain("2", a);
        Assert.DoesNotContain("pattern", a);
    }

    [Fact]
    public void NormalizeAvailabilityFlag_NoPatternNoDigits_JustLowercases() =>
        Assert.Equal("isenabled", PropertyResolverLogic.NormalizeAvailabilityFlag("IsEnabled"));

    [Fact]
    public void NormalizeAvailabilityFlag_DistinctPatternsStayDistinct() =>
        Assert.NotEqual(
            PropertyResolverLogic.NormalizeAvailabilityFlag("IsScrollPatternAvailable"),
            PropertyResolverLogic.NormalizeAvailabilityFlag("IsScrollItemPatternAvailable"));

    // ── TryNormalizeLegacyName oddities ────────────────────────────────────────────────────────────
    [Fact]
    public void TryNormalizeLegacyName_DottedFormStripsLeadingUnderscoreNotAllowed()
    {
        // "LegacyIAccessible.Name" → "Name" (exact, any case). The dotted branch passes the remainder
        // verbatim (no extra trim), so the canonical lookup must match it directly.
        Assert.True(PropertyResolverLogic.TryNormalizeLegacyName("legacyiaccessible.value", out var p));
        Assert.Equal("Value", p);
    }

    [Fact]
    public void TryNormalizeLegacyName_DottedFormWithWhitespace_Rejected()
    {
        // The dotted branch does NOT trim, so "LegacyIAccessible. Name" (leading space) is not canonical.
        Assert.False(PropertyResolverLogic.TryNormalizeLegacyName("LegacyIAccessible. Name", out _));
    }

    [Fact]
    public void TryNormalizeLegacyName_ShorthandTrimsLeadingDotsAndUnderscores()
    {
        Assert.True(PropertyResolverLogic.TryNormalizeLegacyName("legacy._.Name", out var p));
        Assert.Equal("Name", p);
        Assert.True(PropertyResolverLogic.TryNormalizeLegacyName("legacy__role", out var q));
        Assert.Equal("Role", q);
    }

    [Fact]
    public void TryNormalizeLegacyName_ShorthandAllSeparators_NoSubProp_Rejected() =>
        // "legacy" then only separators trims to "" → rejected.
        Assert.False(PropertyResolverLogic.TryNormalizeLegacyName("legacy...", out _));

    [Fact]
    public void TryNormalizeLegacyName_LegacyPrefixOnAnotherWord_Rejected() =>
        // "legacyfoo" → rest "foo" is not a canonical legacy prop → rejected (out = "").
        Assert.False(PropertyResolverLogic.TryNormalizeLegacyName("legacyfoo", out _));

    [Fact]
    public void TryNormalizeLegacyName_OutIsEmptyOnRejection()
    {
        PropertyResolverLogic.TryNormalizeLegacyName("Name", out var p);
        Assert.Equal(string.Empty, p);
    }

    [Fact]
    public void TryNormalizeLegacyName_AllNineCanonicalPropsViaDottedForm()
    {
        foreach (var prop in PropertyResolverLogic.LegacyProps)
        {
            Assert.True(PropertyResolverLogic.TryNormalizeLegacyName($"LegacyIAccessible.{prop}", out var got));
            Assert.Equal(prop, got);
        }
    }

    // ── IsPlausiblePropertyToken boundaries ────────────────────────────────────────────────────────
    [Fact]
    public void IsPlausiblePropertyToken_LengthBoundaries()
    {
        Assert.True(PropertyResolverLogic.IsPlausiblePropertyToken("A"));                  // single letter ok
        Assert.True(PropertyResolverLogic.IsPlausiblePropertyToken(new string('A', 128))); // exactly 128 ok
        Assert.False(PropertyResolverLogic.IsPlausiblePropertyToken(new string('A', 129)));// 129 rejected
    }

    [Theory]
    [InlineData("A1", true)]            // digit allowed after a leading letter
    [InlineData("a.b.c", true)]
    [InlineData("_x", false)]           // must START with a letter, not underscore
    [InlineData(".x", false)]           // must start with a letter, not dot
    [InlineData("9x", false)]           // must start with a letter, not digit
    [InlineData("a-b", false)]          // hyphen not allowed
    [InlineData("a b", false)]          // space not allowed
    [InlineData("a\tb", false)]
    [InlineData("café", true)]          // é is a Unicode letter → char.IsLetterOrDigit('é') is true
    public void IsPlausiblePropertyToken_CharRules(string name, bool expected) =>
        Assert.Equal(expected, PropertyResolverLogic.IsPlausiblePropertyToken(name));

    // ── WithHex 32-bit boundary ────────────────────────────────────────────────────────────────────
    [Theory]
    [InlineData("max", 0xFFFFFFFFu, "max (0xFFFFFFFF)")]
    [InlineData("one", 1u, "one (0x1)")]                  // no leading zeros
    [InlineData("ten", 10u, "ten (0xA)")]                 // uppercase hex
    public void WithHex_BoundaryValues(string text, uint value, string expected) =>
        Assert.Equal(expected, PropertyResolverLogic.WithHex(text, value));

    // ── static lists invariants ────────────────────────────────────────────────────────────────────
    [Fact]
    public void DirectAttributeNames_HasNoDuplicates() =>
        Assert.Equal(PropertyResolverLogic.DirectAttributeNames.Length,
            PropertyResolverLogic.DirectAttributeNames.Distinct().Count());

    [Fact]
    public void LegacyProps_HasNineDistinctEntries()
    {
        Assert.Equal(9, PropertyResolverLogic.LegacyProps.Length);
        Assert.Equal(9, PropertyResolverLogic.LegacyProps.Distinct().Count());
    }

    [Fact]
    public void ExtraAvailabilityFlags_AllClassifyAsAvailabilityFlags() =>
        Assert.All(PropertyResolverLogic.ExtraAvailabilityFlags,
            f => Assert.True(PropertyResolverLogic.LooksLikePatternAvailabilityFlag(f)));
}
