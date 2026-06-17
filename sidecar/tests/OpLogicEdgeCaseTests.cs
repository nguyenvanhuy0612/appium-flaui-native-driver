using FlaUiSidecar;
using Xunit;
using static FlaUiSidecar.OpLogic;

namespace FlaUiSidecar.Tests;

/// <summary>
/// Additional edge-case coverage for <see cref="OpLogic"/> beyond the happy/representative cases in
/// OpLogicTests. Every assertion documents CURRENT behavior (not a desired spec) — a failure here is a real
/// behavioral change. Pure logic only; no FlaUI/UIA types.
/// </summary>
public class OpLogicEdgeCaseTests
{
    // sample enum (FlaUI-free) for ParseEnum tests — stands in for a FlaUI enum like ControlType.
    public enum SampleType { Button, Window, Pane }

    // ── ParseModifier / ParseModifiers null + odd-input handling ───────────────────────────────────
    [Fact]
    public void ParseModifier_Null_Throws() =>
        // null coalesces to "" then fails the switch → InvalidArgumentException (not NullReferenceException).
        Assert.Throws<InvalidArgumentException>(() => ParseModifier(null!));

    [Theory]
    [InlineData("   ")]      // whitespace-only trims to "" → unknown
    [InlineData("ctrl ")]    // trailing space is trimmed, so this is actually VALID — separate assertion below
    public void ParseModifier_WhitespaceOnly_Throws_ButTrimmedNameSucceeds(string input)
    {
        if (input.Trim() == "ctrl")
            Assert.Equal(CanonicalModifier.Ctrl, ParseModifier(input));
        else
            Assert.Throws<InvalidArgumentException>(() => ParseModifier(input));
    }

    [Fact]
    public void ParseModifiers_NullCommaString_ReturnsEmpty() =>
        Assert.Empty(ParseModifiers((string)null!));

    [Fact]
    public void ParseModifiers_NullEnumerable_ReturnsEmpty() =>
        Assert.Empty(ParseModifiers((IEnumerable<string>)null!));

    [Fact]
    public void ParseModifiers_OneInvalidEntry_ThrowsFromThatEntry() =>
        // The lazy Select projects ParseModifier over each non-blank entry; a bad one throws on materialize.
        Assert.Throws<InvalidArgumentException>(() => ParseModifiers("ctrl, bogus, shift"));

    [Fact]
    public void ParseModifiers_Array_PreservesOrderAndDuplicates()
    {
        var r = ParseModifiers(new[] { "shift", "ctrl", "shift" });
        Assert.Equal(new[] { CanonicalModifier.Shift, CanonicalModifier.Ctrl, CanonicalModifier.Shift }, r);
    }

    // ── ParseButton odd inputs ─────────────────────────────────────────────────────────────────────
    [Theory]
    [InlineData("  right  ", CanonicalButton.Right)]   // trimmed before the switch
    [InlineData("Middle", CanonicalButton.Middle)]     // case-insensitive
    [InlineData("   ", CanonicalButton.Left)]          // whitespace trims to "" → Left
    public void ParseButton_TrimAndCase(string input, CanonicalButton expected) =>
        Assert.Equal(expected, ParseButton(input));

    [Theory]
    [InlineData("primary")]
    [InlineData("0")]
    [InlineData("leftclick")]
    public void ParseButton_UnknownNonEmpty_Throws(string input) =>
        Assert.Throws<InvalidArgumentException>(() => ParseButton(input));

    // ── ParseBool ──────────────────────────────────────────────────────────────────────────────────
    [Fact]
    public void ParseBool_Null_ThrowsInvalidArgument() =>
        Assert.Throws<InvalidArgumentException>(() => ParseBool(null!));

    [Theory]
    [InlineData("TrUe", true)]
    [InlineData("\tfalse\n", false)]   // surrounding whitespace incl. tab/newline is trimmed
    public void ParseBool_MixedCaseAndWhitespace(string raw, bool expected) =>
        Assert.Equal(expected, ParseBool(raw));

