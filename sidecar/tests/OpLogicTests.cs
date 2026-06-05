using FlaUiSidecar;
using Xunit;
using static FlaUiSidecar.OpLogic;

public class OpLogicTests
{
    // sample enum (FlaUI-free) for ParseEnum tests — stands in for ControlType.
    public enum SampleType { Button, Window, Pane }

    // ── modifier parsing ──────────────────────────────────────────────────────────────────────────
    [Theory]
    [InlineData("ctrl", CanonicalModifier.Ctrl)]
    [InlineData("control", CanonicalModifier.Ctrl)]
    [InlineData("CTRL", CanonicalModifier.Ctrl)]
    [InlineData("Shift", CanonicalModifier.Shift)]
    [InlineData("alt", CanonicalModifier.Alt)]
    [InlineData("menu", CanonicalModifier.Alt)]
    [InlineData("win", CanonicalModifier.Win)]
    [InlineData("meta", CanonicalModifier.Win)]
    [InlineData("Windows", CanonicalModifier.Win)]
    [InlineData("  Alt  ", CanonicalModifier.Alt)]
    public void ParseModifier_Aliases_CaseInsensitive(string input, CanonicalModifier expected) =>
        Assert.Equal(expected, ParseModifier(input));

    [Theory]
    [InlineData("hyper")]
    [InlineData("")]
    public void ParseModifier_Unknown_Throws(string input) =>
        Assert.Throws<InvalidArgumentException>(() => ParseModifier(input));

    [Fact]
    public void ParseModifiers_CommaString_SkipsEmptyAndWhitespace()
    {
        var r = ParseModifiers("ctrl, ,  , shift,");
        Assert.Equal(new[] { CanonicalModifier.Ctrl, CanonicalModifier.Shift }, r);
    }

    [Fact]
    public void ParseModifiers_Array_SkipsBlankEntries()
    {
        var r = ParseModifiers(new[] { "alt", "", "  ", "win" });
        Assert.Equal(new[] { CanonicalModifier.Alt, CanonicalModifier.Win }, r);
    }

    [Fact]
    public void ParseModifiers_EmptyInput_ReturnsEmpty()
    {
        Assert.Empty(ParseModifiers(""));
        Assert.Empty(ParseModifiers(new string[0]));
    }

    // ── button parsing ────────────────────────────────────────────────────────────────────────────
    [Theory]
    [InlineData("left", CanonicalButton.Left)]
    [InlineData("LEFT", CanonicalButton.Left)]
    [InlineData("right", CanonicalButton.Right)]
    [InlineData("middle", CanonicalButton.Middle)]
    [InlineData("default", CanonicalButton.Left)]
    [InlineData("", CanonicalButton.Left)]
    [InlineData(null, CanonicalButton.Left)]
    public void ParseButton_Canonical(string? input, CanonicalButton expected) =>
        Assert.Equal(expected, ParseButton(input));

    [Fact]
    public void ParseButton_Invalid_Throws() =>
        Assert.Throws<InvalidArgumentException>(() => ParseButton("scroll"));

    // ── LooksLikeRuntimeId ──────────────────────────────────────────────────────────────────────────
    [Theory]
    [InlineData("42")]
    [InlineData("1.2.3")]
    [InlineData("7.0.123456")]
    public void LooksLikeRuntimeId_Positives(string id) => Assert.True(LooksLikeRuntimeId(id));

    [Theory]
    [InlineData("")]
    [InlineData("abc")]
    [InlineData("1.2.")]
    [InlineData(".1.2")]
    [InlineData("1..2")]
    [InlineData("0x1F")]
    [InlineData("1.2.3 ")]
    public void LooksLikeRuntimeId_Negatives(string id) => Assert.False(LooksLikeRuntimeId(id));

