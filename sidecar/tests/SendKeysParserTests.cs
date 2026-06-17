using FlaUiSidecar;
using Xunit;
using static FlaUiSidecar.OpLogic;

namespace FlaUiSidecar.Tests;

/// <summary>
/// Unit tests for <see cref="OpLogic.ParseSendKeys"/> (W3C §17.4.2 / §12.5.3 key-codepoint translation).
/// Confirmed-broken bug #1: a send_keys string containing the PUA key code points (e.g. Enter = U+E007)
/// was typed as the literal glyph instead of being emulated as a key press. The parser must split the
/// input into literal text RUNS interleaved with single special KEYS so the exe can press the keys.
/// Pure / FlaUI-free.
/// </summary>
public class SendKeysParserTests
{
    // W3C PUA code points (subset) as named consts for readability.
    private const char Backspace = '';
    private const char Tab       = '';
    private const char Return    = '';
    private const char Enter     = '';
    private const char Shift     = '';
    private const char Control   = '';
    private const char Alt       = '';
    private const char Escape    = '';
    private const char Space     = '';
    private const char PageUp    = '';
    private const char PageDown  = '';
    private const char End       = '';
    private const char Home      = '';
    private const char Left      = '';
    private const char Up        = '';
    private const char Right     = '';
    private const char Down      = '';
    private const char Insert    = '';
    private const char Delete    = '';
    private const char Null      = '';
    private const char F1        = '';
    private const char F5        = '';
    private const char F12       = '';
    private const char ShiftR    = ''; // numpad/right-hand encoding

    [Fact]
    public void Empty_And_Null_Yield_NoSegments()
    {
        Assert.Empty(ParseSendKeys(null));
        Assert.Empty(ParseSendKeys(""));
    }

    [Fact]
    public void PlainText_IsASingleLiteralRun()
    {
        var segs = ParseSendKeys("hello");
        var s = Assert.Single(segs);
        Assert.True(s.IsText);
        Assert.Equal("hello", s.Text);
    }

    [Fact]
    public void EnterCodepoint_Becomes_A_ReturnKey_NotLiteral()
    {
        // The regression: "a" + Enter + "b" must be [text "a", key Return, text "b"], never the glyph.
        var segs = ParseSendKeys("a" + Enter + "b");
        Assert.Collection(segs,
            x => { Assert.True(x.IsText); Assert.Equal("a", x.Text); },
            x => { Assert.False(x.IsText); Assert.Equal(CanonicalKey.Return, x.Key); },
            x => { Assert.True(x.IsText); Assert.Equal("b", x.Text); });
        // And NO segment carries the raw PUA glyph as text.
        Assert.DoesNotContain(segs, x => x.IsText && x.Text!.Contains(''));
    }

    [Fact]
    public void LeadingAndTrailingKeys_AreSeparateSegments()
    {
        var segs = ParseSendKeys(Tab.ToString() + "x" + Backspace);
        Assert.Collection(segs,
            x => Assert.Equal(CanonicalKey.Tab, x.Key),
            x => Assert.Equal("x", x.Text),
            x => Assert.Equal(CanonicalKey.Backspace, x.Key));
    }

    [Fact]
    public void ConsecutiveKeys_DoNotMergeIntoText()
    {
        var segs = ParseSendKeys(Control.ToString() + Shift + Home);
        Assert.Collection(segs,
            x => Assert.Equal(CanonicalKey.Control, x.Key),
            x => Assert.Equal(CanonicalKey.Shift, x.Key),
            x => Assert.Equal(CanonicalKey.Home, x.Key));
    }

    [Theory]
    [InlineData(Backspace, CanonicalKey.Backspace)]
    [InlineData(Tab, CanonicalKey.Tab)]
    [InlineData(Return, CanonicalKey.Return)]
    [InlineData(Enter, CanonicalKey.Return)]
    [InlineData(Shift, CanonicalKey.Shift)]
    [InlineData(ShiftR, CanonicalKey.Shift)]
    [InlineData(Control, CanonicalKey.Control)]
    [InlineData(Alt, CanonicalKey.Alt)]
    [InlineData(Escape, CanonicalKey.Escape)]
    [InlineData(Space, CanonicalKey.Space)]
    [InlineData(PageUp, CanonicalKey.PageUp)]
    [InlineData(PageDown, CanonicalKey.PageDown)]
    [InlineData(End, CanonicalKey.End)]
    [InlineData(Home, CanonicalKey.Home)]
    [InlineData(Left, CanonicalKey.Left)]
    [InlineData(Up, CanonicalKey.Up)]
    [InlineData(Right, CanonicalKey.Right)]
    [InlineData(Down, CanonicalKey.Down)]
    [InlineData(Insert, CanonicalKey.Insert)]
    [InlineData(Delete, CanonicalKey.Delete)]
    public void EachSpecialCodepoint_MapsToItsKey(char codepoint, CanonicalKey expected)
    {
        var s = Assert.Single(ParseSendKeys(codepoint.ToString()));
        Assert.False(s.IsText);
        Assert.Equal(expected, s.Key);
    }

    [Theory]
    [InlineData(F1, 1)]
    [InlineData(F5, 5)]
    [InlineData(F12, 12)]
    public void FunctionKeys_CarryTheirNumber(char codepoint, int fNum)
    {
        var s = Assert.Single(ParseSendKeys(codepoint.ToString()));
        Assert.Equal(CanonicalKey.Function, s.Key);
        Assert.Equal(fNum, s.FKey);
    }

    [Fact]
    public void NullCodepoint_IsDropped_AsNoOp()
    {
        // U+E000 (NULL = "release all") is ignored — it must not appear as text nor as a key.
        var segs = ParseSendKeys("a" + Null + "b");
        var s = Assert.Single(segs);
        Assert.Equal("ab", s.Text);
    }

    [Fact]
    public void UnknownPuaCodepoint_FallsThroughAsLiteral()
    {
        // A PUA code point we don't emulate (e.g. U+E0FF) is best-effort kept as literal text.
        var segs = ParseSendKeys("ab");
        var s = Assert.Single(segs);
        Assert.True(s.IsText);
        Assert.Equal("ab", s.Text);
    }
}
