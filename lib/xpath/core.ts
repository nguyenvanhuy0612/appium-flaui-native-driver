// XPath engine (Phase 3) — ports nova2's XPathExecutor onto our structured backend op contract.
//
// Design (per docs/DECISIONS.md ADR-003 + design spec §5.3):
//   - Parse the XPath string with `xpath-analyzer` (same parser as nova2).
//   - Walk the parsed AST one location step at a time. For each step build a structured
//     `Condition` (from lib/backend/ops.ts) + a UIA `TreeScope`, then resolve elements by
//     invoking the injected async callback `findViaBackend(op)` — i.e. we emit `findOp({...})`
//     calls rather than nova2's PowerShell strings. The sidecar interprets the op natively.
//
// SUPPORTED (this Phase-3 subset):
//   - Absolute location paths        (`/Window/Edit`)
//   - Relative location paths        (`Button`, `Pane/Button`)
//   - Descendant shorthand `//`      (`//Button`, `Window//Edit`)  → descendant / descendant-or-self
//   - Axes: child, descendant, descendant-or-self, self, attribute (terminal `@x` returns values)
//   - Node-name tests                (`Button`, `Edit`, `*` wildcard, `node()`)
//   - Attribute equality predicates  (`[@Name="OK"]`, `[@AutomationId='id']`, `[@ClassName="x"]`)
//   - Attribute inequality           (`[@Name!="OK"]`)  → not(property)
//   - Conjunction / disjunction      (`[@Name="a" and @ClassName="b"]`, `... or ...`)
//   - Positional predicates          (`[1]`, `(//ListItem)[1]`, `[last()]`) — applied in TS after the find
//   - Union of paths                 (`//A | //B`)
//   - `findFirst` optimization for single-element (`multiple=false`) leaf steps with no positional/JS filter
//
// NOT YET SUPPORTED (documented gaps; these throw InvalidSelectorError or are ignored cleanly —
// no broken/placeholder behavior):
//   - Reverse / sibling axes: ancestor(-or-self), parent, following(-sibling), preceding(-sibling),
//     namespace. (Parent/ancestor are recognized but rejected with a clear error.)
//   - XPath string functions inside predicates: contains(), starts-with(), normalize-space(), etc.
//     (nova2 offloaded these to PowerShell -like filters; the structured-op equivalent is future work.)
//   - Arithmetic / relational numeric predicates beyond a bare positional `[n]` / `[last()]`.
//   - `@*` wildcard-attribute comparisons and attribute value extraction beyond simple terminal `@x`.
//   - The `path` production with a non-location filter primary other than a parenthesised location path
//     carrying a positional predicate (the common `(//X)[n]` case IS supported).

import * as XPathAnalyzerModule from 'xpath-analyzer';
import {
  ABSOLUTE_LOCATION_PATH,
  AND,
  ANCESTOR,
  ANCESTOR_OR_SELF,
  ATTRIBUTE,
  CHILD,
  DESCENDANT,
  DESCENDANT_OR_SELF,
  EQUALITY,
  FILTER,
  FOLLOWING,
  FOLLOWING_SIBLING,
  FUNCTION_CALL,
  INEQUALITY,
  LAST,
  LITERAL,
  NAMESPACE,
  NODE,
  NODE_NAME_TEST,
  NODE_TYPE_TEST,
  NUMBER,
  OR,
  PARENT,
  PATH,
  POSITION,
  PRECEDING,
  PRECEDING_SIBLING,
  RELATIVE_LOCATION_PATH,
  SELF,
  UNION,
  type ExprNode,
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
 * (`module.exports.default.default` is the class). Resolve the actual constructor robustly
 * across the possible shapes so this works under NodeNext ESM + tsx and a real build alike.
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

/** Result row shape returned by the injected backend callback. */
export interface FoundElement {
  runtimeId: string;
}

/** Injected async resolver: takes a structured backend op and returns the matched elements. */
export type FindViaBackend = (op: BackendOp) => Promise<FoundElement[]>;

/** Thrown for malformed or unsupported XPath. Name matches W3C `invalid selector`. */
export class InvalidSelectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSelectorError';
  }
}

/**
 * Map a UIA control-type-ish node name (PascalCase tag) to a ControlType condition,
 * with a couple of nova2's compatibility groupings (List≈DataGrid, ListItem≈DataItem).
 */
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
  return propertyCondition('ControlType', name);
}

