using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.RegularExpressions;

namespace FlaUiSidecar;

/// <summary>
/// FlaUI-free pure logic extracted from OpInterpreter/Program so it can be unit-tested cross-platform.
///
/// Return types are NEUTRAL (canonical enums / int / string), never FlaUI types — the exe converts a
/// <see cref="CanonicalModifier"/> to VirtualKeyShort and a <see cref="CanonicalButton"/> to MouseButton at
/// the call site. This keeps every type referenced here free of the Windows-only FlaUI dependency.
/// </summary>
public static class OpLogic
{
    // ── canonical (FlaUI-free) enums ──────────────────────────────────────────────────────────────
    public enum CanonicalModifier { Ctrl, Shift, Alt, Win }
    public enum CanonicalButton { Left, Right, Middle }

    /// <summary>Stable W3C error-type strings (the RunOp catch table maps exceptions to these).</summary>
    public static class W3C
    {
        public const string Timeout = "timeout";
        public const string UnknownError = "unknown error";
        public const string StaleElementReference = "stale element reference";
        public const string NoSuchElement = "no such element";
        public const string InvalidArgument = "invalid argument";
        public const string InvalidSelector = "invalid selector";
        public const string InvalidElementState = "invalid element state";
        /// <summary>The backend (UIA scheduler) is unrecoverable — too many poisoned worker threads. NOT a
        /// normal op error: the TS layer must treat it like a transport failure (markDead / recycle), never
        /// as a "backend still alive" RpcError. (P1-4, anti-hang layer 5.)</summary>
        public const string BackendFatal = "backend fatal";
    }

    // ── modifier parsing ──────────────────────────────────────────────────────────────────────────
    /// <summary>Map a single modifier-key name to its canonical form. Case-insensitive; accepts aliases.
    /// Unknown names throw <see cref="InvalidArgumentException"/>.</summary>
    public static CanonicalModifier ParseModifier(string name) => (name ?? string.Empty).Trim().ToLowerInvariant() switch
    {
        "ctrl" or "control" => CanonicalModifier.Ctrl,
        "shift" => CanonicalModifier.Shift,
        "alt" or "menu" => CanonicalModifier.Alt,
        "win" or "meta" or "windows" => CanonicalModifier.Win,
        _ => throw new InvalidArgumentException(
            $"invalid modifier key '{name}'. Supported values are 'ctrl', 'shift', 'alt', 'win'."),
    };

    /// <summary>Parse a sequence of modifier names (already split from an array) into canonical modifiers,
    /// skipping empty/whitespace entries.</summary>
    public static CanonicalModifier[] ParseModifiers(IEnumerable<string> names) =>
        (names ?? Enumerable.Empty<string>())
            .Where(n => !string.IsNullOrWhiteSpace(n))
            .Select(ParseModifier)
            .ToArray();