    // ── TryParseHwnd ────────────────────────────────────────────────────────────────────────────────
    [Theory]
    [InlineData("0x1A2B", 0x1A2B)]
    [InlineData("0X1a2b", 0x1A2B)]
    [InlineData("1A2B", 0x1A2B)]
    [InlineData("ffff", 0xFFFF)]
    [InlineData("  0x10  ", 0x10)]
    public void TryParseHwnd_Valid(string input, long expected)
    {
        Assert.True(TryParseHwnd(input, out var v));
        Assert.Equal(expected, v);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData(null)]
    [InlineData("0x")]
    [InlineData("xyz")]
    [InlineData("12g4")]
    public void TryParseHwnd_Invalid_ReturnsFalse(string? input) =>
        Assert.False(TryParseHwnd(input, out _));

    [Fact]
    public void TryParseHwnd_CallerThrowsInvalidArgument_NotInvalidSelector()
    {
        // Mirrors Program.cs: bad HWND → InvalidArgumentException → "invalid argument" (not "invalid selector").
        static long Attach(string hex)
        {
            if (!TryParseHwnd(hex, out var hwnd))
                throw new InvalidArgumentException($"appTopLevelWindow is not a valid hex HWND: '{hex}'");
            return hwnd;
        }
        var ex = Assert.Throws<InvalidArgumentException>(() => Attach("not-hex"));
        Assert.Equal(W3C.InvalidArgument, ClassifyError(ex));
    }

    // ── UiaDefault ──────────────────────────────────────────────────────────────────────────────────
    [Fact]
    public void UiaDefault_SmallOpTimeout_FloorsAt1000ms()
    {
        // op-5s would be 1000ms exactly here; below that it's clamped to the 1000ms floor.
        Assert.Equal(1000, UiaDefault(TimeSpan.FromSeconds(6)).TotalMilliseconds);
        Assert.Equal(1000, UiaDefault(TimeSpan.FromSeconds(3)).TotalMilliseconds); // op-5s negative → floor
    }

    [Fact]
    public void UiaDefault_MidRange_IsOpMinus5s()
    {
        Assert.Equal(10_000, UiaDefault(TimeSpan.FromSeconds(15)).TotalMilliseconds); // 15-5 = 10
    }

    [Fact]
    public void UiaDefault_LargeOpTimeout_CapsAt20000ms()
    {
        Assert.Equal(20_000, UiaDefault(TimeSpan.FromSeconds(30)).TotalMilliseconds); // min(20000, 25000)
        Assert.Equal(20_000, UiaDefault(TimeSpan.FromMinutes(5)).TotalMilliseconds);
    }

    [Theory]
    [InlineData(6)]
    [InlineData(15)]
    [InlineData(30)]
    [InlineData(300)]
    public void UiaDefault_NeverExceeds_OpMinus5s_WhenThatIsAtLeast1s(int opSeconds)
    {
        var op = TimeSpan.FromSeconds(opSeconds);
        var d = UiaDefault(op);
        Assert.True(d.TotalMilliseconds <= op.TotalMilliseconds - 5_000 + 0.001,
            $"uiaDefault {d.TotalMilliseconds}ms must be ≤ op-5s ({op.TotalMilliseconds - 5_000}ms)");
    }

    // ── error classifier ────────────────────────────────────────────────────────────────────────────
    [Fact]
    public void ClassifyError_TimeoutException() =>
        Assert.Equal(W3C.Timeout, ClassifyError(new TimeoutException()));

    [Fact]
    public void ClassifyError_SchedulerFatal_IsUnknownError() =>
        Assert.Equal(W3C.UnknownError, ClassifyError(new SchedulerFatalException(5)));

    [Fact]
    public void ClassifyError_StaleElement() =>
        Assert.Equal(W3C.StaleElementReference, ClassifyError(new StaleElementException("1.2")));

    [Fact]
    public void ClassifyError_ElementNotFound() =>
        Assert.Equal(W3C.NoSuchElement, ClassifyError(new ElementNotFoundException()));

    [Fact]
    public void ClassifyError_InvalidArgument() =>
        Assert.Equal(W3C.InvalidArgument, ClassifyError(new InvalidArgumentException("bad")));