    // ── ParseInt boundaries ────────────────────────────────────────────────────────────────────────
    [Theory]
    [InlineData("+5", 5)]                 // NumberStyles.Integer permits a leading sign
    [InlineData("2147483647", int.MaxValue)]
    [InlineData("-2147483648", int.MinValue)]
    public void ParseInt_SignAndBoundaries(string raw, int expected) =>
        Assert.Equal(expected, ParseInt(raw));

    [Theory]
    [InlineData(null)]
    [InlineData("   ")]
    [InlineData("0x10")]                  // hex not accepted by NumberStyles.Integer
    [InlineData("2147483648")]            // int overflow by one
    [InlineData("1,000")]                 // thousands separators not allowed
    [InlineData("5 6")]
    public void ParseInt_MalformedOrOverflow_ThrowsInvalidArgument(string? raw) =>
        Assert.Throws<InvalidArgumentException>(() => ParseInt(raw!));

    // ── ParseRuntimeId ─────────────────────────────────────────────────────────────────────────────
    [Fact]
    public void ParseRuntimeId_SingleSegment() =>
        Assert.Equal(new[] { 42 }, ParseRuntimeId("42"));

    [Fact]
    public void ParseRuntimeId_NegativeSegmentsAllowed() =>
        // Each segment goes through ParseInt which accepts a sign, so a negative segment parses.
        Assert.Equal(new[] { 1, -2, 3 }, ParseRuntimeId("1.-2.3"));

    [Fact]
    public void ParseRuntimeId_WhitespaceAroundSegments_Tolerated() =>
        // ParseInt trims each segment, so " 1 . 2 " → {1,2}.
        Assert.Equal(new[] { 1, 2 }, ParseRuntimeId(" 1 . 2 "));

    [Theory]
    [InlineData("")]            // splits to [""] → ParseInt("") throws
    [InlineData("1.")]          // trailing empty segment
    [InlineData(".1")]          // leading empty segment
    [InlineData("1.abc.2")]
    public void ParseRuntimeId_AnyBadSegment_Throws(string raw) =>
        Assert.Throws<InvalidArgumentException>(() => ParseRuntimeId(raw));

    // ── ParseEnum ──────────────────────────────────────────────────────────────────────────────────
    [Fact]
    public void ParseEnum_Null_ThrowsInvalidArgument() =>
        Assert.Throws<InvalidArgumentException>(() => ParseEnum<SampleType>(null!));

    [Fact]
    public void ParseEnum_ExactCaseAndAllMembers()
    {
        Assert.Equal(SampleType.Button, ParseEnum<SampleType>("Button"));
        Assert.Equal(SampleType.Window, ParseEnum<SampleType>("WINDOW"));
        Assert.Equal(SampleType.Pane, ParseEnum<SampleType>("pane"));
    }

    [Fact]
    public void ParseEnum_NumericUndefinedRejected_DefinedNumericRejectedToo()
    {
        // "0" is the underlying value of Button but Enum.TryParse on a numeric string yields (SampleType)0
        // which IS defined → current behavior returns Button. Document it explicitly.
        Assert.Equal(SampleType.Button, ParseEnum<SampleType>("0"));
        // "99" is not a defined member → rejected by the Enum.IsDefined guard.
        Assert.Throws<InvalidArgumentException>(() => ParseEnum<SampleType>("99"));
    }

    // ── LooksLikeRuntimeId ─────────────────────────────────────────────────────────────────────────
    [Theory]
    [InlineData("0")]            // a single zero is a valid shape
    [InlineData("0.0.0")]
    [InlineData("123456789012")] // long digits ok (regex doesn't bound length)
    public void LooksLikeRuntimeId_MorePositives(string id) => Assert.True(LooksLikeRuntimeId(id));

    [Theory]
    [InlineData("-1")]           // leading minus is not part of the shape
    [InlineData(" 1.2")]         // leading space
    [InlineData("1 .2")]
    [InlineData("1.2 ")]         // trailing space
    public void LooksLikeRuntimeId_MoreNegatives(string id) => Assert.False(LooksLikeRuntimeId(id));

