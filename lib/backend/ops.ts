// The seam contract (ADR-003): structured JSON ops, never PowerShell strings.

export type Condition =
  | { kind: 'property'; prop: string; value: string | number | boolean }
  | { kind: 'and'; children: Condition[] }
  | { kind: 'or'; children: Condition[] }
  | { kind: 'not'; child: Condition }
  | { kind: 'true' };

export const propertyCondition = (prop: string, value: string | number | boolean): Condition =>
  ({ kind: 'property', prop, value });
export const andCondition = (...children: Condition[]): Condition => ({ kind: 'and', children });
export const orCondition = (...children: Condition[]): Condition => ({ kind: 'or', children });
export const notCondition = (child: Condition): Condition => ({ kind: 'not', child });

export type TreeScopeName = 'element' | 'children' | 'descendants' | 'subtree';

export type BackendOp =
  | { op: 'find'; startId: string; multiple: boolean; scope: TreeScopeName; condition: Condition }
  | { op: 'attributes'; id: string; names: string[] | 'all' }
  | { op: 'action'; id: string; action: string; args?: Record<string, unknown> }
  | { op: 'source'; startId: string; rawView?: boolean }
  | {
      op: 'input';
      kind: 'click' | 'hover' | 'keys' | 'scroll' | 'clickAndDrag' | 'move' | 'down' | 'up';
      args: Record<string, unknown>;
    }
  | { op: 'screenshot'; id?: string }
  | { op: 'clipboard'; action: 'get' | 'set'; contentType?: string; b64?: string }
  | { op: 'walk'; id: string; direction: 'parent' | 'ancestors' | 'following-siblings' | 'preceding-siblings' }
  | { op: 'window'; action: 'title' | 'handle' | 'rect' | 'setRect' | 'maximize' | 'minimize'; args?: Record<string, unknown> }
  | { op: 'app'; action: 'launch' | 'close' | 'activate'; process?: string }
  | { op: 'powershell'; script: string };

export interface BasicProps {
  runtimeId: string;
  name?: string;
  automationId?: string;
  className?: string;
  controlType?: string;
  isEnabled?: boolean;
  isOffscreen?: boolean;
}

export type W3CErrorType =
  | 'timeout'
  | 'stale element reference'
  | 'no such element'
  | 'invalid selector'
  | 'unknown error';

export type BackendResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: { type: W3CErrorType; message: string } };

export const findOp = (p: Omit<Extract<BackendOp, { op: 'find' }>, 'op'>): BackendOp =>
  ({ op: 'find', ...p });

export const attributesOp = (id: string, names: string[] | 'all'): BackendOp =>
  ({ op: 'attributes', id, names });

export const actionOp = (id: string, action: string, args?: Record<string, unknown>): BackendOp =>
  ({ op: 'action', id, action, args });

export const sourceOp = (startId: string, rawView?: boolean): BackendOp =>
  ({ op: 'source', startId, rawView });

export const inputOp = (
  kind: Extract<BackendOp, { op: 'input' }>['kind'],
  args: Record<string, unknown>,
): BackendOp => ({ op: 'input', kind, args });