    /// <summary>Parse a comma-separated modifier string ("ctrl, shift") into canonical modifiers, dropping
    /// empty/whitespace entries.</summary>
    public static CanonicalModifier[] ParseModifiers(string commaSeparated) =>
        ParseModifiers((commaSeparated ?? string.Empty)
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));

    // ── W3C key-codepoint translation (send_keys, §17.4.2 / §12.5.3) ────────────────────────────────
    // The W3C WebDriver spec assigns the Unicode Private-Use-Area code points U+E000..U+E03D to special
    // keys (Backspace, Tab, Return, arrows, F-keys, ...). When a client sends "ab" it MUST be
    // emulated as: type 'a', press Enter, type 'b' — NOT typed as the literal PUA glyph. We model a parsed
    // input string as an ordered list of segments: a literal text RUN, or a single special KEY. The exe
    // turns each Key into a FlaUI VirtualKeyShort (see OpInterpreter.ToVirtualKey) and presses it; this file
    // stays FlaUI-free by using the neutral CanonicalKey enum.

    /// <summary>Neutral (FlaUI-free) special-key identity, mapped to a FlaUI VirtualKeyShort at the call
    /// site. Covers the W3C keys we emulate; F1..F12 carry their number in <see cref="KeySegment.FKey"/>.</summary>
    public enum CanonicalKey
    {
        Backspace, Tab, Return, Shift, Control, Alt, Escape, Space,
        PageUp, PageDown, End, Home, Left, Up, Right, Down, Delete, Insert, Function,
    }

    /// <summary>One parsed segment of a send-keys string: EITHER a literal text run (<see cref="Text"/>
    /// non-null) OR a single special key (<see cref="Key"/> non-null). Mutually exclusive.</summary>
    public readonly record struct KeySegment(string? Text, CanonicalKey? Key, int FKey = 0)
    {
        public static KeySegment Literal(string text) => new(text, null);
        public static KeySegment Special(CanonicalKey key, int fKey = 0) => new(null, key, fKey);
        public bool IsText => Text is not null;
    }

    // W3C §17.4.2 Private-Use-Area code points (subset we emulate). Two encodings exist for some keys (the
    // non-numpad "normal" range U+E000.. and the numpad range U+E03D..); we map the common ones.
    private static CanonicalKey? MapKeyCodepoint(char c, out int fKey)
    {
        fKey = 0;
        switch (c)
        {
            case '': return CanonicalKey.Backspace;
            case '': return CanonicalKey.Tab;
            case '': // ENTER
            case '': return CanonicalKey.Return; // RETURN
            case '': // SHIFT
            case '': return CanonicalKey.Shift;  // R_SHIFT
            case '': // CONTROL
            case '': return CanonicalKey.Control; // R_CONTROL
            case '': // ALT
            case '': return CanonicalKey.Alt;     // R_ALT
            case '': return CanonicalKey.Escape;
            case '': return CanonicalKey.Space;
            case '': // PAGE_UP
            case '': return CanonicalKey.PageUp;
            case '': // PAGE_DOWN
            case '': return CanonicalKey.PageDown;
            case '': // END
            case '': return CanonicalKey.End;
            case '': // HOME
            case '': return CanonicalKey.Home;
            case '': // ARROW_LEFT
            case '': return CanonicalKey.Left;
            case '': // ARROW_UP
            case '': return CanonicalKey.Up;
            case '': // ARROW_RIGHT
            case '': return CanonicalKey.Right;
            case '': // ARROW_DOWN
            case '': return CanonicalKey.Down;
            case '': // INSERT
            case '': return CanonicalKey.Insert;
            case '': // DELETE
            case '': return CanonicalKey.Delete;
        }
        // F1..F12 are a contiguous run U+E031..U+E03C.
        if (c >= '' && c <= '')
        {
            fKey = c - '' + 1; // E031 → F1 … E03C → F12
            return CanonicalKey.Function;
        }
        return null;
    }

    /// <summary>Split a send-keys input string into ordered <see cref="KeySegment"/>s: maximal literal text
    /// runs interleaved with single special keys (W3C PUA code points). NUL (U+E000), the W3C "release all"
    /// reset, is dropped (no-op). Unknown PUA code points fall through as literal text (best-effort). Pure /
    /// FlaUI-free so the exe can unit-test the mapping and just iterate the result.</summary>
    public static IReadOnlyList<KeySegment> ParseSendKeys(string? input)
    {
        var segments = new List<KeySegment>();
        if (string.IsNullOrEmpty(input)) return segments;
        var run = new System.Text.StringBuilder();
        void Flush() { if (run.Length > 0) { segments.Add(KeySegment.Literal(run.ToString())); run.Clear(); } }
        foreach (var c in input!)
        {
            if (c == '') { continue; } // NULL → release-modifiers reset; we treat as a no-op
            var key = MapKeyCodepoint(c, out var fKey);
            if (key is CanonicalKey k) { Flush(); segments.Add(KeySegment.Special(k, fKey)); }
            else run.Append(c);
        }
        Flush();
        return segments;
    }

    // ── button parsing ────────────────────────────────────────────────────────────────────────────
    /// <summary>Map a mouse-button name to canonical. null/""/"left"/"default" → Left. Case-insensitive.
    /// Unknown values throw <see cref="InvalidArgumentException"/>.</summary>
    public static CanonicalButton ParseButton(string? name) => (name?.Trim().ToLowerInvariant()) switch
    {
        "right" => CanonicalButton.Right,
        "middle" => CanonicalButton.Middle,
        null or "" or "left" or "default" => CanonicalButton.Left,
        _ => throw new InvalidArgumentException(
            $"invalid button '{name}'. Supported values are 'left', 'middle', 'right'."),
    };

    // ── condition-value parsing (BuildProperty) ─────────────────────────────────────────────────────
    // Malformed condition values are USER errors: wrap the raw FormatException/OverflowException/
    // ArgumentException from the BCL parsers as InvalidArgumentException ("invalid argument") instead of
    // letting them fall through to "unknown error".

    /// <summary>Parse a bool condition value; malformed → InvalidArgumentException.</summary>
    public static bool ParseBool(string raw)
    {
        if (bool.TryParse((raw ?? string.Empty).Trim(), out var b)) return b;
        throw new InvalidArgumentException($"expected a boolean value but got '{raw}'.");
    }

    /// <summary>Parse an int condition value; malformed/overflow → InvalidArgumentException.</summary>
    public static int ParseInt(string raw)
    {
        if (int.TryParse((raw ?? string.Empty).Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var i))
            return i;
        throw new InvalidArgumentException($"expected an integer value but got '{raw}'.");
    }

    /// <summary>Parse a RuntimeId string ("1.2.3") into ints; any malformed segment → InvalidArgumentException.</summary>
    public static int[] ParseRuntimeId(string raw) =>
        (raw ?? string.Empty).Split('.').Select(ParseInt).ToArray();

    /// <summary>Parse an enum condition value (case-insensitive); unknown → InvalidArgumentException with the
    /// list of valid names. Generic so the exe can pass a FlaUI enum (e.g. ControlType) — TEnum itself is a
    /// plain CLR enum, no FlaUI dependency enters this file.</summary>
    public static TEnum ParseEnum<TEnum>(string raw) where TEnum : struct, Enum
    {
        if (Enum.TryParse<TEnum>((raw ?? string.Empty).Trim(), ignoreCase: true, out var v)
            && Enum.IsDefined(typeof(TEnum), v))
            return v;
        throw new InvalidArgumentException(
            $"'{raw}' is not a valid {typeof(TEnum).Name}. Valid values: {string.Join(", ", Enum.GetNames(typeof(TEnum)))}.");
    }

    // ── editability predicate (Element Clear / replace, W3C §12.5.2) ────────────────────────────────
    /// <summary>Control types that are inherently text-input editors even when their pattern set looks bare
    /// (some custom RichEdit/Document controls expose neither a writable ValuePattern nor a settable
    /// TextPattern through UIA but ARE editable via keystrokes). Programmatic ControlType names.</summary>
    private static readonly HashSet<string> TextInputControlTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        "Edit", "Document", "ComboBox",
    };

    /// <summary>Decide whether an element is editable for the purpose of Element Clear / value-replace
    /// (W3C §12.5.2: a non-editable element must error with "invalid element state", NOT have destructive
    /// keystrokes sent to it). FlaUI-free: the caller passes pattern-availability booleans and the
    /// programmatic ControlType name so this is unit-testable.
    /// <para>Treated as EDITABLE (conservative — must not break real editors) when ANY of:
    /// <list type="bullet">
    /// <item>a writable ValuePattern (the canonical settable text control);</item>
    /// <item>an editable TextPattern (a focusable text control whose content is set via keystrokes, e.g. some
    /// RichEdit/Document editors that expose a read-only or no ValuePattern);</item>
    /// <item>a text-input ControlType (Edit/Document/ComboBox) — covers controls that under-report patterns.</item>
    /// </list>
    /// Treated as NON-editable (→ throw) ONLY when none of the above hold (e.g. Window/Pane/Button).</para></summary>
    public static bool IsEditable(bool hasWritableValuePattern, bool hasEditableTextPattern, string? controlTypeName) =>
        hasWritableValuePattern
        || hasEditableTextPattern
        || (controlTypeName is not null && TextInputControlTypes.Contains(controlTypeName));

    /// <summary>Try to parse an enum value (case-insensitive) WITHOUT throwing. Returns false for an
    /// unrecognized name. Used by the <c>tag name</c> / ControlType condition build (W3C bug #8): a
    /// syntactically valid locator naming a control type that doesn't exist must be a NON-MATCH (Find Elements
    /// → 200 [], Find Element → "no such element"), never an "invalid argument" 400. FlaUI-free: TEnum is a
    /// plain CLR enum.</summary>
    public static bool TryParseEnum<TEnum>(string? raw, out TEnum value) where TEnum : struct, Enum
    {
        if (Enum.TryParse<TEnum>((raw ?? string.Empty).Trim(), ignoreCase: true, out value)
            && Enum.IsDefined(typeof(TEnum), value))
            return true;
        value = default;
        return false;
    }

    // ── stale-runtime-id detection ──────────────────────────────────────────────────────────────────
    private static readonly Regex RuntimeIdRegex = new(@"^\d+(\.\d+)*$", RegexOptions.Compiled);

    /// <summary>True when an id is shaped like a UIA RuntimeId (dot-joined ints). A well-formed-but-unknown
    /// id is treated as STALE (it aged out); anything else is "no such element".</summary>
    public static bool LooksLikeRuntimeId(string id) =>
        !string.IsNullOrEmpty(id) && RuntimeIdRegex.IsMatch(id);

    // ── HWND hex parsing ────────────────────────────────────────────────────────────────────────────
    /// <summary>Parse an appTopLevelWindow HWND: hex with or without a 0x/0X prefix, any case. Returns false
    /// (without throwing) for malformed input — the caller raises InvalidArgumentException.</summary>
    public static bool TryParseHwnd(string? hex, out long value)
    {
        value = 0;
        if (string.IsNullOrWhiteSpace(hex)) return false;
        var raw = hex.Trim();
        if (raw.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) raw = raw[2..];
        if (raw.Length == 0) return false;
        return long.TryParse(raw, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out value);
    }

    // ── attach-target matching (appName window-title regex / processName) ────────────────────────────
    /// <summary>Compile an appName window-title pattern as a case-insensitive, UNANCHORED regex. A malformed
    /// pattern is a USER error → <see cref="InvalidArgumentException"/> ("invalid argument"), not an opaque
    /// unknown error. The compiled regex is matched against each top-level window's Name (title) with
    /// <see cref="Regex.IsMatch(string)"/>, so any substring match counts.</summary>
    public static Regex CompileAppNameRegex(string pattern)
    {
        try { return new Regex(pattern ?? string.Empty, RegexOptions.IgnoreCase); }
        catch (ArgumentException ex)
        {
            throw new InvalidArgumentException($"appName is not a valid regular expression: '{pattern}' ({ex.Message})");
        }
    }

    /// <summary>True when a window title matches the appName pattern: case-insensitive, unanchored
    /// (substring) match. A null title never matches.</summary>
    public static bool MatchesAppName(Regex pattern, string? windowTitle) =>
        windowTitle is not null && pattern.IsMatch(windowTitle);

    /// <summary>Normalize a processName cap to a bare executable name for an exact, case-insensitive match:
    /// trims whitespace and strips a single trailing ".exe" (case-insensitive). Returns "" for null/blank
    /// input. Note this is EXACT-name normalization (unlike <c>FindPidByExe</c>, which also accepts a path).</summary>
    public static string NormalizeProcessName(string? processName)
    {
        var s = (processName ?? string.Empty).Trim();
        if (s.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) s = s[..^4];
        return s;
    }

    /// <summary>Read createSessionTimeout (ms) from raw caps value handling: a positive number is the poll
    /// budget for an attach target to appear; null/non-number/non-positive falls back to the default
    /// (60000ms). Pure helper so the parsing is unit-testable without JSON plumbing.</summary>
    public static TimeSpan CreateSessionTimeout(double? rawMs, double defaultMs = 60_000) =>
        TimeSpan.FromMilliseconds(rawMs is double v && v > 0 ? v : defaultMs);

    // ── UIA nested-timeout default ──────────────────────────────────────────────────────────────────
    /// <summary>UIA connection/transaction default: Max(1000ms, Min(20000ms, opTimeout-5000ms)). Sits just
    /// below the op watchdog so a frozen provider's COM call self-aborts before the watchdog must poison the
    /// worker. Invariant: result ≤ opTimeout-5s whenever opTimeout-5s ≥ 1000ms.</summary>
    public static TimeSpan UiaDefault(TimeSpan opTimeout) =>
        TimeSpan.FromMilliseconds(Math.Max(1000, Math.Min(20_000, opTimeout.TotalMilliseconds - 5_000)));

    // ── /session watchdog budget (P0-1) ──────────────────────────────────────────────────────────────
    /// <summary>Watchdog timeout for the WHOLE /session setup, which legitimately runs far longer than a
    /// per-op (the attach poll can take <c>attachBudget</c>, and each resolve may wait <c>rootWait</c> for
    /// the top-level window to surface). The default 30s per-op watchdog is far too short and would poison
    /// the worker on a slow attach/launch. Worst case is the larger of the attach path
    /// (<c>attachBudget + rootWait</c>) and the launch path (<c>2·rootWait</c> — initial resolve plus the
    /// single-instance hand-off retry), plus a grace margin. Pure so it is unit-testable cross-platform.</summary>
    public static TimeSpan SessionSetupTimeout(TimeSpan attachBudget, TimeSpan rootWait, TimeSpan? grace = null)
    {
        var attachPath = attachBudget + rootWait;
        var launchPath = rootWait + rootWait;
        var worst = attachPath > launchPath ? attachPath : launchPath;
        return worst + (grace ?? TimeSpan.FromSeconds(15));
    }

    // ── orphan-guard self-exit decision (P0-2) ───────────────────────────────────────────────────────
    /// <summary>The idle/orphan guard may self-exit ONLY when no request is in flight AND the sidecar has
    /// been idle at least <c>idleTimeout</c>. A positive in-flight count means a long op is still running,
    /// so the exit is blocked regardless of idle — a long op (e.g. a heavy prerun, or operationTimeout >
    /// idleTimeout) is never cut mid-flight. (idleTimeout ≤ 0 = "never reap" is handled by the caller.)</summary>
    public static bool ShouldSelfExit(int inFlight, TimeSpan idle, TimeSpan idleTimeout) =>
        inFlight == 0 && idle >= idleTimeout;

    // ── error → W3C classifier ──────────────────────────────────────────────────────────────────────
    /// <summary>Pure exception-TYPE → W3C error-type mapping (the testable form of RunOp's catch table).
    /// Classifies by runtime type-name string so this stays FlaUI-free even though some of the custom
    /// exception types live in FlaUI-importing files. Order mirrors RunOp: specific subtypes before the
    /// ArgumentException base, with an unknown-error fallback.</summary>
    public static string ClassifyError(Exception ex)
    {
        for (var t = ex.GetType(); t is not null; t = t.BaseType)
        {
            switch (t.Name)
            {
                case nameof(TimeoutException): return W3C.Timeout;
                case "SchedulerFatalException": return W3C.BackendFatal;
                case "StaleElementException": return W3C.StaleElementReference;
                case "ElementNotFoundException": return W3C.NoSuchElement;
                case "InvalidElementStateException": return W3C.InvalidElementState;
                case "InvalidArgumentException": return W3C.InvalidArgument;
                case nameof(ArgumentException): return W3C.InvalidSelector;
            }
        }
        return W3C.UnknownError;
    }

    // ── point / rect math ───────────────────────────────────────────────────────────────────────────
    /// <summary>Plain integer rectangle (FlaUI-free stand-in for a UIA BoundingRectangle).</summary>
    public readonly record struct IntRect(int X, int Y, int Width, int Height);

    public readonly record struct IntPoint(int X, int Y);

    /// <summary>Integer center of a rect: (x + width/2, y + height/2) with truncating division (matches the
    /// exe's r.X + r.Width / 2 behavior, so odd dimensions round toward the top-left).</summary>
    public static IntPoint Center(IntRect r) => new(r.X + r.Width / 2, r.Y + r.Height / 2);

    /// <summary>A point at the rect's top-left plus an explicit (dx, dy) offset — the documented offset semantics.</summary>
    public static IntPoint OffsetFrom(IntRect r, int dx, int dy) => new(r.X + dx, r.Y + dy);

    // ── scroll delta resolution (P2-7b) ───────────────────────────────────────────────────────────
    /// <summary>Resolve a wheel scroll into (dx, dy) notches from the optional {deltaX, deltaY, amount} args.
    /// <list type="bullet">
    /// <item>When deltaX/deltaY are given, <c>amount</c> (default 1) MULTIPLIES them — a convenience scale.</item>
    /// <item>When NEITHER delta is given, <c>amount</c> is taken as a VERTICAL scroll of that many notches
    /// (so <c>{amount}</c> alone scrolls instead of silently no-op'ing). Sign = direction (FlaUI wheel
    /// convention: positive scrolls up, negative down). Missing amount here → no scroll.</item>
    /// </list></summary>
    public static (double dx, double dy) ScrollDelta(double? deltaX, double? deltaY, double? amount)
    {
        if (deltaX is null && deltaY is null)
            return (0, amount ?? 0);           // amount-only → vertical notches (was a silent 0 no-op)
        var scale = amount ?? 1;               // deltas given → amount multiplies them
        return ((deltaX ?? 0) * scale, (deltaY ?? 0) * scale);
    }

    // ── drag interpolation (P2-7d) ────────────────────────────────────────────────────────────────
    /// <summary>Interpolated pointer path from <c>(fromX,fromY)</c> to <c>(toX,toY)</c> for a timed drag, so a
    /// DnD target that samples pointer velocity sees gradual movement instead of an instant jump. Splits the
    /// duration into ~<paramref name="stepMs"/> steps; the LAST point is always exactly the destination. A
    /// non-positive duration yields a single step (the destination). Pure so it is unit-testable.</summary>
    public static IReadOnlyList<IntPoint> DragPath(int fromX, int fromY, int toX, int toY,
        double durationMs, double stepMs = 15)
    {
        var steps = durationMs <= 0 ? 1 : Math.Max(1, (int)Math.Round(durationMs / Math.Max(1, stepMs)));
        var pts = new List<IntPoint>(steps);
        for (var i = 1; i <= steps; i++)
        {
            var t = (double)i / steps;
            pts.Add(new IntPoint(
                (int)Math.Round(fromX + (toX - fromX) * t),
                (int)Math.Round(fromY + (toY - fromY) * t)));
        }
        return pts;
    }

    // ── page-source XML sanitization (P2-8) ───────────────────────────────────────────────────────
    /// <summary>Strip characters that are illegal in XML 1.0 from a text/attribute value, so a legacy Win32
    /// app's control characters (0x00–0x08, 0x0B, 0x0C, 0x0E–0x1F, lone surrogates) can't make
    /// <c>XmlWriter</c> throw and blow up the whole <c>page_source</c>. Tab/LF/CR and valid surrogate PAIRS
    /// (real supplementary code points, e.g. emoji) are preserved. Pure so it is unit-testable.</summary>
    public static string SanitizeXmlText(string? s)
    {
        if (string.IsNullOrEmpty(s)) return s ?? string.Empty;
        if (IsAllLegalXml(s)) return s;                 // fast path: nothing to strip
        var sb = new System.Text.StringBuilder(s.Length);
        for (var i = 0; i < s.Length; i++)
        {
            var c = s[i];
            if (char.IsHighSurrogate(c) && i + 1 < s.Length && char.IsLowSurrogate(s[i + 1]))
            {
                sb.Append(c).Append(s[i + 1]);          // valid pair → always legal XML
                i++;
            }
            else if (IsLegalXmlChar(c))
            {
                sb.Append(c);
            }
            // else: illegal control char or lone surrogate → drop
        }
        return sb.ToString();
    }

    private static bool IsAllLegalXml(string s)
    {
        for (var i = 0; i < s.Length; i++)
        {
            var c = s[i];
            if (char.IsHighSurrogate(c) && i + 1 < s.Length && char.IsLowSurrogate(s[i + 1])) { i++; continue; }
            if (!IsLegalXmlChar(c)) return false;
        }
        return true;
    }

    // XML 1.0 Char production (excluding surrogate halves, handled as pairs by the callers above).
    private static bool IsLegalXmlChar(char c) =>
        c == '\t' || c == '\n' || c == '\r' ||
        ((int)c >= 0x20 && (int)c <= 0xD7FF) ||
        ((int)c >= 0xE000 && (int)c <= 0xFFFD);
}