    [Fact]
    public void LooksLikeRuntimeId_TrailingNewline_MatchesDueToDotnetRegexDollarQuirk() =>
        // SURPRISING-BUT-CURRENT: .NET's `$` (without RegexOptions.Multiline) matches before a final \n, so
        // "1.2\n" is treated as a valid runtime-id shape. A trailing SPACE still fails. Documented so a future
        // change to RegexOptions.Singleline-anchoring (\z) is a deliberate, visible decision.
        Assert.True(LooksLikeRuntimeId("1.2\n"));

    // ── TryParseHwnd boundaries ────────────────────────────────────────────────────────────────────
    [Fact]
    public void TryParseHwnd_FullWidth64Bit_AllFs()
    {
        // 16 hex F's fits in a signed long as -1 (full 64-bit pattern). Documents current parse behavior.
        Assert.True(TryParseHwnd("FFFFFFFFFFFFFFFF", out var v));
        Assert.Equal(-1L, v);
    }

    [Fact]
    public void TryParseHwnd_Overflow17HexDigits_ReturnsFalse() =>
        Assert.False(TryParseHwnd("1FFFFFFFFFFFFFFFF", out _));

    [Theory]
    [InlineData("0", 0)]
    [InlineData("0x0", 0)]
    [InlineData("00007FFF", 0x7FFF)]
    public void TryParseHwnd_ZeroAndLeadingZeros(string input, long expected)
    {
        Assert.True(TryParseHwnd(input, out var v));
        Assert.Equal(expected, v);
    }

    [Theory]
    [InlineData("0X")]           // prefix only after strip → empty → false
    [InlineData("-1")]           // minus is not a hex digit
    [InlineData("12 34")]        // an interior space inside the digits breaks the hex parse
    public void TryParseHwnd_MoreInvalid(string input) =>
        Assert.False(TryParseHwnd(input, out _));

    [Fact]
    public void TryParseHwnd_SpaceAfterPrefix_IsTolerated()
    {
        // SURPRISING-BUT-CURRENT: after stripping "0x", the remainder " 10" still parses because
        // NumberStyles.HexNumber allows leading/trailing whitespace → 0x10. Documented behavior.
        Assert.True(TryParseHwnd("0x 10", out var v));
        Assert.Equal(0x10, v);
    }

    // ── ClassifyError inheritance walk ─────────────────────────────────────────────────────────────
    private sealed class DerivedTimeout : TimeoutException { }

    [Fact]
    public void ClassifyError_WalksBaseChain_DerivedTimeout() =>
        // The classifier walks t.BaseType, so a subclass of TimeoutException still maps to "timeout".
        Assert.Equal(W3C.Timeout, ClassifyError(new DerivedTimeout()));

    [Fact]
    public void ClassifyError_OperationCanceled_IsUnknownError() =>
        // OperationCanceledException is not in the table and does not derive from a mapped type.
        Assert.Equal(W3C.UnknownError, ClassifyError(new OperationCanceledException()));

    [Fact]
    public void ClassifyError_AggregateException_IsUnknownError() =>
        // The classifier does NOT unwrap AggregateException — it maps by the outer type only.
        Assert.Equal(W3C.UnknownError,
            ClassifyError(new AggregateException(new TimeoutException())));

    [Fact]
    public void ClassifyError_ArgumentNullException_IsInvalidSelector() =>
        // ArgumentNullException : ArgumentException, so the base-chain walk hits ArgumentException.
        Assert.Equal(W3C.InvalidSelector, ClassifyError(new ArgumentNullException("p")));

    [Fact]
    public void ClassifyError_ArgumentOutOfRange_IsInvalidSelector() =>
        Assert.Equal(W3C.InvalidSelector, ClassifyError(new ArgumentOutOfRangeException("p")));

    // ── Center / OffsetFrom with negatives ─────────────────────────────────────────────────────────
    [Fact]
    public void Center_NegativeOrigin()
    {
        var c = Center(new IntRect(-100, -50, 40, 20));
        Assert.Equal(new IntPoint(-80, -40), c);
    }

