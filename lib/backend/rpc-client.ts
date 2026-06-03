import type { BackendOp, BackendResult } from './ops.js';

export class RpcError extends Error {
  constructor(public type: string, message: string) {
    super(message);
    this.name = 'RpcError';
  }
}

/** Thin HTTP/JSON client to the sidecar. Unwraps BackendResult, throwing RpcError on { ok:false }. */
export class RpcClient {
  constructor(private baseUrl: string, private timeoutMs = 30_000) {}

  async health(): Promise<boolean> {
    try {
      const r = (await this.fetchJson('GET', '/status')) as { ready?: boolean } | null;
      return !!(r && r.ready);
    } catch {
      return false;
    }
  }

  async op<T = unknown>(op: BackendOp): Promise<T> {
    const res = (await this.fetchJson('POST', '/op', op)) as BackendResult<T>;
    if (res.ok) return res.value;
    throw new RpcError(res.error.type, res.error.message);
  }

  async session(body: Record<string, unknown>): Promise<{ rootId: string }> {
    const res = (await this.fetchJson('POST', '/session', body)) as BackendResult<{ rootId: string }>;
    if (res.ok) return res.value;
    throw new RpcError(res.error.type, res.error.message);
  }

  /** Close the sidecar session (closes the app per shouldCloseApp). Best-effort companion to stop(). */
  async deleteSession(): Promise<void> {
    const res = (await this.fetchJson('DELETE', '/session')) as BackendResult<unknown>;
    if (!res.ok) throw new RpcError(res.error.type, res.error.message);
  }

  private async fetchJson(method: string, path: string, body?: unknown): Promise<unknown> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const r = await fetch(this.baseUrl + path, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      return await r.json();
    } finally {
      clearTimeout(t);
    }
  }
}
