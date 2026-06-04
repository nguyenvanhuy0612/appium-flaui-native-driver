# RPC Protocol — the TS ↔ C# seam

*Reference · canonical TS↔C# RPC contract · updated 2026-06-04*

> **Canonical** wire contract between the TypeScript driver and the C# FlaUI sidecar. Defined in
> code by [`lib/backend/ops.ts`](../../lib/backend/ops.ts) (request/response types) and
> [`sidecar/Program.cs`](../../sidecar/Program.cs) (endpoints + error map). This is the single source
> of truth for op shapes, the envelope, and error types — other docs link here, they do not restate it.
>
> The seam is **structured JSON ops, never PowerShell strings** ([ADR-003](../04-design/decisions.md)).

## Transport

- **Protocol:** HTTP/1.1 over a loopback TCP port (Kestrel inside the sidecar).
- **Port discovery:** the sidecar prints `PORT=<n>` to stdout at startup; the driver reads it
  (`lib/backend/sidecar.ts`). No fixed port.
- **Content type:** `application/json` both ways.
- **Liveness:** the sidecar holds the parent's stdin; when Appium dies, stdin hits EOF and the
  sidecar self-exits (no orphan). An idle timer is the secondary guard — see
  [stability](../02-architecture/stability.md).

### Endpoints

| Method | Path | Body | Success value | Purpose |
|---|---|---|---|---|
| `GET` | `/status` | — | `{ok:true, ready:true}` | health / handshake probe |
| `POST` | `/session` | capabilities object | `{ok:true, value:{rootId}}` | create the session, resolve the app root window |
| `POST` | `/op` | a `BackendOp` (below) | `{ok:true, value:…}` | run one operation |
| `DELETE` | `/session` | — | `{ok:true}` | tear down; close the app per `shouldCloseApp` |

## Envelope

Every `/op` and `/session` response is one of two shapes (`Program.cs` `Err()` and the success
returns; types in `ops.ts` as `BackendResult<T>`):

```jsonc
// success
{ "ok": true, "value": <op-specific> }

// failure
{ "ok": false, "error": { "type": <W3CErrorType>, "message": "<human text>" } }
```

`ok:false` means **the backend is alive and answered** — the driver maps `error.type` to a W3C
WebDriver error and the **session survives**. A *transport* failure (connection refused, abort,
hard-deadline, dead process) is different: it surfaces as a non-`RpcError` and the driver fails the
session honestly (see [stability](../02-architecture/stability.md)).

### Error types

`W3CErrorType` (`ops.ts`) and the exception → type mapping (`Program.cs:376-384`):

