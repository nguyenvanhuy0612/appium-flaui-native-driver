// XPath 1.0 engine — full nova2 parity, ported onto the structured backend op contract.
//
// Design:
//   - Parse the XPath string with `xpath-analyzer` (same parser nova2 uses).
//   - Evaluate the parsed AST against an injected `XPathBackend`:
//       * `find`       pushes structural conditions (name test + simple attr eq/neq with and/or)
//                      down to UIA as a `Condition` over a `TreeScope`.
//       * `walk`       provides reverse / sibling tree navigation (parent, ancestors,
//                      following-siblings, preceding-siblings) which UIA's TreeScope cannot express.
//       * `attributes` bulk-fetches element properties so non-structural predicates
//                      (functions, numeric comparisons, @*, …) can be evaluated TS-side.
//   - Structural predicates are offloaded to `find`; everything else is computed in TS over the
//     candidate set, mirroring nova2's "PowerShell push-down + JS fallback" split.
//
// SUPPORTED (full XPath-1.0 subset matching nova2's e2e suite):
//   Paths:       absolute (`/Window/Edit`), relative (`Button`, `Pane/Button`), `//` shorthand,
//                `(...)[n]`/`(...)/steps`, unions (`//A | //B`).
//   Axes:        child, descendant, descendant-or-self, self, parent, ancestor, ancestor-or-self,
//                following-sibling, preceding-sibling, following, preceding, attribute (`@x`).
//   Node tests:  element name (PascalCase + lowercase aliases), `*`, `node()`. text()/comment()/
//                processing-instruction() never match a UIA element → empty result (not an error).
//   Functions:   contains, starts-with, string, concat, substring, substring-before,
//                substring-after, string-length, normalize-space, translate, count, last,
//                position, name, local-name, boolean, not, true, false, number, floor, ceiling,
//                round, sum.
//   Operators:   = != < <= > >= , + - * div mod, unary -, and/or/not(), `@*` comparisons.
//   Aliases:     lowercase tags (`//button`→Button), `list`→List|DataGrid,
//                `listitem`→ListItem|DataItem, `appbar`(50039)/`semanticzoom`(50040)
//                via LocalizedControlType.
//   Position:    `//Button[1]` (per-parent positional) vs `(//Button)[1]` (grouped), `last()`,
//                `position() = n`, `position() > n`, etc.
//
// Error behavior:
//   - Malformed XPath / unknown function / attribute-axis as a terminal locator → InvalidSelectorError.
//   - Unsupported-but-valid (e.g. `//text()`) → empty result, NOT an error.
//
// Not implemented (documented): namespace axis (returns empty per nova2), the `id()` function
//   (requires an absolute-root lookup the structured contract does not surface here — throws
//   InvalidSelectorError), and attribute-value extraction as a *result* (terminal `/@Name`).

import * as XPathAnalyzerModule from 'xpath-analyzer';
import {
  ABSOLUTE_LOCATION_PATH,
  ADDITIVE,
  AND,
  ANCESTOR,
  ANCESTOR_OR_SELF,
  ATTRIBUTE,
  BOOLEAN,
  CEILING,
  CHILD,
  CONCAT,
  CONTAINS,
  COUNT,
  DESCENDANT,
  DESCENDANT_OR_SELF,
  DIVISIONAL,
  EQUALITY,
  FALSE,
  FILTER,
  FLOOR,
  FOLLOWING,
  FOLLOWING_SIBLING,
  FUNCTION_CALL,
  GREATER_THAN,
  GREATER_THAN_OR_EQUAL,
  ID,
  INEQUALITY,
  LAST,
  LESS_THAN,
  LESS_THAN_OR_EQUAL,
  LITERAL,
  LOCAL_NAME,
  MODULUS,
  MULTIPLICATIVE,
  NAME,
  NAMESPACE,
  NEGATION,
  NODE,
  NODE_NAME_TEST,
  NODE_TYPE_TEST,
  NORMALIZE_SPACE,
  NOT,
  NUMBER,
  OR,
  PARENT,
  PATH,
  POSITION,
  PRECEDING,
  PRECEDING_SIBLING,
  RELATIVE_LOCATION_PATH,
  ROUND,
  SELF,
  STARTS_WITH,
  STRING,
  STRING_LENGTH,
  SUBSTRING,
  SUBSTRING_AFTER,
  SUBSTRING_BEFORE,
  SUBTRACTIVE,
  SUM,
  TRANSLATE,
  TRUE,
  UNION,
  type ExprNode,
  type FunctionName,
  type LocationNode,
  type NodeTestNode,
  type StepNode,
} from 'xpath-analyzer';

import {
  type BackendOp,
  type Condition,
  type TreeScopeName,
  findOp,
  propertyCondition,
  andCondition,
  orCondition,
  notCondition,
} from '../backend/ops.js';

/**
 * `xpath-analyzer` ships a CJS build whose default export is double-wrapped under interop
 * (`module.exports.default.default` is the class). Resolve the actual constructor robustly.
 */
type AnalyzerCtor = new (expression: string) => { parse(): ExprNode };
function resolveAnalyzer(): AnalyzerCtor {
  const mod = XPathAnalyzerModule as unknown as {
    default?: AnalyzerCtor | { default?: AnalyzerCtor };
  };
  if (typeof mod.default === 'function') {
    return mod.default;
  }
  if (mod.default && typeof mod.default.default === 'function') {
    return mod.default.default;
  }
  if (typeof (XPathAnalyzerModule as unknown) === 'function') {
    return XPathAnalyzerModule as unknown as AnalyzerCtor;
  }
  throw new Error('Unable to resolve XPathAnalyzer constructor from xpath-analyzer.');
}

/** Result row shape returned by the backend. Carries cheap basic props to avoid round-trips. */
export interface FoundElement {
  runtimeId: string;
  name?: string;
  automationId?: string;
  className?: string;
  controlType?: string;
}

/**
 * The contract the XPath engine uses to talk to the UIA backend (sidecar).
 *
 * Wiring note for the driver: implement this over the backend RPC. `find` is the existing
 * structured find; `walk` and `attributes` correspond to the sidecar ops
 * `{op:'walk', id, direction}` and `{op:'attributes', id, names}`.
 */