    [Fact]
    public void ClassifyError_ArgumentException_IsInvalidSelector() =>
        Assert.Equal(W3C.InvalidSelector, ClassifyError(new ArgumentException("bad selector")));

    [Fact]
    public void ClassifyError_OtherException_IsUnknownError() =>
        Assert.Equal(W3C.UnknownError, ClassifyError(new InvalidOperationException()));

    [Fact]
    public void ClassifyError_InvalidArgument_BeforeArgumentBase()
    {
        // InvalidArgumentException does NOT derive from ArgumentException, but verify the table still keeps
        // them distinct (invalid argument vs invalid selector).
        Assert.NotEqual(ClassifyError(new InvalidArgumentException("x")),
                        ClassifyError(new ArgumentException("y")));
    }

    // ── condition-value parsing (BuildProperty) ──────────────────────────────────────────────────────
    [Theory]
    [InlineData("true", true)]
    [InlineData("False", false)]
    [InlineData("  TRUE ", true)]
    public void ParseBool_Valid(string raw, bool expected) => Assert.Equal(expected, ParseBool(raw));

    [Theory]
    [InlineData("yes")]
    [InlineData("1")]
    [InlineData("")]
    public void ParseBool_Invalid_ThrowsInvalidArgument(string raw) =>
        Assert.Throws<InvalidArgumentException>(() => ParseBool(raw));

    [Theory]
    [InlineData("42", 42)]
    [InlineData("-7", -7)]
    [InlineData("  100 ", 100)]
    public void ParseInt_Valid(string raw, int expected) => Assert.Equal(expected, ParseInt(raw));

    [Theory]
    [InlineData("3.14")]
    [InlineData("abc")]
    [InlineData("99999999999999999999")] // overflow
    public void ParseInt_Invalid_ThrowsInvalidArgument(string raw) =>
        Assert.Throws<InvalidArgumentException>(() => ParseInt(raw));

    [Fact]
    public void ParseRuntimeId_Valid() =>
        Assert.Equal(new[] { 1, 2, 3 }, ParseRuntimeId("1.2.3"));

    [Theory]
    [InlineData("1.x.3")]
    [InlineData("1..2")]
    public void ParseRuntimeId_Invalid_ThrowsInvalidArgument(string raw) =>
        Assert.Throws<InvalidArgumentException>(() => ParseRuntimeId(raw));

    [Theory]
    [InlineData("Window", SampleType.Window)]
    [InlineData("window", SampleType.Window)]
    [InlineData("  Pane ", SampleType.Pane)]
    public void ParseEnum_Valid(string raw, SampleType expected) =>
        Assert.Equal(expected, ParseEnum<SampleType>(raw));

    [Theory]
    [InlineData("Nonexistent")]
    [InlineData("99")] // numeric-but-undefined must be rejected
    [InlineData("")]
    public void ParseEnum_Invalid_ThrowsInvalidArgument(string raw) =>
        Assert.Throws<InvalidArgumentException>(() => ParseEnum<SampleType>(raw));

    // ── point / rect math ─────────────────────────────────────────────────────────────────────────
    [Fact]
    public void Center_EvenDimensions()
    {
        var c = Center(new IntRect(10, 20, 100, 40));
        Assert.Equal(new IntPoint(60, 40), c);
    }

    [Fact]
    public void Center_OddDimensions_TruncatesTowardTopLeft()
    {
        // width 7 → +3 (7/2=3), height 5 → +2; matches r.X + r.Width/2 integer division.
        var c = Center(new IntRect(0, 0, 7, 5));
        Assert.Equal(new IntPoint(3, 2), c);
    }

    [Fact]
    public void OffsetFrom_AddsToTopLeft()
    {
        var p = OffsetFrom(new IntRect(100, 200, 50, 50), 5, 9);
        Assert.Equal(new IntPoint(105, 209), p);
    }
}