| `error.type` | Raised by (C# exception) | Maps to W3C error |
|---|---|---|
| `timeout` | `TimeoutException`; PowerShell timeout | `TimeoutError` |
| `stale element reference` | `StaleElementException` | `StaleElementReferenceError` |
| `no such element` | `ElementNotFoundException` | `NoSuchElementError` |
| `invalid selector` | `ArgumentException` | `InvalidSelectorError` |
| `invalid argument` | `InvalidArgumentException` | `InvalidArgumentError` |
| `unknown error` | `SchedulerFatalException`, any other `Exception` | `UnknownError` |

> `SchedulerFatalException` → `unknown error` is the signal that the STA worker is unrecoverable
> (≥5 poisoned threads); the driver treats it as a backend failure.

## Element identity

Operations reference elements by a `runtimeId` string — the UIA `RuntimeId` int array joined with
`.` (e.g. `"42.131580.4.1"`), assigned by `ElementRegistry` when an element is first returned.
`"root"` (or the `rootId` from `/session`) denotes the session's root window. The element-returning
shape is `BasicProps`:

```jsonc
{ "runtimeId": "42.131580.4.1",
  "name": "OK", "automationId": "btnOk", "className": "Button",
  "controlType": "Button", "isEnabled": true, "isOffscreen": false }
```

## The `condition` grammar (find op)

A composable predicate tree (`Condition` in `ops.ts`) that the sidecar turns into a FlaUI
`ConditionBase` and pushes down to UIA:

```jsonc
{ "kind": "property", "prop": "ControlType", "value": "Button" }
{ "kind": "and", "children": [ <Condition>, … ] }
{ "kind": "or",  "children": [ <Condition>, … ] }
{ "kind": "not", "child": <Condition> }
{ "kind": "true" }                                  // matches everything
```

Supported `prop` names include: `AutomationId`, `Name`, `ClassName`, `ControlType`,
`LocalizedControlType`, `FrameworkId`, `HelpText`, `IsEnabled`, `IsOffscreen`, `ProcessId`,
`RuntimeId`, and the other UIA identification/state properties. `value` is a string, number, or
boolean.

## The 12 ops

Each `/op` body has an `op` discriminator plus op-specific fields. `<basic>` = a `BasicProps` object;
`{done:true}` = a write that succeeded.

### `find`
```jsonc
→ { "op":"find", "startId":"root", "multiple":true,
    "scope":"element|children|descendants|subtree", "condition":<Condition> }
← multiple:false → <basic>          // first match
← multiple:true  → { "elements":[<basic>, …] }
err: no such element · invalid selector · invalid argument
```

### `attributes`
```jsonc
→ { "op":"attributes", "id":"<rt>", "names":["Name","BoundingRectangle"] | "all" }
← { "Name":"OK", "IsEnabled":true, "BoundingRectangle":{"x":..,"y":..,"width":..,"height":..}, … }
// values are typed: bool / int / string / object (rect). "all" dumps every resolvable attribute.
err: stale element reference · no such element
```

### `action`  (UIA pattern operations on an element)
```jsonc
→ { "op":"action", "id":"<rt>", "action":"invoke", "args":{…} }
// write-style: invoke, toggle, expand, collapse, select, addToSelection, removeFromSelection,
//   scrollIntoView, setFocus, setValue, maximize, minimize, restore, close
// read-style:  getValue, isMultiple, selectedItem, allSelectedItems, getAttributes
← write → { "done":true } · read → the value
err: stale element reference · invalid argument · timeout
```

### `source`
```jsonc
→ { "op":"source", "startId":"root", "rawView":false }
← { "source":"<XML page source>" }
err: stale element reference
```

### `input`  (FlaUI.Core.Input — real SendInput, runs on the STA worker)
8 `kind`s. The first 5 are also exposed to clients as `windows:` commands; `move`/`down`/`up` are
internal targets of the W3C Actions API (`performActions`). All return `{ "done":true }`.
Modifiers (`modifierKeys`): `ctrl`/`control`, `shift`, `alt`/`menu`, `win`/`meta`/`windows`
(array or comma-string, case-insensitive). A point is the element center if `elementId` is given
without `x`/`y`; `x`/`y` alone are screen coords (window-relative for W3C viewport origin).

```jsonc
"click"        args: { elementId?, x?, y?, button?("left"|"right"|"middle"),
                       times?, durationMs?, interClickDelayMs?, modifierKeys?, bringToFront?(def true) }
"hover"        args: { elementId?, x?, y?, durationMs?(dwell), modifierKeys?, bringToFront?(def false) }
"scroll"       args: { elementId?, x?, y?, deltaX?, deltaY?, amount?(×delta),
                       modifierKeys?, bringToFront?(def false) }
"keys"         args: { actions: [ {text} | {virtualKeyCode, down?} | {pause} … ] }
"clickAndDrag" args: { startElementId?, startX?, startY?, endElementId?, endX?, endY?,
                       button?, durationMs?, modifierKeys?, bringToFront?(def true) }
"move"         args: { elementId?, x?, y? }          // raw W3C move, no auto-foreground
"down"         args: { button?("left"|"right"|"middle") }
"up"           args: { button?("left"|"right"|"middle") }
```
err: timeout · invalid argument · stale element reference

### `screenshot`
```jsonc
→ { "op":"screenshot", "id":"<rt>"? }       // omit id → desktop/root
← { "data":"<base64 PNG>" }
err: timeout
```

### `clipboard`
```jsonc
→ { "op":"clipboard", "action":"get|set", "contentType":"text|image"?, "b64":"<base64>"? }
← get → { "b64":"…" } · set → { "done":true }
err: invalid argument
```

### `file`  (insecure feature, [ADR-008](../04-design/decisions.md))
```jsonc
→ { "op":"file", "action":"pull|push|pullFolder", "path":"C:\\…", "data":"<base64>"? }
← pull/pullFolder → { "data":"<base64>" } (folder = base64 ZIP) · push → { "done":true }
err: invalid argument · unknown error
```

### `walk`  (tree navigation by ControlView walker)
```jsonc
→ { "op":"walk", "id":"<rt>", "direction":"parent|ancestors|following-siblings|preceding-siblings" }
← { "elements":[<basic>, …] }
err: stale element reference · invalid argument
```

### `window`  (on the session root, or `elementId`)
```jsonc
→ { "op":"window", "action":"title|handle|rect|setRect|maximize|minimize|foreground",
    "args":{…}?, "elementId":"<rt>"? }
← title → "<string>" · handle → "0x…" · rect → {x,y,width,height} · others → { "done":true }
err: stale element reference · invalid argument
```

### `app`
```jsonc
→ { "op":"app", "action":"launch|close|activate", "process":"<name>"? }
← { "done":true } (launch may re-root)
err: invalid argument
```

### `powershell`  (insecure feature; runs OUT of the scheduler with its own timeout)
```jsonc
→ { "op":"powershell", "script":"…", "timeoutMs":60000? }
← { "stdout":"…", "stderr":"…", "exitCode":0 }
err: timeout (process tree killed) · unknown error
```

> PowerShell deliberately bypasses the STA scheduler and the per-op watchdog — it has its own child
> process and timeout (default `powerShellCommandTimeout`, 60s), so it is **not** bounded by
> `flaui:operationTimeout`. See [stability](../02-architecture/stability.md).

## Worked example

```jsonc
// find the OK button under the root, then click it
POST /op  { "op":"find", "startId":"root", "multiple":false, "scope":"descendants",
            "condition":{ "kind":"and", "children":[
              { "kind":"property", "prop":"ControlType", "value":"Button" },
              { "kind":"property", "prop":"Name", "value":"OK" } ] } }
←         { "ok":true, "value":{ "runtimeId":"42.131580.4.1", "name":"OK", "controlType":"Button" } }

POST /op  { "op":"input", "kind":"click", "args":{ "elementId":"42.131580.4.1" } }
←         { "ok":true, "value":{ "done":true } }
```