export interface XPathBackend {
  /** Structural search: push name test + simple attr conditions down to UIA. */
  find(op: BackendOp): Promise<FoundElement[]>;
  /**
   * Tree walking for reverse/sibling axes. Returns ordered elements (document order for
   * following-siblings, document order for preceding-siblings too — i.e. nearest-first is NOT
   * required; the engine reorders as XPath requires).
   */
  walk(
    id: string,
    direction: 'parent' | 'ancestors' | 'following-siblings' | 'preceding-siblings',
  ): Promise<FoundElement[]>;
  /** Bulk attribute fetch for TS-side predicate evaluation. `'all'` returns every known property. */
  attributes(id: string, names: string[] | 'all'): Promise<Record<string, unknown>>;
}

/** Back-compat shim: the old API accepted a bare find callback. */
export type FindViaBackend = (op: BackendOp) => Promise<FoundElement[]>;

/** Thrown for malformed or genuinely-unsupported XPath. Name matches W3C `invalid selector`. */
export class InvalidSelectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSelectorError';
  }
}

/** Sentinel id meaning "the UIA automation root"; the sidecar maps this to its root element. */
export const AUTOMATION_ROOT_ID = 'root';

const LAST_POSITION = 0x7fffffff;

// ---------------------------------------------------------------------------
// Element model
// ---------------------------------------------------------------------------

/**
 * An element handle threaded through evaluation. Caches the basic props that `find`/`walk`
 * already returned, and lazily fetches the rest via `attributes` only when a predicate needs them.
 */
class XElement {
  private attrCache: Record<string, unknown> | undefined;

  constructor(
    readonly runtimeId: string,
    private readonly backend: XPathBackend,
    basic?: Partial<FoundElement>,
  ) {
    if (basic) {
      const seed: Record<string, unknown> = {};
      if (basic.name !== undefined) seed.Name = basic.name;
      if (basic.automationId !== undefined) seed.AutomationId = basic.automationId;
      if (basic.className !== undefined) seed.ClassName = basic.className;
      if (basic.controlType !== undefined) seed.ControlType = basic.controlType;
      if (Object.keys(seed).length > 0) {
        this.attrCache = seed;
      }
    }
  }

  /** Fetch the (PascalCase) value of one property, using the seeded cache when possible. */
  async getProp(prop: string): Promise<unknown> {
    const canonical = normalizePropName(prop);
    if (this.attrCache && canonical in this.attrCache) {
      return this.attrCache[canonical];
    }
    const fetched = await this.backend.attributes(this.runtimeId, [canonical]);
    this.attrCache = { ...(this.attrCache ?? {}), ...fetched };
    return this.attrCache[canonical];
  }

  /** Fetch every known attribute (for `@*` / `count(@*)` / `node()` attribute axis). */
  async getAllAttributes(): Promise<Record<string, unknown>> {
    const fetched = await this.backend.attributes(this.runtimeId, 'all');
    this.attrCache = { ...(this.attrCache ?? {}), ...fetched };
    return { ...this.attrCache };
  }

  /** The element's "tag name" for name()/local-name(): its ControlType. */
  async tagName(): Promise<string> {
    const ct = await this.getProp('ControlType');
    return ct === undefined || ct === null ? '' : String(ct);
  }
}

/** An XPath value: a node-set (elements OR attribute-value strings), string, number, or boolean. */
type XValue = XElement | string | number | boolean;

// ---------------------------------------------------------------------------
// Node tests & conditions
// ---------------------------------------------------------------------------

/** Map a UIA control-type-ish node name (any case) to a ControlType condition, with aliases. */
function nodeNameToCondition(name: string): Condition {
  if (name === '*') {
    return { kind: 'true' };
  }
  const lower = name.toLowerCase();
  if (lower === 'list') {
    return orCondition(
      propertyCondition('ControlType', 'List'),
      propertyCondition('ControlType', 'DataGrid'),
    );
  }
  if (lower === 'listitem') {
    return orCondition(
      propertyCondition('ControlType', 'ListItem'),
      propertyCondition('ControlType', 'DataItem'),
    );
  }
  // ControlType 50039 (AppBar) / 50040 (SemanticZoom) are not in the classic UIA ControlType
  // enum; nova2 matches them via LocalizedControlType. Mirror that.
  if (lower === 'appbar') {
    return propertyCondition('LocalizedControlType', 'app bar');
  }
  if (lower === 'semanticzoom') {
    return propertyCondition('LocalizedControlType', 'semantic zoom');
  }
  return propertyCondition('ControlType', canonicalizeControlType(name));
}

/** Canonicalize a control-type tag to PascalCase so lowercase aliases (`//button`) work. */
function canonicalizeControlType(name: string): string {
  const known = CONTROL_TYPES_LOWER[name.toLowerCase()];
  return known ?? name;
}

const CONTROL_TYPES_LOWER: Record<string, string> = Object.fromEntries(
  [
    'Button', 'Calendar', 'CheckBox', 'ComboBox', 'Custom', 'DataGrid', 'DataItem', 'Document',
    'Edit', 'Group', 'Header', 'HeaderItem', 'Hyperlink', 'Image', 'List', 'ListItem', 'MenuBar',
    'Menu', 'MenuItem', 'Pane', 'ProgressBar', 'RadioButton', 'ScrollBar', 'Separator', 'Slider',
    'Spinner', 'SplitButton', 'StatusBar', 'Tab', 'TabItem', 'Table', 'Text', 'Thumb',
    'TitleBar', 'ToolBar', 'ToolTip', 'Tree', 'TreeItem', 'Window',
  ].map((n) => [n.toLowerCase(), n]),
);

/** True if a node test can ever match a UIA element. text()/comment()/PI never can. */
function nodeTestMatchesElements(test: NodeTestNode): boolean {
  if (test.type === NODE_NAME_TEST) return true;
  if (test.type === NODE_TYPE_TEST) return test.name === NODE;
  return false; // processing-instruction()
}

/** Build the base condition for a node test that matches elements. */
function nodeTestToCondition(test: NodeTestNode): Condition {
  if (test.type === NODE_NAME_TEST) {
    return nodeNameToCondition(test.name);
  }
  // node() matches anything; non-element tests are filtered out earlier.
  return { kind: 'true' };
}

