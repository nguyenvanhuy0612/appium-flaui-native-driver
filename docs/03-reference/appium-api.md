# Appium API Reference

The complete command surface of the **appium-flaui-native-driver** (Appium 3, `automationName=FlaUINative`): every W3C WebDriver endpoint it implements and every `windows:` extension command, with the backend op each maps to and a verification status. This is a coverage map, not a tutorial — for wire-level op shapes (envelope, action labels, input kinds, error types) see [./rpc-protocol.md](./rpc-protocol.md), for locator/XPath detail see [./locators-xpath.md](./locators-xpath.md), and for session capabilities see [./capabilities.md](./capabilities.md).

> **Authority order** when sources disagree: the **code** (`lib/driver.ts`, `lib/commands/extensions.ts`, `lib/backend/ops.ts`) wins over anything in `reference/`, which in turn wins over `decisions/` (ADRs). This file is derived from the code as of the latest build.

**Status legend:** ✅ verified on real Windows · 🟡 implemented, not individually verified · ⬜ stub / accepted no-op.

---

## Standard W3C commands

All endpoints are rooted at `/session/:id` unless shown otherwise. The **Backend op** column names the sidecar op (envelope detail in [rpc-protocol.md](./rpc-protocol.md)).

### Session

| Command | HTTP endpoint | Description | Backend op | Status |
|---|---|---|---|---|
| createSession | `POST /session` | Start sidecar, open backend session, launch/attach app | `session` | ✅ |
| deleteSession | `DELETE /session/:id` | Close app per `shouldCloseApp`, stop sidecar | `deleteSession` | ✅ |

### Find

Single, multi, and from-context (from-element) all dispatch through one `findElOrEls`. Non-XPath strategies map to a UIA property condition; XPath runs in the TS engine.

| Command | HTTP endpoint | Description | Backend op | Status |
|---|---|---|---|---|
| findElOrEls (single) | `POST /element` | Find first matching element | `find` (scope `subtree`) | ✅ |
| findElOrEls (multi) | `POST /elements` | Find all matching elements | `find` (scope `subtree`) | ✅ |
| findElOrEls (from-context) | `POST /element/:id/element(s)` | Find within a context element | `find` (start = context id) | ✅ |

**Locator strategies** (5 native + XPath):

| Strategy | Resolves against | Backend op | Status |
|---|---|---|---|
| `accessibility id` | UIA `AutomationId` | `find` property condition | ✅ |
| `id` | UIA `AutomationId` (alias) | `find` property condition | ✅ |
| `name` | UIA `Name` | `find` property condition | ✅ |
| `class name` | UIA `ClassName` | `find` property condition | ✅ |
| `tag name` | UIA `ControlType` (e.g. `Button`) | `find` property condition | ✅ |
| `xpath` | XPath 1.0 — see [./locators-xpath.md](./locators-xpath.md) | `find` + `walk` + `attributes` | ✅ |

### State / attributes

| Command | HTTP endpoint | Description | Backend op | Status |
|---|---|---|---|---|
| getAttribute | `GET /element/:id/attribute/:name` | UIA prop / pattern dot-notation / `Legacy*` / `all` → JSON string | `attributes` | ✅ |
| getProperty | `GET /element/:id/property/:name` | Alias of getAttribute | `attributes` | ✅ |
| getText | `GET /element/:id/text` | Synthetic `Text`: TextPattern → Value → Name → Legacy | `attributes` (`['Text']`) | ✅ |
| getName | `GET /element/:id/name` | Tag name (`ControlType`) | `attributes` (`['ControlType']`) | ✅ |
| getElementRect | `GET /element/:id/rect` | `BoundingRectangle` `{x,y,width,height}` | `attributes` | ✅ |
| elementEnabled | `GET /element/:id/enabled` | `IsEnabled` | `attributes` | ✅ |
| elementDisplayed | `GET /element/:id/displayed` | `IsOffscreen` inverted | `attributes` | ✅ |
| elementSelected | `GET /element/:id/selected` | `IsSelected` (SelectionItem) | `attributes` | ✅ |

### Interaction

| Command | HTTP endpoint | Description | Backend op | Status |
|---|---|---|---|---|
| click | `POST /element/:id/click` | Real pointer click at element center | `input` (kind `click`) | ✅ |
| setValue | `POST /element/:id/value` | ValuePattern.SetValue | `action` (`setValue`) | ✅ |
| clear | `POST /element/:id/clear` | setValue with empty string | `action` (`setValue`, `value:''`) | ✅ |

### Document

| Command | HTTP endpoint | Description | Backend op | Status |
|---|---|---|---|---|
| getPageSource | `GET /source` | Nested XML, full UIA attribute schema, live traversal | `source` (start `root`) | ✅ |

### Screenshots

| Command | HTTP endpoint | Description | Backend op | Status |
|---|---|---|---|---|
| getScreenshot | `GET /screenshot` | Whole-screen PNG (base64) | `screenshot` | ✅ |
| getElementScreenshot | `GET /element/:id/screenshot` | Element PNG (base64) | `screenshot` (with `id`) | ✅ |

### Window

All operate on the session root window.

| Command | HTTP endpoint | Description | Backend op | Status |
|---|---|---|---|---|
| title | `GET /title` | Root window title | `window` (`title`) | ✅ |
| getTitle | — (alias) | Internal/nova2 alias of `title` | `window` (`title`) | ✅ |
| getWindowHandle | `GET /window` | Current window handle | `window` (`handle`) | ✅ |
| getWindowHandles | `GET /window/handles` | Single-element list of the handle | `window` (`handle`) | ✅ |
| getWindowRect | `GET /window/rect` | Window rect | `window` (`rect`) | ✅ |
| setWindowRect | `POST /window/rect` | Move/resize (TransformPattern) | `window` (`setRect`) | ✅ |
| maximizeWindow | `POST /window/maximize` | Maximize | `window` (`maximize`) | ✅ |
| minimizeWindow | `POST /window/minimize` | Minimize | `window` (`minimize`) | ✅ |

