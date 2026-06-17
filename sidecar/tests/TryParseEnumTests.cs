using FlaUiSidecar;
using Xunit;
using static FlaUiSidecar.OpLogic;

namespace FlaUiSidecar.Tests;

/// <summary>
/// Unit tests for <see cref="OpLogic.TryParseEnum{TEnum}"/> (W3C bug #8). A <c>tag name</c> locator naming
/// an unknown control type must be a NON-MATCH, not an "invalid argument" 400: TryParseEnum returns false
/// (so the condition build can emit a never-matching FalseCondition) instead of throwing. SampleType stands
/// in for ControlType (keeps this file FlaUI-free). Recognized names still parse.
/// </summary>
public class TryParseEnumTests
{
    public enum SampleType { Button, Window, Pane }

    [Theory]
    [InlineData("Button", SampleType.Button)]
    [InlineData("window", SampleType.Window)]   // case-insensitive
    [InlineData("  Pane  ", SampleType.Pane)]   // trimmed
    public void KnownName_Parses(string raw, SampleType expected)
    {
        Assert.True(TryParseEnum<SampleType>(raw, out var v));
        Assert.Equal(expected, v);
    }

    [Theory]
    [InlineData("NotARealControlType")]
    [InlineData("")]
    [InlineData(null)]
    [InlineData("99")]   // numeric value not a defined member → not a match
    public void UnknownName_ReturnsFalse_DoesNotThrow(string? raw)
    {
        // The bug: this used to throw InvalidArgumentException (→ 400). It must now just be false.
        Assert.False(TryParseEnum<SampleType>(raw, out _));
    }

    [Fact]
    public void DefinedNumericString_DoesNotParse_AsName()
    {
        // "0" would map to Button by numeric value, but a tag-name locator is by NAME — Enum.TryParse accepts
        // "0" as a value; this documents that behavior (still a defined member, so true).
        Assert.True(TryParseEnum<SampleType>("0", out var v));
        Assert.Equal(SampleType.Button, v);
    }
}
