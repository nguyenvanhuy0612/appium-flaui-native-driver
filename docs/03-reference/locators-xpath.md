# Locators & XPath — finder reference

*Reference · updated 2026-06-05*

> The locator strategies and XPath engine the driver exposes to `findElement`/`findElements`.
> Strategies are defined in code by `locatorStrategies` and the `propMap` in
> [`lib/driver.ts`](../../lib/driver.ts); the XPath engine lives under
> [`lib/xpath/`](../../lib/xpath/). See [`appium-api.md`](./appium-api.md) for per-command support status.

## Locator strategies

Six strategies are supported. Each non-XPath strategy resolves to a single typed UIA property; the
match is scoped to the context element's subtree (the context element is included when
`includeContextElementInSearch` is `true`, the default).

| Strategy | Resolves against | Notes |
|---|---|---|
| `accessibility id` | UIA `AutomationId` | Primary stable identifier. |
| `id` | UIA `AutomationId` | Alias of `accessibility id`. |
| `name` | UIA `Name` | Display/accessible name. |
| `class name` | UIA `ClassName` | Win32/WinUI class name. |
| `tag name` | UIA `ControlType` | Control-type name, e.g. `Button`, `Document`, `Edit`. |
| `xpath` | Full XPath 1.0 (below) | Structural + functional predicates over the UIA tree. |

The raw `-windows uiautomation` JSON condition grammar is **not** supported (planned, ADR-006).

## XPath 1.0 engine

A full XPath 1.0 implementation over the UIA tree, where element names are control types and
attributes are UIA property names (matching the page-source schema). Two-tier evaluation: structural
predicates compile to native UIA conditions and push down to the sidecar; function predicates
evaluate in TS over bulk-fetched attributes (see push-down behaviour below).

### Axes (13)

`child`, `descendant`, `descendant-or-self`, `self`, `parent`, `ancestor`, `ancestor-or-self`,
`following`, `following-sibling`, `preceding`, `preceding-sibling`, `attribute`, `namespace` (∅, empty).

### Functions (24)

| Group | Functions |
|---|---|
| String | `string`, `concat`, `starts-with`, `contains`, `substring`, `substring-before`, `substring-after`, `string-length`, `normalize-space`, `translate` |
| Node-set | `last`, `position`, `count`, `name`, `local-name` |
| Boolean | `boolean`, `not`, `true`, `false` |
| Number | `number`, `floor`, `ceiling`, `round`, `sum` |

### Operators

| Group | Operators |
|---|---|
| Comparison | `=`, `!=`, `<`, `<=`, `>`, `>=` |
| Arithmetic | `+`, `-`, `*`, `div`, `mod` |
| Logical | `and`, `or`, `not()` |
| Node / set | `@*` (any attribute), `\|` (union) |

### Push-down behaviour

- **Structural predicates** (tag, axis, attribute equality against the 21 typed UIA properties)
  compile to native UIA conditions and are evaluated by the sidecar — fast, no TS-side filtering.
- **Function predicates** (e.g. `contains(@Name,'x')`, `position()`, `last()`) evaluate **post-fetch**
  in TS over bulk-fetched attribute sets, because UIA conditions cannot express them.
- Positional semantics distinguish `//X[1]` (first child per parent) from `(//X)[1]` (first in
  document order); `last()` and `position()` are honoured.
- Tags and control-type aliases are case-insensitive.
- `//text()` resolves to empty; a malformed expression yields `invalid selector` (W3C 400).
- Not yet supported: the `id()` function and attribute-value extraction as the result (e.g. `…/@Name`).