/**
 * Normalize an attribute name to the backend's PascalCase UIA property name. Accepts common
 * nova2/Appium spellings case-insensitively; passes unknown names through verbatim.
 */
function normalizePropName(attr: string): string {
  const known: Record<string, string> = {
    name: 'Name',
    automationid: 'AutomationId',
    classname: 'ClassName',
    controltype: 'ControlType',
    isenabled: 'IsEnabled',
    isoffscreen: 'IsOffscreen',
    helptext: 'HelpText',
    acceleratorkey: 'AcceleratorKey',
    accesskey: 'AccessKey',
    frameworkid: 'FrameworkId',
    runtimeid: 'RuntimeId',
    itemstatus: 'ItemStatus',
    itemtype: 'ItemType',
    localizedcontroltype: 'LocalizedControlType',
    processid: 'ProcessId',
    orientation: 'Orientation',
    haskeyboardfocus: 'HasKeyboardFocus',
    iskeyboardfocusable: 'IsKeyboardFocusable',
    ispassword: 'IsPassword',
    isrequiredforform: 'IsRequiredForForm',
    iscontentelement: 'IsContentElement',
    iscontrolelement: 'IsControlElement',
  };
  return known[attr.toLowerCase()] ?? attr;
}

/** Is this node a single-step `@attr` attribute reference? Returns the attribute name or undefined. */
function attributeRefName(node: ExprNode): string | undefined {
  if (
    node.type === RELATIVE_LOCATION_PATH &&
    node.steps.length === 1 &&
    node.steps[0].axis === ATTRIBUTE &&
    node.steps[0].test.type === NODE_NAME_TEST
  ) {
    return node.steps[0].test.name;
  }
  return undefined;
}

function literalValue(node: ExprNode): string | number | undefined {
  if (node.type === LITERAL) return node.string;
  if (node.type === NUMBER) return node.number;
  return undefined;
}

// ---------------------------------------------------------------------------
// Predicate analysis: structural push-down vs TS-side evaluation
// ---------------------------------------------------------------------------

/**
 * Try to express a predicate as a structured backend Condition. Handles:
 *   @attr (= | !=) literal, literal (= | !=) @attr, and/or of those.
 * Returns undefined if the predicate cannot be a pure UIA condition (functions, numeric
 * comparisons, @*, position, anything needing TS evaluation).
 */
function predicateToCondition(pred: ExprNode): Condition | undefined {
  switch (pred.type) {
    case AND: {
      const lhs = predicateToCondition(pred.lhs);
      const rhs = predicateToCondition(pred.rhs);
      return lhs && rhs ? andCondition(lhs, rhs) : undefined;
    }
    case OR: {
      const lhs = predicateToCondition(pred.lhs);
      const rhs = predicateToCondition(pred.rhs);
      return lhs && rhs ? orCondition(lhs, rhs) : undefined;
    }
    case EQUALITY:
    case INEQUALITY: {
      const lName = attributeRefName(pred.lhs);
      const rName = attributeRefName(pred.rhs);
      let attr: string | undefined;
      let valueNode: ExprNode | undefined;
      if (lName !== undefined && rName === undefined) {
        attr = lName;
        valueNode = pred.rhs;
      } else if (rName !== undefined && lName === undefined) {
        attr = rName;
        valueNode = pred.lhs;
      } else {
        return undefined;
      }
      if (attr === '*') return undefined; // @* handled TS-side
      const value = literalValue(valueNode!);
      if (value === undefined) return undefined;
      const cond = propertyCondition(normalizePropName(attr!), coercePropertyValue(attr!, value));
      return pred.type === INEQUALITY ? notCondition(cond) : cond;
    }
    default:
      return undefined;
  }
}

/** Coerce a literal to the type the UIA property expects (booleans for Is* props). */
function coercePropertyValue(attr: string, value: string | number): string | number | boolean {
  const canonical = normalizePropName(attr);
  if (/^Is/.test(canonical) || canonical === 'HasKeyboardFocus') {
    if (typeof value === 'string') {
      if (/^true$/i.test(value)) return true;
      if (/^false$/i.test(value)) return false;
    }
    return Boolean(value);
  }
  return value;
}

/**
 * Recognize a positional predicate that selects a fixed position, à la nova2:
 *   [n], [last()], [position()=n], [position()=last()], [n + arithmetic that is constant].
 * Returns the 1-based position (LAST_POSITION for last()) or undefined.
 *
 * Only the *constant* positional forms can be pre-computed without the full set. Comparison forms
 * like [position() > 1] are evaluated TS-side as ordinary predicates.
 */
function constantPosition(pred: ExprNode): number | undefined {
  if (pred.type === NUMBER) return pred.number;
  if (pred.type === FUNCTION_CALL && pred.name === LAST && pred.args.length === 0) {
    return LAST_POSITION;
  }
  if (pred.type === EQUALITY) {
    const isPos = (n: ExprNode) => n.type === FUNCTION_CALL && n.name === POSITION;
    const isLast = (n: ExprNode) => n.type === FUNCTION_CALL && n.name === LAST;
    if (isPos(pred.lhs) && !isPos(pred.rhs)) {
      if (typeof literalValue(pred.rhs) === 'number') return literalValue(pred.rhs) as number;
      if (isLast(pred.rhs)) return LAST_POSITION;
    }
    if (isPos(pred.rhs) && !isPos(pred.lhs)) {
      if (typeof literalValue(pred.lhs) === 'number') return literalValue(pred.lhs) as number;
      if (isLast(pred.lhs)) return LAST_POSITION;
    }
  }
  return undefined;
}

/** Does this predicate reference position()/last() anywhere (so it must see the full set)? */
function referencesPosition(node: ExprNode): boolean {
  if (node.type === FUNCTION_CALL && (node.name === POSITION || node.name === LAST)) return true;
  for (const child of childExprs(node)) {
    if (referencesPosition(child)) return true;
  }
  return false;
}

