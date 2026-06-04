# Attribute parity check — Start button (.44)

*Archived — frozen historical snapshot. Kept for reference; links may point to docs that have since moved.*

Element: taskbar **Start** button — `Name="Start"`, `ControlType=Button`, `ClassName="Start"`,
`RuntimeId [2A.1009A]` (= `42.65690` decimal), `NativeWindowHandle 0x1009A`. Source of truth:
`inspect.exe` dump (`inspect.startbtn.md`). Driver: `windows: getAttributes` + per-name `getAttribute`.

This concretely scopes **Phase A** (full property resolution) and surfaced 2 real defects. Implementation
will be **FlaUI-idiomatic** (strongly-typed `el.Patterns.<X>` / `el.Properties`), not a PowerShell port.

## ✅ Driver matches inspect (direct UIA properties)

Name, ControlType (Button), LocalizedControlType (button), IsEnabled, IsOffscreen, IsKeyboardFocusable,
HasKeyboardFocus, AccessKey, ProcessId (4936), FrameworkId (Win32), ClassName (Start), NativeWindowHandle
(0x1009A), IsPassword, HelpText, RuntimeId (same value). Driver also exposes extra direct props inspect
doesn't list (AutomationId, IsContent/ControlElement, IsRequiredForForm, ItemStatus, ItemType, Orientation).

## ⚠️ Defects found

1. **`getAttribute("BoundingRectangle")` returns `"[object Object]"`** — string-coercion bug. Inspect shows
   `{l:0 t:928 r:36 b:958}`. Must return a structured rect (or `l,t,r,b`/`x,y,w,h` string). _Also: the
   `all` dump omits BoundingRectangle/NativeWindowHandle/Value entirely — they're only reachable via the
   per-name path. Unify so `getAttributes` returns everything reachable._
2. **RuntimeId representation differs** — driver `42.65690` (decimal) vs inspect `[2A.1009A]` (hex). Same
   value; not a bug, but document it (decimal is what our element ids use). Optionally offer the hex form.

## ❌ Missing in driver (return HTTP 400 "unknown attribute") — Phase A scope

| inspect property | inspect value (Start) | FlaUI-idiomatic source to implement |
|---|---|---|
| `LegacyIAccessible.Name` | "Start" | `el.Patterns.LegacyIAccessible.PatternOrDefault?.Name` |
| `LegacyIAccessible.Value` | "" | `…?.Value` |
| `LegacyIAccessible.Role` | push button (0x2B) | `…?.Role` (map enum → text + hex like inspect) |
| `LegacyIAccessible.State` | focusable (0x100000) | `…?.State` (flags → text + hex) |
| `LegacyIAccessible.DefaultAction` | "Press" | `…?.DefaultAction` |
| `LegacyIAccessible.Description/Help/KeyboardShortcut/ChildId` | "" / "" / "" / 0 | `…?.Description` etc. |
| `Is<Pattern>PatternAvailable` (×~37) | Invoke=true, LegacyIAccessible=true, rest false | `el.Patterns.<X>.IsSupported` (enumerate all FlaUI patterns) |
| pattern dot-notation (`Value.Value`, `Toggle.ToggleState`, `Window.CanMaximize`, …) | — | `el.Patterns.<X>.PatternOrDefault?.<Prop>` |
| `ProviderDescription` | "[pid:…]" | `el.Properties.ProviderDescription` |
| `IsDialog` | false | `el.Properties.IsDialog` |

## Phase A plan (getProperty/getAttribute) — FlaUI way

1. **Pattern-availability flags**: enumerate FlaUI's pattern table and emit `Is<Name>PatternAvailable` from
   each `.IsSupported` — one generic loop (vs nova2's per-prop PowerShell).
2. **LegacyIAccessible.* + `legacy*` aliases + UIA-empty→Legacy fallback** via `el.Patterns.LegacyIAccessible`.
3. **Pattern dot-notation** (`<Pattern>.<Prop>`) via `el.Patterns.<X>.PatternOrDefault` reflection/typed map.
4. **Direct props** incl. `ProviderDescription`, `IsDialog`, `BoundingRectangle` (fix formatting), and make
   the `all` dump return the full reachable set, with inspect-consistent value formatting (bool "True"/
   "False", enums "text (0xHEX)", rect as `{x,y,width,height}`/`l,t,r,b`).
5. Unit-test the resolver (fake element) + Windows E2E diffing against this inspect dump for the Start button.

---

## ✅ RESOLVED (Phase A, 2026-06-03)

Implemented FlaUI-native in `sidecar/PropertyResolver.cs`. Re-dumped the Start button on .44: **every inspect
property now matches** (LegacyIAccessible.* incl. Role "push button (0x2B)" / State "focusable (0x100000)" /
DefaultAction "Press"; Is*PatternAvailable flags; ProviderDescription; IsDialog=false; BoundingRectangle
`{x:0,y:928,width:36,height:30}`). `Value.Value` dot-notation verified on a Notepad Edit. RuntimeId stays
decimal by design. Both defects fixed (BoundingRectangle formatting; `all` dump completeness). Not published.