    [Fact]
    public void Center_NegativeWidth_TruncatesTowardZero()
    {
        // C# integer division truncates toward zero: -7/2 = -3. Documents the (degenerate) negative-dim case.
        var c = Center(new IntRect(0, 0, -7, -5));
        Assert.Equal(new IntPoint(-3, -2), c);
    }

    [Fact]
    public void Center_ZeroSize_IsTopLeft() =>
        Assert.Equal(new IntPoint(10, 20), Center(new IntRect(10, 20, 0, 0)));

    [Fact]
    public void OffsetFrom_NegativeOffsets()
    {
        var p = OffsetFrom(new IntRect(100, 100, 50, 50), -10, -20);
        Assert.Equal(new IntPoint(90, 80), p);
    }

    [Fact]
    public void OffsetFrom_ZeroOffset_IsTopLeft() =>
        Assert.Equal(new IntPoint(7, 9), OffsetFrom(new IntRect(7, 9, 3, 3), 0, 0));

    // ── ScrollDelta amount=0 + zero deltas ─────────────────────────────────────────────────────────
    [Fact]
    public void ScrollDelta_AmountZeroWithDeltas_ScalesToZero() =>
        // amount given as 0 multiplies the deltas → (0,0). (Distinct from amount==null which defaults to 1.)
        Assert.Equal((0d, 0d), ScrollDelta(2, 3, 0));

    [Fact]
    public void ScrollDelta_ZeroDeltasNoAmount_NoScroll() =>
        // deltaX/deltaY both present (even as 0) take the "deltas given" branch with default scale 1.
        Assert.Equal((0d, 0d), ScrollDelta(0, 0, null));

    [Fact]
    public void ScrollDelta_AmountZeroAlone_NoScroll() =>
        Assert.Equal((0d, 0d), ScrollDelta(null, null, 0));

    [Fact]
    public void ScrollDelta_NegativeAmountFlipsSign() =>
        Assert.Equal((-2d, -4d), ScrollDelta(1, 2, -2));

    [Fact]
    public void ScrollDelta_FractionalAmountScales() =>
        Assert.Equal((1d, 2d), ScrollDelta(2, 4, 0.5));

    // ── DragPath edge cases ────────────────────────────────────────────────────────────────────────
    [Fact]
    public void DragPath_NegativeDuration_SingleStepAtDestination()
    {
        var path = DragPath(0, 0, 5, 5, -100);
        Assert.Single(path);
        Assert.Equal(new IntPoint(5, 5), path[0]);
    }

    [Fact]
    public void DragPath_ReverseDirection_IsMonotonicDecreasing()
    {
        var path = DragPath(100, 100, 0, 0, 150);
        Assert.Equal(new IntPoint(0, 0), path[^1]);
        for (var i = 1; i < path.Count; i++)
        {
            Assert.True(path[i].X <= path[i - 1].X);
            Assert.True(path[i].Y <= path[i - 1].Y);
        }
    }

    [Fact]
    public void DragPath_StepLargerThanDuration_SingleStep()
    {
        // 10ms duration / 15ms step → Round(0.67)=1 step (Math.Max guards against 0).
        var path = DragPath(0, 0, 80, 0, 10);
        Assert.Single(path);
        Assert.Equal(new IntPoint(80, 0), path[0]);
    }

    [Fact]
    public void DragPath_NonPositiveStepMs_TreatedAsAtLeast1()
    {
        // stepMs <= 0 is guarded by Math.Max(1, stepMs); with stepMs=0, steps = Round(150/1) = 150.
        var path = DragPath(0, 0, 150, 0, 150, stepMs: 0);
        Assert.Equal(150, path.Count);
        Assert.Equal(new IntPoint(150, 0), path[^1]);
    }

    [Fact]
    public void DragPath_SamePoint_AllStepsAreThatPoint()
    {
        var path = DragPath(50, 60, 50, 60, 150);
        Assert.All(path, p => Assert.Equal(new IntPoint(50, 60), p));
        Assert.Equal(new IntPoint(50, 60), path[^1]);
    }