function childExprs(node: ExprNode): ExprNode[] {
  const out: ExprNode[] = [];
  const anyNode = node as unknown as { lhs?: ExprNode; rhs?: ExprNode };
  if (anyNode.lhs) out.push(anyNode.lhs);
  if (anyNode.rhs) out.push(anyNode.rhs);
  if (node.type === FUNCTION_CALL) out.push(...node.args);
  if (node.type === FILTER) {
    out.push(node.primary, ...node.predicates);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

interface EvalCtx {
  /** Current node for position()/last() and relative paths. */
  node: XElement;
  /** 1-based position within the current node-set, or undefined (defaults to 1 / size 1). */
  position?: number;
  /** Size of the current node-set, or undefined. */
  size?: number;
}

class XPathExecutor {
  constructor(
    private readonly backend: XPathBackend,
    private readonly rootId: string,
    /** When true (findElement), the outermost path's last leaf find may use multiple:false. */
    private readonly optimizeLastStep: boolean = false,
  ) {}

  // --- Top-level node-set resolution (returns elements) --------------------

  /** Top-level entry: the outermost path may carry the findFirst optimization. */
  async resolveToElements(node: ExprNode, contexts: XElement[]): Promise<XElement[]> {
    return this.resolve(node, contexts, this.optimizeLastStep);
  }

  private async resolve(node: ExprNode, contexts: XElement[], optimizeLast: boolean): Promise<XElement[]> {
    switch (node.type) {
      case UNION: {
        // Each branch can independently optimize its own last step.
        const lhs = await this.resolve(node.lhs, contexts, optimizeLast);
        const rhs = await this.resolve(node.rhs, contexts, optimizeLast);
        return dedupe([...lhs, ...rhs]);
      }
      case ABSOLUTE_LOCATION_PATH:
        // nova2 parity: an absolute path whose first step is `child::` is matched as
        // `child-or-self::`, so e.g. `/Pane` can select the root element itself.
        return this.walkSteps(node.steps, [this.rootElement()], optimizeLast, true);
      case RELATIVE_LOCATION_PATH:
        return this.walkStepsFromMany(node.steps, contexts, optimizeLast);
      case PATH: {
        const filtered = await this.resolve(node.filter, contexts, false);
        return this.walkStepsFromMany(node.steps, filtered, optimizeLast);
      }
      case FILTER: {
        const base = await this.resolve(node.primary, contexts, false);
        return this.applyFilterPredicates(base, node.predicates);
      }
      default:
        throw new InvalidSelectorError(
          `XPath expression does not evaluate to a node-set: '${node.type}'.`,
        );
    }
  }

  private rootElement(): XElement {
    return new XElement(this.rootId, this.backend);
  }

  private async walkStepsFromMany(
    steps: StepNode[],
    contexts: XElement[],
    optimizeLast: boolean,
  ): Promise<XElement[]> {
    const out: XElement[] = [];
    // findFirst optimization is only sound when there's a single context element.
    const allowFindFirst = optimizeLast && contexts.length === 1;
    for (const ctx of contexts) {
      out.push(...(await this.walkSteps(steps, [ctx], allowFindFirst)));
    }
    return dedupe(out);
  }

  /** Walk a sequence of location steps, threading the element set through each step. */
  private async walkSteps(
    steps: StepNode[],
    contexts: XElement[],
    optimizeLast: boolean,
    absolute = false,
  ): Promise<XElement[]> {
    if (steps.length === 0) return contexts;

    const collapsed = collapseDoubleSlash(steps);

    let current = contexts;
    for (let i = 0; i < collapsed.length; i++) {
      const step = collapsed[i];
      const isLast = i === collapsed.length - 1;
      // First step of an absolute path with a child axis also considers the root itself.
      const childOrSelf = absolute && i === 0 && step.axis === CHILD;

      if (step.axis === ATTRIBUTE) {
        // Terminal attribute step as a *locator result* is not supported (we return elements,
        // not attribute strings). Mirror nova2: a non-terminal attribute step yields nothing.
        if (i === collapsed.length - 1) {
          throw new InvalidSelectorError(
            'Attribute-axis terminal steps (e.g. /…/@Name) are not supported as element locators.',
          );
        }
        return [];
      }

      // Node tests that can never match a UIA element (text(), comment(), PI) → empty, not error.
      if (!nodeTestMatchesElements(step.test)) {
        return [];
      }

      // Eligible for findFirst only on the last step, single context, no positional/TS predicates.
      const findFirst =
        optimizeLast &&
        isLast &&
        current.length === 1 &&
        forwardAxisScope(step.axis) !== undefined &&
        step.predicates.every((p) => predicateToCondition(p) !== undefined);

      const next: XElement[] = [];
      for (const ctx of current) {
        next.push(...(await this.executeStep(step, ctx, findFirst && !childOrSelf, childOrSelf)));
      }
      current = dedupe(next);
      if (current.length === 0) return [];
    }
    return current;
  }

  /** Execute one location step against one context element, returning the (ordered) matches. */
  private async executeStep(
    step: StepNode,
    context: XElement,
    findFirst: boolean,
    childOrSelf = false,
  ): Promise<XElement[]> {
    // Split predicates: constant positions, structural conditions, and TS-side expressions.
    // Predicate ordering matters (XPath applies them left-to-right).
    const prePosConditions: Condition[] = [];
    const prePosTsExprs: ExprNode[] = [];
    const postPosTsExprs: ExprNode[] = [];
    const positions: number[] = [];
    let seenPosition = false;

    for (const pred of step.predicates) {
      const pos = constantPosition(pred);
      if (pos !== undefined) {
        positions.push(pos);
        seenPosition = true;
        continue;
      }
      const cond = !referencesPosition(pred) ? predicateToCondition(pred) : undefined;
      if (cond && !seenPosition) {
        prePosConditions.push(cond);
      } else if (!seenPosition) {
        prePosTsExprs.push(pred);
      } else {
        postPosTsExprs.push(pred);
      }
    }

    const base = nodeTestToCondition(step.test);
    const condition: Condition =
      prePosConditions.length > 0 ? andCondition(base, ...prePosConditions) : base;

    // Resolve the raw candidate set for this axis.
    let candidates = await this.resolveAxis(step.axis, context, condition, findFirst);

    // child-or-self (absolute first step): also include the context element itself when it
    // matches. Push this down as an element-scope find so it works on a bare-find backend too.
    if (childOrSelf) {
      const selfMatch = await this.backend.find(
        findOp({ startId: context.runtimeId, multiple: false, scope: 'element', condition }),
      );
      if (selfMatch.length > 0) {
        candidates = dedupe([this.wrap(selfMatch[0]), ...candidates]);
      }
    }

    // Apply pre-position TS predicates over the full candidate set.
    candidates = await this.filterByExprs(candidates, prePosTsExprs);

    // Apply constant positions.
    if (positions.length > 0) {
      candidates = selectPositions(candidates, positions);
    }

    // Apply post-position TS predicates over the position-filtered set.
    candidates = await this.filterByExprs(candidates, postPosTsExprs);

    return candidates;
  }

  /** Resolve a step's axis into the candidate element list (with the structural condition applied). */
  private async resolveAxis(
    axis: string,
    context: XElement,
    condition: Condition,
    findFirst = false,
  ): Promise<XElement[]> {
    const scope = forwardAxisScope(axis);
    if (scope) {
      const res = await this.backend.find(
        findOp({ startId: context.runtimeId, multiple: !findFirst, scope, condition }),
      );
      return res.map((el) => this.wrap(el));
    }

    if (axis === NAMESPACE) {
      return []; // nova2 returns empty for the namespace axis.
    }

    // Reverse / sibling / following / preceding axes — compose from walk + subtree finds.
    const walked = await this.resolveNonForwardAxis(axis, context);
    // Apply the structural condition TS-side (walk does not push it down).
    const filtered: XElement[] = [];
    for (const el of walked) {
      if (await matchesCondition(el, condition)) filtered.push(el);
    }
    return filtered;
  }

  private async resolveNonForwardAxis(axis: string, context: XElement): Promise<XElement[]> {
    switch (axis) {
      case PARENT: {
        const p = await this.backend.walk(context.runtimeId, 'parent');
        return p.map((el) => this.wrap(el));
      }
      case ANCESTOR: {
        const a = await this.backend.walk(context.runtimeId, 'ancestors');
        return a.map((el) => this.wrap(el));
      }
      case ANCESTOR_OR_SELF: {
        const a = await this.backend.walk(context.runtimeId, 'ancestors');
        return [context, ...a.map((el) => this.wrap(el))];
      }
      case FOLLOWING_SIBLING: {
        const s = await this.backend.walk(context.runtimeId, 'following-siblings');
        return s.map((el) => this.wrap(el));
      }
      case PRECEDING_SIBLING: {
        const s = await this.backend.walk(context.runtimeId, 'preceding-siblings');
        return s.map((el) => this.wrap(el));
      }
      case FOLLOWING:
        return this.resolveFollowing(context);
      case PRECEDING:
        return this.resolvePreceding(context);
      default:
        throw new InvalidSelectorError(`Unsupported XPath axis: '${axis}'.`);
    }
  }

  /**
   * following:: = all nodes after the context in document order, excluding descendants.
   * Compose as: for the context and each ancestor, take following-siblings, then each
   * following-sibling's whole subtree (the sibling + its descendants).
   */
  private async resolveFollowing(context: XElement): Promise<XElement[]> {
    const out: XElement[] = [];
    const chain = [context, ...(await this.backend.walk(context.runtimeId, 'ancestors')).map((e) => this.wrap(e))];
    for (const anc of chain) {
      const sibs = (await this.backend.walk(anc.runtimeId, 'following-siblings')).map((e) => this.wrap(e));
      for (const sib of sibs) {
        out.push(sib);
        out.push(...(await this.subtree(sib)));
      }
    }
    return dedupe(out);
  }

  /**
   * preceding:: = all nodes before the context in document order, excluding ancestors.
   * Compose as: for the context and each ancestor, take preceding-siblings, then each
   * preceding-sibling's whole subtree.
   */
  private async resolvePreceding(context: XElement): Promise<XElement[]> {
    const out: XElement[] = [];
    const chain = [context, ...(await this.backend.walk(context.runtimeId, 'ancestors')).map((e) => this.wrap(e))];
    for (const anc of chain) {
      const sibs = (await this.backend.walk(anc.runtimeId, 'preceding-siblings')).map((e) => this.wrap(e));
      for (const sib of sibs) {
        out.push(sib);
        out.push(...(await this.subtree(sib)));
      }
    }
    return dedupe(out);
  }

  private async subtree(el: XElement): Promise<XElement[]> {
    const res = await this.backend.find(
      findOp({ startId: el.runtimeId, multiple: true, scope: 'descendants', condition: { kind: 'true' } }),
    );
    return res.map((e) => this.wrap(e));
  }

  private wrap(el: FoundElement): XElement {
    return new XElement(el.runtimeId, this.backend, el);
  }

  // --- FILTER predicates on a parenthesised primary ------------------------

  private async applyFilterPredicates(base: XElement[], predicates: ExprNode[]): Promise<XElement[]> {
    let current = base;
    for (const pred of predicates) {
      const pos = constantPosition(pred);
      if (pos !== undefined) {
        current = selectPositions(current, [pos]);
      } else {
        current = await this.filterByExprs(current, [pred]);
      }
    }
    return current;
  }

  /** Filter a node-set by evaluating each predicate expr per element (with position context). */
  private async filterByExprs(els: XElement[], predicates: ExprNode[]): Promise<XElement[]> {
    if (predicates.length === 0) return els;
    const out: XElement[] = [];
    for (let i = 0; i < els.length; i++) {
      const ctx: EvalCtx = { node: els[i], position: i + 1, size: els.length };
      let keep = true;
      for (const pred of predicates) {
        if (!(await this.predicateTruth(pred, ctx))) {
          keep = false;
          break;
        }
      }
      if (keep) out.push(els[i]);
    }
    return out;
  }

  /**
   * Evaluate a predicate to a boolean. A bare numeric predicate means position()=that number
   * (XPath §3.3); otherwise apply boolean().
   */
  private async predicateTruth(pred: ExprNode, ctx: EvalCtx): Promise<boolean> {
    const value = await this.evalExpr(pred, ctx);
    if (typeof value === 'number') {
      return ctx.position === value;
    }
    return toBoolean(value);
  }

  // --- General expression evaluation (returns a scalar XValue) -------------

  /** Evaluate an expression in a context, returning a single scalar value (node-sets → first/bool). */
  private async evalExpr(node: ExprNode, ctx: EvalCtx): Promise<XValue> {
    switch (node.type) {
      case NUMBER:
        return node.number;
      case LITERAL:
        return node.string;
      case FUNCTION_CALL:
        return this.evalFunction(node.name, node.args, ctx);
      case NEGATION:
        return -(await this.evalNumber(node.lhs, ctx));
      case OR:
        return (await this.evalBoolean(node.lhs, ctx)) || (await this.evalBoolean(node.rhs, ctx));
      case AND:
        return (await this.evalBoolean(node.lhs, ctx)) && (await this.evalBoolean(node.rhs, ctx));
      case EQUALITY:
      case INEQUALITY:
        return this.evalEquality(node, ctx);
      case GREATER_THAN:
      case GREATER_THAN_OR_EQUAL:
      case LESS_THAN:
      case LESS_THAN_OR_EQUAL: {
        const lhs = await this.evalNumber(node.lhs, ctx);
        const rhs = await this.evalNumber(node.rhs, ctx);
        switch (node.type) {
          case GREATER_THAN:
            return lhs > rhs;
          case GREATER_THAN_OR_EQUAL:
            return lhs >= rhs;
          case LESS_THAN:
            return lhs < rhs;
          default:
            return lhs <= rhs;
        }
      }
      case ADDITIVE:
      case SUBTRACTIVE:
      case MULTIPLICATIVE:
      case DIVISIONAL:
      case MODULUS: {
        const lhs = await this.evalNumber(node.lhs, ctx);
        const rhs = await this.evalNumber(node.rhs, ctx);
        switch (node.type) {
          case ADDITIVE:
            return lhs + rhs;
          case SUBTRACTIVE:
            return lhs - rhs;
          case MULTIPLICATIVE:
            return lhs * rhs;
          case DIVISIONAL:
            return lhs / rhs;
          default:
            return lhs % rhs;
        }
      }
      case RELATIVE_LOCATION_PATH:
      case ABSOLUTE_LOCATION_PATH:
      case PATH:
      case FILTER:
        // A node-set used as a scalar: resolve its first member's "value".
        return this.nodeSetScalar(node, ctx);
      case UNION:
        return this.nodeSetScalar(node, ctx);
      default:
        throw new InvalidSelectorError(
          `Unsupported XPath expression: '${(node as { type: string }).type}'.`,
        );
    }
  }

  /**
   * A location path inside a predicate — resolve it and reduce to a scalar. Special cases:
   *  - `@attr`            → that attribute's value (string), or '' / undefined node-set.
   *  - `@*`               → the multi-value attribute list (we return the *node-set* as a marker;
   *                         handled by callers that compare against a string).
   * For the common attribute-relative case we return the value directly.
   */
  private async nodeSetScalar(node: ExprNode, ctx: EvalCtx): Promise<XValue> {
    const ns = await this.evalNodeSet(node, ctx);
    if (ns.length === 0) return ''; // empty node-set → '' in string context
    const first = ns[0];
    if (first instanceof XElement) {
      // String-value of an element in this UIA world is empty (no text nodes), per nova2.
      return '';
    }
    return first;
  }

  /**
   * Evaluate a sub-expression to a node-set of XValues. Attribute steps yield strings; element
   * steps yield XElements. Used by functions like count(), and by @attr predicate comparisons.
   */
  private async evalNodeSet(node: ExprNode, ctx: EvalCtx): Promise<XValue[]> {
    // Special-case a relative attribute path (the overwhelmingly common predicate form).
    if (node.type === RELATIVE_LOCATION_PATH && node.steps.length === 1 && node.steps[0].axis === ATTRIBUTE) {
      const test = node.steps[0].test;
      if (test.type === NODE_NAME_TEST) {
        if (test.name === '*') {
          const all = await ctx.node.getAllAttributes();
          return Object.values(all)
            .filter((v) => v !== undefined && v !== null && String(v) !== '')
            .map((v) => String(v));
        }
        const v = await ctx.node.getProp(test.name);
        return v === undefined || v === null ? [] : [String(v)];
      }
      if (test.type === NODE_TYPE_TEST && test.name === NODE) {
        const all = await ctx.node.getAllAttributes();
        return Object.values(all).map((v) => (v === undefined || v === null ? '' : String(v)));
      }
      return [];
    }
    // Otherwise it is an element-producing path; resolve relative to the context node.
    const els = await this.resolveToElements(node, [ctx.node]);
    return els;
  }

  private async evalEquality(
    node: Extract<ExprNode, { type: typeof EQUALITY | typeof INEQUALITY }>,
    ctx: EvalCtx,
  ): Promise<boolean> {
    // Node-set vs value comparison: true if ANY member compares true (XPath §3.4).
    const lhsIsNs = isNodeSetExpr(node.lhs);
    const rhsIsNs = isNodeSetExpr(node.rhs);
    const eq = node.type === EQUALITY;

    if (lhsIsNs !== rhsIsNs) {
      const nsNode = lhsIsNs ? node.lhs : node.rhs;
      const otherNode = lhsIsNs ? node.rhs : node.lhs;
      const members = await this.evalNodeSet(nsNode, ctx);
      const other = await this.evalExpr(otherNode, ctx);
      const result = members.some((m) => scalarEquals(m, other));
      // For an empty node-set, '=' is false and '!=' is false too (no member to compare).
      // nova2 treats `@attr != 'x'` on a missing attr as comparing '' (the scalar). Match that
      // by falling back to scalar '' when the node-set is empty.
      if (members.length === 0) {
        const fallback = scalarEquals('', other);
        return eq ? fallback : !fallback;
      }
      return eq ? result : !members.every((m) => scalarEquals(m, other));
    }

    const lhs = await this.evalExpr(node.lhs, ctx);
    const rhs = await this.evalExpr(node.rhs, ctx);
    const equal = scalarEquals(lhs, rhs);
    return eq ? equal : !equal;
  }

  private async evalBoolean(node: ExprNode, ctx: EvalCtx): Promise<boolean> {
    if (isNodeSetExpr(node)) {
      const ns = await this.evalNodeSet(node, ctx);
      return ns.length > 0;
    }
    return toBoolean(await this.evalExpr(node, ctx));
  }

  private async evalNumber(node: ExprNode, ctx: EvalCtx): Promise<number> {
    if (isNodeSetExpr(node)) {
      const ns = await this.evalNodeSet(node, ctx);
      return toNumber(ns.length === 0 ? NaN : ns[0]);
    }
    return toNumber(await this.evalExpr(node, ctx));
  }

  private async evalString(node: ExprNode, ctx: EvalCtx): Promise<string> {
    if (isNodeSetExpr(node)) {
      const ns = await this.evalNodeSet(node, ctx);
      return ns.length === 0 ? '' : toStringValue(ns[0]);
    }
    return toStringValue(await this.evalExpr(node, ctx));
  }

  // --- Core function library -----------------------------------------------

  private async evalFunction(name: FunctionName, args: ExprNode[], ctx: EvalCtx): Promise<XValue> {
    switch (name) {
      case TRUE:
        requireArity(name, args, 0);
        return true;
      case FALSE:
        requireArity(name, args, 0);
        return false;
      case NOT:
        requireArity(name, args, 1);
        return !(await this.evalBoolean(args[0], ctx));
      case BOOLEAN:
        requireArity(name, args, 1);
        return this.evalBoolean(args[0], ctx);
      case POSITION:
        requireArity(name, args, 0);
        return ctx.position ?? 1;
      case LAST:
        requireArity(name, args, 0);
        return ctx.size ?? 1;
      case COUNT: {
        requireArity(name, args, 1);
        const ns = await this.evalNodeSet(args[0], ctx);
        return ns.length;
      }
      case STRING:
        requireArityMax(name, args, 1);
        return args.length === 0 ? toStringValue(ctx.node) : this.evalString(args[0], ctx);
      case CONCAT: {
        if (args.length < 2) {
          throw new InvalidSelectorError(`Function concat() requires at least 2 arguments.`);
        }
        const parts: string[] = [];
        for (const a of args) parts.push(await this.evalString(a, ctx));
        return parts.join('');
      }
      case STARTS_WITH:
      case CONTAINS: {
        requireArity(name, args, 2);
        const needle = await this.evalString(args[1], ctx);
        if (needle === '') return true;
        // @* may produce multiple values: true if ANY matches.
        if (isAttrWildcard(args[0])) {
          const ns = await this.evalNodeSet(args[0], ctx);
          return ns.some((v) =>
            name === CONTAINS ? toStringValue(v).includes(needle) : toStringValue(v).startsWith(needle),
          );
        }
        const hay = await this.evalString(args[0], ctx);
        return name === CONTAINS ? hay.includes(needle) : hay.startsWith(needle);
      }
      case SUBSTRING_BEFORE:
      case SUBSTRING_AFTER: {
        requireArity(name, args, 2);
        const hay = await this.evalString(args[0], ctx);
        const sep = await this.evalString(args[1], ctx);
        const idx = hay.indexOf(sep);
        if (idx === -1) return '';
        return name === SUBSTRING_BEFORE ? hay.slice(0, idx) : hay.slice(idx + sep.length);
      }
      case SUBSTRING: {
        if (args.length < 2 || args.length > 3) {
          throw new InvalidSelectorError(`Function substring() requires 2 or 3 arguments.`);
        }
        const str = await this.evalString(args[0], ctx);
        const start = Math.round(await this.evalNumber(args[1], ctx));
        if (args.length === 3) {
          const len = Math.round(await this.evalNumber(args[2], ctx));
          const end = start + len;
          const s = Math.max(start - 1, 0);
          const e = Math.min(end - 1, str.length);
          return str.slice(s, Math.max(e, s));
        }
        return str.slice(Math.max(start - 1, 0));
      }
      case STRING_LENGTH: {
        requireArityMax(name, args, 1);
        const s = args.length === 0 ? toStringValue(ctx.node) : await this.evalString(args[0], ctx);
        return s.length;
      }
      case NORMALIZE_SPACE: {
        requireArityMax(name, args, 1);
        const s = args.length === 0 ? toStringValue(ctx.node) : await this.evalString(args[0], ctx);
        return s.trim().replace(/\s+/g, ' ');
      }
      case TRANSLATE: {
        requireArity(name, args, 3);
        const str = await this.evalString(args[0], ctx);
        const from = await this.evalString(args[1], ctx);
        const to = await this.evalString(args[2], ctx);
        return str
          .split('')
          .map((ch) => {
            const i = from.indexOf(ch);
            if (i === -1) return ch;
            return i < to.length ? to[i] : '';
          })
          .join('');
      }
      case NAME:
      case LOCAL_NAME: {
        requireArityMax(name, args, 1);
        const target = args.length === 0 ? ctx.node : (await this.firstElement(args[0], ctx));
        return target ? await target.tagName() : '';
      }
      case NUMBER:
        requireArityMax(name, args, 1);
        return args.length === 0 ? toNumber(ctx.node) : this.evalNumber(args[0], ctx);
      case FLOOR:
        requireArity(name, args, 1);
        return Math.floor(await this.evalNumber(args[0], ctx));
      case CEILING:
        requireArity(name, args, 1);
        return Math.ceil(await this.evalNumber(args[0], ctx));
      case ROUND:
        requireArity(name, args, 1);
        return Math.round(await this.evalNumber(args[0], ctx));
      case SUM: {
        requireArity(name, args, 1);
        const ns = await this.evalNodeSet(args[0], ctx);
        return ns.reduce<number>((acc, v) => acc + toNumber(v), 0);
      }
      case ID:
        throw new InvalidSelectorError(`XPath function id() is not supported by this driver.`);
      default:
        throw new InvalidSelectorError(`XPath function ${name}() not found.`);
    }
  }

  /** Resolve the first element of a node-set expr (for name()/local-name()). */
  private async firstElement(node: ExprNode, ctx: EvalCtx): Promise<XElement | undefined> {
    const ns = await this.evalNodeSet(node, ctx);
    const first = ns[0];
    return first instanceof XElement ? first : undefined;
  }
}

// ---------------------------------------------------------------------------
// Condition matching (TS-side, for walk-produced candidates)
// ---------------------------------------------------------------------------

async function matchesCondition(el: XElement, cond: Condition): Promise<boolean> {
  switch (cond.kind) {
    case 'true':
      return true;
    case 'and':
      for (const c of cond.children) if (!(await matchesCondition(el, c))) return false;
      return true;
    case 'or':
      for (const c of cond.children) if (await matchesCondition(el, c)) return true;
      return false;
    case 'not':
      return !(await matchesCondition(el, cond.child));
    case 'property': {
      const actual = await el.getProp(cond.prop);
      if (typeof cond.value === 'boolean') {
        return toBoolean(actual as XValue) === cond.value;
      }
      return String(actual ?? '') === String(cond.value);
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// XPath type coercions (§1, §3.4, §4)
// ---------------------------------------------------------------------------

function toBoolean(v: XValue): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  if (typeof v === 'string') return v.length > 0;
  return true; // an element node is truthy
}

function toNumber(v: XValue): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof XElement) return NaN;
  const str = String(v ?? '');
  return /^\s*[+-]?(?:\d*\.)?\d+\s*$/.test(str) || /^\s*[+-]?\d+\.\d*\s*$/.test(str)
    ? Number(str)
    : NaN;
}

function toStringValue(v: XValue): string {
  if (v instanceof XElement) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return 'NaN';
    if (v === Infinity) return 'Infinity';
    if (v === -Infinity) return '-Infinity';
    return String(v);
  }
  return v ?? '';
}

/** XPath scalar `=` comparison after type coercion (boolean > number > string precedence). */
function scalarEquals(a: XValue, b: XValue): boolean {
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    return toBoolean(a) === toBoolean(b);
  }
  if (typeof a === 'number' || typeof b === 'number') {
    return toNumber(a) === toNumber(b);
  }
  return toStringValue(a) === toStringValue(b);
}