/** Build the base condition for a node test. `node()` / `*` => match-anything. */
function nodeTestToCondition(test: NodeTestNode): Condition {
  switch (test.type) {
    case NODE_NAME_TEST:
      return nodeNameToCondition(test.name);
    case NODE_TYPE_TEST:
      if (test.name === NODE) {
        return { kind: 'true' };
      }
      // text()/comment()/processing-instruction() never match UIA elements.
      return { kind: 'not', child: { kind: 'true' } };
    default:
      return { kind: 'not', child: { kind: 'true' } };
  }
}

/** Map an XPath axis to a backend TreeScope. Returns undefined for unsupported axes. */
function axisToScope(axis: string): TreeScopeName | undefined {
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

/** Extract a literal/number value from a primary AST node, or undefined. */
function literalValue(node: ExprNode): string | number | undefined {
  if (node.type === LITERAL) {
    return node.string;
  }
  if (node.type === NUMBER) {
    return node.number;
  }
  return undefined;
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

/**
 * Try to turn one predicate ExprNode into a structured backend Condition.
 * Supported: @attr = value, @attr != value, and/or of those.
 * Returns undefined if the predicate is not expressible as a structured condition.
 */
function predicateToCondition(pred: ExprNode): Condition | undefined {
  switch (pred.type) {
    case AND: {
      const lhs = predicateToCondition(pred.lhs);
      const rhs = predicateToCondition(pred.rhs);
      if (lhs && rhs) {
        return andCondition(lhs, rhs);
      }
      return undefined;
    }
    case OR: {
      const lhs = predicateToCondition(pred.lhs);
      const rhs = predicateToCondition(pred.rhs);
      if (lhs && rhs) {
        return orCondition(lhs, rhs);
      }
      return undefined;
    }
    case EQUALITY:
    case INEQUALITY: {
      // Identify which side is the @attr and which is the literal.
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
      if (attr === '*') {
        return undefined; // @* wildcard not supported in this subset
      }
      const value = literalValue(valueNode!);
      if (value === undefined) {
        return undefined;
      }
      const cond = propertyCondition(normalizePropName(attr!), value);
      return pred.type === INEQUALITY ? notCondition(cond) : cond;
    }
    default:
      return undefined;
  }
}

/**
 * Normalize an attribute name to the backend's PascalCase UIA property name.
 * Accepts common nova2/Appium spellings case-insensitively; passes unknown names through verbatim.
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
  };
  return known[attr.toLowerCase()] ?? attr;
}

/**
 * Recognize a bare positional predicate and return the requested 1-based positions.
 *   [1]          → {1}
 *   [last()]     → {LAST}
 *   [position()=2] / [2=position()] → {2}
 * Returns undefined when the predicate is not positional.
 */
const LAST_POSITION = 0x7fffffff;

function positionalValue(pred: ExprNode): number | undefined {
  if (pred.type === NUMBER) {
    return pred.number;
  }
  if (pred.type === FUNCTION_CALL && pred.name === LAST) {
    return LAST_POSITION;
  }
  if (pred.type === EQUALITY) {
    const isPos = (n: ExprNode) => n.type === FUNCTION_CALL && n.name === POSITION;
    if (isPos(pred.lhs) && !isPos(pred.rhs)) {
      const v = literalValue(pred.rhs);
      if (typeof v === 'number') return v;
      if (pred.rhs.type === FUNCTION_CALL && pred.rhs.name === LAST) return LAST_POSITION;
    }
    if (isPos(pred.rhs) && !isPos(pred.lhs)) {
      const v = literalValue(pred.lhs);
      if (typeof v === 'number') return v;
      if (pred.lhs.type === FUNCTION_CALL && pred.lhs.name === LAST) return LAST_POSITION;
    }
  }
  return undefined;
}

const REVERSE_OR_UNSUPPORTED_AXES = new Set<string>([
  ANCESTOR,
  ANCESTOR_OR_SELF,
  PARENT,
  FOLLOWING,
  FOLLOWING_SIBLING,
  PRECEDING,
  PRECEDING_SIBLING,
  NAMESPACE,
]);

interface ExecOptions {
  /** Optimize: emit `multiple:false` for the final step (single-element queries). */
  optimizeLastStep: boolean;
}

class XPathExecutor {
  constructor(
    private readonly findViaBackend: FindViaBackend,
    private readonly rootId: string,
  ) {}

  /** Resolve a top-level expression to a list of runtime-id strings. */
  async resolve(node: ExprNode, contextIds: string[], opts: ExecOptions): Promise<string[]> {
    switch (node.type) {
      case UNION: {
        const lhs = await this.resolve(node.lhs, contextIds, opts);
        const rhs = await this.resolve(node.rhs, contextIds, opts);
        return dedupe([...lhs, ...rhs]);
      }
      case ABSOLUTE_LOCATION_PATH:
        return this.walkSteps(node.steps, [this.rootId], opts, true);
      case RELATIVE_LOCATION_PATH:
        return this.walkSteps(node.steps, contextIds, opts, false);
      case PATH:
        return this.resolvePath(node, contextIds, opts);
      case FILTER:
        return this.resolveFilter(node, contextIds, opts);
      default:
        throw new InvalidSelectorError(
          `Unsupported XPath expression at top level: '${node.type}'.`,
        );
    }
  }

  /** Handle `(primary)/steps` — e.g. `(//ListItem)[1]/Button`. */
  private async resolvePath(
    node: Extract<ExprNode, { type: typeof PATH }>,
    contextIds: string[],
    opts: ExecOptions,
  ): Promise<string[]> {
    const filtered = await this.resolve(node.filter, contextIds, {
      optimizeLastStep: false,
    });
    return this.walkSteps(node.steps, filtered, opts, false);
  }

  /** Handle `(primary)[predicates]` — e.g. `(//ListItem)[1]`. */
  private async resolveFilter(
    node: Extract<ExprNode, { type: typeof FILTER }>,
    contextIds: string[],
    opts: ExecOptions,
  ): Promise<string[]> {
    const base = await this.resolve(node.primary, contextIds, { optimizeLastStep: false });
    return applyPredicatesInTs(base, node.predicates);
  }

  /**
   * Walk a sequence of location steps, threading the element set through each step.
   * `isAbsolute` only affects the very first step (root context already provided by caller).
   */
  private async walkSteps(
    steps: StepNode[],
    contextIds: string[],
    opts: ExecOptions,
    isAbsolute: boolean,
  ): Promise<string[]> {
    if (steps.length === 0) {
      return contextIds;
    }

    // `//x` is parsed as descendant-or-self::node() / child::x. Collapse that pair into a
    // single descendant step so we emit one backend find instead of two.
    const collapsed = collapseDoubleSlash(steps, isAbsolute);

    let current = contextIds;
    for (let i = 0; i < collapsed.length; i++) {
      const step = collapsed[i];
      const isLast = i === collapsed.length - 1;

      if (step.axis === ATTRIBUTE) {
        // Terminal attribute step: not an element set. This subset does not extract attribute
        // value strings as locator results; signal clearly rather than return garbage.
        throw new InvalidSelectorError(
          'Attribute-axis terminal steps (e.g. /…/@Name) are not supported as element locators.',
        );
      }
      if (REVERSE_OR_UNSUPPORTED_AXES.has(step.axis)) {
        throw new InvalidSelectorError(`Unsupported XPath axis: '${step.axis}'.`);
      }

      const scope = axisToScope(step.axis);
      if (!scope) {
        throw new InvalidSelectorError(`Unsupported XPath axis: '${step.axis}'.`);
      }

      // Split predicates into structured (pushed to backend) vs positional (applied in TS).
      const structured: Condition[] = [];
      const positions: number[] = [];
      let sawPositional = false;
      const postPositional: ExprNode[] = [];

      for (const pred of step.predicates) {
        const pos = positionalValue(pred);
        if (pos !== undefined) {
          positions.push(pos);
          sawPositional = true;
          continue;
        }
        const cond = predicateToCondition(pred);
        if (cond && !sawPositional) {
          structured.push(cond);
        } else if (cond && sawPositional) {
          // condition after a positional predicate must be applied post-position; but we can only
          // express structured conditions at find-time, so defer as an (unsupported) JS predicate.
          postPositional.push(pred);
        } else {
          // Not expressible structurally (functions, arithmetic, @* …) — unsupported in this subset.
          throw new InvalidSelectorError(
            `Unsupported XPath predicate in step '${describeStep(step)}'.`,
          );
        }
      }
      if (postPositional.length > 0) {
        throw new InvalidSelectorError(
          'Predicates following a positional predicate are not supported in this subset.',
        );
      }

      const base = nodeTestToCondition(step.test);
      const condition: Condition =
        structured.length > 0 ? andCondition(base, ...structured) : base;

      const canFindFirst =
        isLast && opts.optimizeLastStep && positions.length === 0 && current.length === 1;

      const found = await this.runFind(current, scope, condition, !canFindFirst);

      current = positions.length > 0 ? selectPositions(found, positions) : found;

      if (current.length === 0) {
        return [];
      }
    }

    return dedupe(current);
  }

  /** Emit one find op per context element and merge the results (dedup, order-preserving). */
  private async runFind(
    contextIds: string[],
    scope: TreeScopeName,
    condition: Condition,
    multiple: boolean,
  ): Promise<string[]> {
    const out: string[] = [];
    for (const startId of contextIds) {
      const res = await this.findViaBackend(
        findOp({ startId, multiple, scope, condition }),
      );
      for (const el of res) {
        out.push(el.runtimeId);
      }
    }
    return dedupe(out);
  }
}

/** Apply only positional predicates (TS-side) to a flat element list. */
function applyPredicatesInTs(ids: string[], predicates: ExprNode[]): string[] {
  let current = ids;
  for (const pred of predicates) {
    const pos = positionalValue(pred);
    if (pos === undefined) {
      throw new InvalidSelectorError(
        'Only positional predicates are supported on a parenthesised expression.',
      );
    }
    current = selectPositions(current, [pos]);
  }
  return current;
}

/** Pick 1-based positions (LAST_POSITION → last element) from a list, preserving request order. */
function selectPositions(ids: string[], positions: number[]): string[] {
  const out: string[] = [];
  for (const p of positions) {
    const idx = p === LAST_POSITION ? ids.length - 1 : p - 1;
    if (idx >= 0 && idx < ids.length) {
      out.push(ids[idx]);
    }
  }
  return out;
}

/**
 * Collapse the `descendant-or-self::node()/child::x` pair that `//x` desugars to into a single
 * descendant (or descendant-or-self for `.//` at the context root) step.
 */
function collapseDoubleSlash(steps: StepNode[], isAbsolute: boolean): StepNode[] {
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
      // For an absolute `//x` the search should reach descendants of root.
      out.push({ axis: DESCENDANT, test: next.test, predicates: next.predicates });
      i++; // consume the child step too
      continue;
    }
    out.push(cur);
  }
  // `isAbsolute` is accepted for API symmetry; the root context is already supplied by the caller.
  void isAbsolute;
  return out;
}