    [Fact]
    public void DragPath_StartsPastOrigin_FirstPointIsNotOrigin()
    {
        // i starts at 1, so the first emitted point is one step IN, never the start coordinate itself.
        var path = DragPath(0, 0, 100, 0, 150);
        Assert.NotEqual(new IntPoint(0, 0), path[0]);
        Assert.True(path[0].X > 0);
    }

    // ── SanitizeXmlText control-char + surrogate edges ─────────────────────────────────────────────
    [Theory]
    [InlineData(' ')]  // NUL
    [InlineData('')]  // backspace
    [InlineData('')]  // vertical tab (illegal in XML 1.0)
    [InlineData('')]  // form feed (illegal)
    [InlineData('')]  // SO
    [InlineData('')]  // unit separator
    [InlineData('￾')]  // just above the FFFD upper bound
    [InlineData('￿')]
    public void SanitizeXmlText_DropsEachIllegalChar(char illegal) =>
        Assert.Equal("XY", SanitizeXmlText($"X{illegal}Y"));

    [Theory]
    [InlineData(' ')]  // space (lowest legal printable)
    [InlineData('퟿')]  // top of the pre-surrogate legal range
    [InlineData('')]  // bottom of the post-surrogate legal range
    [InlineData('�')]  // replacement char — highest legal BMP scalar
    public void SanitizeXmlText_KeepsEachBoundaryLegalChar(char legal) =>
        Assert.Equal($"X{legal}Y", SanitizeXmlText($"X{legal}Y"));

    [Fact]
    public void SanitizeXmlText_TrailingHighSurrogate_Dropped() =>
        // A high surrogate at the very end has no following low half → dropped.
        Assert.Equal("ab", SanitizeXmlText("ab\uD83D"));

    [Fact]
    public void SanitizeXmlText_LoneLowSurrogate_Dropped() =>
        Assert.Equal("ab", SanitizeXmlText("a\uDE00b"));

    [Fact]
    public void SanitizeXmlText_OnlyIllegalChars_BecomesEmpty() =>
        Assert.Equal(string.Empty, SanitizeXmlText(" "));

    [Fact]
    public void SanitizeXmlText_MultipleSurrogatePairsAndDirtBetween()
    {
        // 😀 (pair) + NUL + 🚀 (pair) → both emoji kept, the NUL dropped.
        var input = "\U0001F600 \U0001F680";
        Assert.Equal("\U0001F600\U0001F680", SanitizeXmlText(input));
    }

    // ── CompileAppNameRegex / MatchesAppName ───────────────────────────────────────────────────────
    [Fact]
    public void CompileAppNameRegex_Null_CompilesToEmptyPattern_MatchesEverything()
    {
        var rx = CompileAppNameRegex(null!);
        Assert.True(MatchesAppName(rx, "anything"));
        Assert.True(MatchesAppName(rx, ""));   // empty pattern matches the empty string too
    }

    [Fact]
    public void MatchesAppName_EmptyTitleWithWildcard_Matches() =>
        Assert.True(MatchesAppName(CompileAppNameRegex(".*"), ""));

    [Fact]
    public void MatchesAppName_AnchoredEndPattern()
    {
        var rx = CompileAppNameRegex("Notepad$");
        Assert.True(MatchesAppName(rx, "Untitled - Notepad"));
        Assert.False(MatchesAppName(rx, "Notepad - Untitled"));
    }

    // ── NormalizeProcessName edges ─────────────────────────────────────────────────────────────────
    [Theory]
    [InlineData(".exe", "")]            // ".exe" alone → "" after strip
    [InlineData("exe", "exe")]          // no dot → not stripped
    [InlineData("a.EXE.exe", "a.EXE")]  // only the single trailing .exe stripped
    [InlineData("  .exe  ", "")]
    [InlineData("foo.Exe", "foo")]
    public void NormalizeProcessName_MoreEdges(string input, string expected) =>
        Assert.Equal(expected, NormalizeProcessName(input));

    // ── CreateSessionTimeout ───────────────────────────────────────────────────────────────────────
    [Fact]
    public void CreateSessionTimeout_NaN_FallsBackToDefault() =>
        // NaN is not > 0, so it takes the default branch.
        Assert.Equal(60_000, CreateSessionTimeout(double.NaN).TotalMilliseconds);