function isNodeSetExpr(node: ExprNode): boolean {
  return (
    node.type === RELATIVE_LOCATION_PATH ||
    node.type === ABSOLUTE_LOCATION_PATH ||
    node.type === PATH ||
    node.type === UNION
  );
}

function isAttrWildcard(node: ExprNode): boolean {
  return (
    node.type === RELATIVE_LOCATION_PATH &&
    node.steps.length === 1 &&
    node.steps[0].axis === ATTRIBUTE &&
    node.steps[0].test.type === NODE_NAME_TEST &&
    node.steps[0].test.name === '*'
  );
}

// ---------------------------------------------------------------------------
// Step helpers
// ---------------------------------------------------------------------------

/** Map a forward axis to a backend TreeScope, or undefined for non-forward axes. */
function forwardAxisScope(axis: string): TreeScopeName | undefined {
  switch (axis) {
    case CHILD:
      return 'children';
    case DESCENDANT:
      return 'descendants';
    case DESCENDANT_OR_SELF:
      return 'subtree';
    case SELF:
      return 'element';
    default:
      return undefined;
  }
}

/** Pick 1-based positions (LAST_POSITION → last element) from a list, preserving request order. */
function selectPositions(els: XElement[], positions: number[]): XElement[] {
  const out: XElement[] = [];
  for (const p of positions) {
    const idx = p === LAST_POSITION ? els.length - 1 : p - 1;
    if (idx >= 0 && idx < els.length) out.push(els[idx]);
  }
  return out;
}

