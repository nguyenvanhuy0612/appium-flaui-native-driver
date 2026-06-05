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
                case "SchedulerFatalException": return W3C.UnknownError;
                case "StaleElementException": return W3C.StaleElementReference;
                case "ElementNotFoundException": return W3C.NoSuchElement;
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
}