### Actions (W3C)

| Command | HTTP endpoint | Description | Backend op | Status |
|---|---|---|---|---|
| performActions | `POST /actions` | Pointer (move/down/up) + key + pause; viewport/pointer/element origins | `input` (`move`/`down`/`up`/`keys`) | ✅ |
| releaseActions | `DELETE /actions` | No persistent pressed state held (subset) | — | ✅ |

### File transfer (insecure, gated)

Each requires its scoped insecure feature or fails loud (`assertFeatureEnabled`). No path sandbox.

| Command | HTTP endpoint | Description | Backend op | Status |
|---|---|---|---|---|
| pullFile | `POST /appium/device/pull_file` | Read any absolute path → base64 (`flauinative:pull_file`) | `file` (`pull`) | ✅ |
| pushFile | `POST /appium/device/push_file` | Write base64 to any absolute path (`flauinative:push_file`) | `file` (`push`) | ✅ |
| pullFolder | `POST /appium/device/pull_folder` | Folder → ZIP → base64 (`flauinative:pull_file`) | `file` (`pullFolder`) | ✅ |

---

## `windows:` extension commands

Invoked via the W3C execute endpoint: `driver.execute('windows: <name>', [args])` (`POST /execute/sync`). Element args accept `{elementId}` or the W3C element object key. Backend op shapes (action labels, input kinds/args, error types) are in [rpc-protocol.md](./rpc-protocol.md).

### Element / pattern (19)

These route through `runWindowsAction` → `action` op with the action label shown.

| Command | Params (required / optional) | Backend op + action | Status |
|---|---|---|---|
| invoke | el | `action` `invoke` | 🟡 |
| toggle | el | `action` `toggle` | 🟡 |
| expand | el | `action` `expand` | 🟡 |
| collapse | el | `action` `collapse` | 🟡 |
| select | el | `action` `select` | 🟡 |
| addToSelection | el | `action` `addToSelection` | 🟡 |
| removeFromSelection | el | `action` `removeFromSelection` | 🟡 |
| setFocus | el | `action` `setFocus` | 🟡 |
| scrollIntoView | el | `action` `scrollIntoView` | 🟡 |
| setValue | el / `value` | `action` `setValue` | ✅ |
| maximize | el | `action` `maximize` | 🟡 |
| minimize | el | `action` `minimize` | 🟡 |
| restore | el | `action` `restore` | 🟡 |
| close | el | `action` `close` | 🟡 |
| getValue | el | `action` `getValue` | ✅ |
| isMultiple | el | `action` `isMultiple` | 🟡 |
| selectedItem | el | `action` `selectedItem` | 🟡 |
| allSelectedItems | el | `action` `allSelectedItems` | 🟡 |
| getAttributes | el | `action` `getAttributes` (all UIA props as object) | 🟡 |

("el" = element reference: `elementId` or the W3C element key, required.)

### Real input (5)

Mouse/keyboard via FlaUI.Core.Input (SendInput). Optional param names are exact, from `INPUT_COMMANDS` in `lib/commands/extensions.ts`.

| Command | Params (required / optional) | Backend op + kind | Status |
|---|---|---|---|
| click | — / `elementId`, `x`, `y`, `button`, `times`, `modifierKeys`, `durationMs`, `interClickDelayMs`, `bringToFront` | `input` kind `click` | ✅ |
| hover | — / `elementId`, `x`, `y`, `modifierKeys`, `durationMs`, `bringToFront` | `input` kind `hover` | ✅ |
| scroll | — / `elementId`, `x`, `y`, `deltaX`, `deltaY`, `amount`, `modifierKeys`, `bringToFront` | `input` kind `scroll` | ✅ |
| keys | `actions` / — | `input` kind `keys` | ✅ |
| clickAndDrag | — / `startElementId`, `startX`, `startY`, `endElementId`, `endX`, `endY`, `button`, `durationMs`, `modifierKeys`, `bringToFront` | `input` kind `clickAndDrag` | 🟡 |

### Clipboard (2)

| Command | Params (required / optional) | Backend op | Status |
|---|---|---|---|
| setClipboard | — / `b64`, `b64Content`, `contentType` | `clipboard` (`set`) — plaintext & image | ✅ |
| getClipboard | — / `contentType` | `clipboard` (`get`) → base64 | ✅ |

### App / window (4)

| Command | Params (required / optional) | Backend op | Status |
|---|---|---|---|
| launchApp | — / — | `app` (`launch`) — re-roots session | 🟡 |
| closeApp | — / — | `app` (`close`) | 🟡 |
| setProcessForeground | `process` / — | `app` (`activate`) by process name | 🟡 |
| setWindowForeground | — / `elementId`, W3C element key | `window` (`foreground`) — Win32 escalating focus | ✅ |

### Source / cache / misc (3)

| Command | Params (required / optional) | Backend op | Status |
|---|---|---|---|
| getPageSource | — / `elementId` | `source` (element-scoped; defaults to `root`) | 🟡 |
| cacheRequest | — / `treeScope`, `treeFilter`, `conditions`, `automationElementMode` | none — accepted no-op `{done:true}` | ⬜ |
| typeDelay | `delay` / — | none — advisory; stores value, returns previous | ⬜ |