/**
 * Collapse `descendant-or-self::node()/child::x` (what `//x` desugars to) into a single
 * descendant step, so we emit one backend find instead of two.
 */
function collapseDoubleSlash(steps: StepNode[]): StepNode[] {
  const out: StepNode[] = [];
  for (let i = 0; i < steps.length; i++) {
    const cur = steps[i];
    const next = steps[i + 1];
    if (
      next &&
      cur.axis === DESCENDANT_OR_SELF &&
      cur.test.type === NODE_TYPE_TEST &&
      cur.predicates.length === 0 &&
      next.axis === CHILD
    ) {
      out.push({ axis: DESCENDANT, test: next.test, predicates: next.predicates });
      i++;
      continue;
    }
    out.push(cur);
  }
  return out;
}

function dedupe(els: XElement[]): XElement[] {
  const seen = new Set<string>();
  const out: XElement[] = [];
  for (const el of els) {
    if (!seen.has(el.runtimeId)) {
      seen.add(el.runtimeId);
      out.push(el);
    }
  }
  return out;
}

function requireArity(name: string, args: ExprNode[], n: number): void {
  if (args.length !== n) {
    throw new InvalidSelectorError(`Function ${name}() requires exactly ${n} argument(s).`);
  }
}

function requireArityMax(name: string, args: ExprNode[], n: number): void {
  if (args.length > n) {
    throw new InvalidSelectorError(`Function ${name}() accepts no more than ${n} argument(s).`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse an XPath selector and resolve it to runtime-id strings via the injected backend.
 *
 * @param selector  the XPath string
 * @param multiple  true for findElements (all), false for findElement (the caller decides on empty)
 * @param contextId starting element id; when undefined the automation root is used
 * @param backend   the XPathBackend, OR (back-compat) a bare `find` callback
 */
export async function xpathToElementIds(
  selector: string,
  multiple: boolean,
  contextId: string | undefined,
  backend: XPathBackend | FindViaBackend,
): Promise<string[]> {
  let parsed: ExprNode;
  try {
    parsed = new (resolveAnalyzer())(selector).parse();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new InvalidSelectorError(`Malformed XPath: ${msg}`);
  }

  const resolved = normalizeBackend(backend);
  // Absolute paths (`/…`, `//…`) always resolve from the automation root, regardless of context.
  // The context element only seeds relative paths.
  const executor = new XPathExecutor(resolved, AUTOMATION_ROOT_ID, !multiple);
  const startNode = new XElement(contextId ?? AUTOMATION_ROOT_ID, resolved);
  const els = await executor.resolveToElements(parsed, [startNode]);
  const ids = els.map((e) => e.runtimeId);
  return multiple ? ids : ids.slice(0, 1);
}

/** Accept either a full XPathBackend or a legacy bare find callback. */
function normalizeBackend(backend: XPathBackend | FindViaBackend): XPathBackend {
  if (typeof backend === 'function') {
    return {
      find: backend,
      walk: async () => {
        throw new InvalidSelectorError(
          'This XPath requires tree-walking (reverse/sibling axis), but the backend does not implement walk().',
        );
      },
      attributes: async () => {
        throw new InvalidSelectorError(
          'This XPath requires attribute evaluation, but the backend does not implement attributes().',
        );
      },
    };
  }
  return backend;
}

// Re-export so callers don't need a second import.
export type { BackendOp } from '../backend/ops.js';