    [Fact]
    public void CreateSessionTimeout_VeryLargePositive_PassesThrough() =>
        Assert.Equal(3_600_000, CreateSessionTimeout(3_600_000).TotalMilliseconds);

    [Fact]
    public void CreateSessionTimeout_TinyPositive_PassesThrough() =>
        Assert.Equal(1, CreateSessionTimeout(1).TotalMilliseconds);

    // ── UiaDefault exact boundaries ────────────────────────────────────────────────────────────────
    [Fact]
    public void UiaDefault_ExactlyAtCapBoundary()
    {
        // op = 25s → op-5s = 20000 = the cap exactly.
        Assert.Equal(20_000, UiaDefault(TimeSpan.FromSeconds(25)).TotalMilliseconds);
        // op = 25.001s → still capped at 20000.
        Assert.Equal(20_000, UiaDefault(TimeSpan.FromMilliseconds(25_001)).TotalMilliseconds);
    }

    [Fact]
    public void UiaDefault_ExactlyAtFloorBoundary()
    {
        // op = 6s → op-5s = 1000 = the floor exactly.
        Assert.Equal(1000, UiaDefault(TimeSpan.FromSeconds(6)).TotalMilliseconds);
        // op = 5.999s → below the floor → clamped to 1000.
        Assert.Equal(1000, UiaDefault(TimeSpan.FromMilliseconds(5_999)).TotalMilliseconds);
    }

    [Fact]
    public void UiaDefault_ZeroAndNegativeOpTimeout_ClampToFloor()
    {
        Assert.Equal(1000, UiaDefault(TimeSpan.Zero).TotalMilliseconds);
        Assert.Equal(1000, UiaDefault(TimeSpan.FromSeconds(-10)).TotalMilliseconds);
    }

    // ── SessionSetupTimeout equal-path + zero grace ────────────────────────────────────────────────
    [Fact]
    public void SessionSetupTimeout_EqualPaths_PicksEither()
    {
        // attach=10,root=10 → attachPath=20, launchPath=20 (equal). worst=20, +15 grace = 35.
        var d = SessionSetupTimeout(TimeSpan.FromSeconds(10), TimeSpan.FromSeconds(10));
        Assert.Equal(35_000, d.TotalMilliseconds);
    }

    [Fact]
    public void SessionSetupTimeout_ZeroGrace_NoMargin()
    {
        var d = SessionSetupTimeout(TimeSpan.FromSeconds(60), TimeSpan.FromSeconds(10), TimeSpan.Zero);
        Assert.Equal(70_000, d.TotalMilliseconds);
    }

    [Fact]
    public void SessionSetupTimeout_ZeroBudgets_IsJustGrace() =>
        Assert.Equal(15_000, SessionSetupTimeout(TimeSpan.Zero, TimeSpan.Zero).TotalMilliseconds);

    // ── ShouldSelfExit boundary + idleTimeout=0 ────────────────────────────────────────────────────
    [Fact]
    public void ShouldSelfExit_ZeroIdleTimeout_ExitsImmediatelyWhenIdleNonNegative() =>
        // With idleTimeout == 0 and idle == 0, idle >= timeout is true → would exit (the "never reap" guard
        // for idleTimeout <= 0 lives in the CALLER, not in this pure predicate). Documents that contract.
        Assert.True(ShouldSelfExit(0, TimeSpan.Zero, TimeSpan.Zero));

    [Fact]
    public void ShouldSelfExit_NegativeInFlight_TreatedAsBusy_NotEqualZero() =>
        // Defensive: only inFlight == 0 permits exit. A negative count (shouldn't happen) is != 0 → blocked.
        Assert.False(ShouldSelfExit(-1, TimeSpan.FromHours(1), TimeSpan.FromSeconds(180)));

    [Fact]
    public void ShouldSelfExit_IdleJustBelowTimeout_StaysAlive() =>
        Assert.False(ShouldSelfExit(0, TimeSpan.FromMilliseconds(179_999), TimeSpan.FromSeconds(180)));
}