function describeStep(step: StepNode): string {
  const name = step.test.type === NODE_NAME_TEST ? step.test.name : step.test.name;
  return `${step.axis}::${name ?? 'node()'}`;
}

function dedupe(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Parse an XPath selector and resolve it to runtime-id strings via the injected backend callback.
 *
 * @param selector       the XPath string
 * @param multiple       true for findElements (return all), false for findElement (single)
 * @param contextId      starting element id; when undefined the automation root is used
 * @param findViaBackend async resolver emitting structured backend `find` ops
 * @returns array of runtime-id strings (length 0..1 conceptually for `multiple=false`, but the
 *          caller is responsible for the no-such-element decision)
 */
export async function xpathToElementIds(
  selector: string,
  multiple: boolean,
  contextId: string | undefined,
  findViaBackend: FindViaBackend,
): Promise<string[]> {
  let parsed: ExprNode;
  try {
    parsed = new (resolveAnalyzer())(selector).parse();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new InvalidSelectorError(`Malformed XPath: ${msg}`);
  }

  const rootId = contextId ?? AUTOMATION_ROOT_ID;
  const executor = new XPathExecutor(findViaBackend, rootId);
  const startContext = [contextId ?? rootId];
  return executor.resolve(parsed, startContext, { optimizeLastStep: !multiple });
}

/** Sentinel id meaning "the UIA automation root"; the sidecar maps this to its root element. */
export const AUTOMATION_ROOT_ID = 'root';
