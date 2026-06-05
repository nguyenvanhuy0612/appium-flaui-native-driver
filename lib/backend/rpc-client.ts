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

  async health(timeoutMs = 2_000): Promise<boolean> {
    try {
      const r = (await this.fetchJson('GET', '/status', undefined, timeoutMs)) as { ready?: boolean } | null;
      return !!(r && r.ready);
    } catch {
      return false;
    }
  }

  async op<T = unknown>(op: BackendOp, timeoutMs?: number): Promise<T> {
    const res = (await this.fetchJson('POST', '/op', op, timeoutMs)) as BackendResult<T>;
    if (res.ok) return res.value;
    throw new RpcError(res.error.type, res.error.message);
  }

  async session(body: Record<string, unknown>, timeoutMs?: number): Promise<{ rootId: string }> {
    const res = (await this.fetchJson('POST', '/session', body, timeoutMs)) as BackendResult<{ rootId: string }>;
    if (res.ok) return res.value;
    throw new RpcError(res.error.type, res.error.message);
  }

  /** Close the sidecar session (closes the app per shouldCloseApp). Best-effort companion to stop(). */
  async deleteSession(): Promise<void> {
    const res = (await this.fetchJson('DELETE', '/session')) as BackendResult<unknown>;
    if (!res.ok) throw new RpcError(res.error.type, res.error.message);
  }

  private async fetchJson(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<unknown> {
    // Per-call timeout (D, nested timeouts): the caller passes operationTimeout+grace for UIA ops, or a
    // larger value for long ops like PowerShell, so the RPC layer always sits just ABOVE the sidecar's own
    // per-op watchdog (never aborts a legitimately-running op before the backend answers).
    const callTimeout = timeoutMs ?? this.timeoutMs;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), callTimeout);
    // HARD backstop deadline (does NOT rely on the AbortController). A fetch waiting on a half-open
    // connection — sidecar process died/froze mid-request — has been observed in the wild NOT to honour
    // the abort signal, leaving this promise pending forever. Because the driver serialises commands per
    // session, one never-settling RPC wedges the WHOLE command queue indefinitely. Promise.race against an
    // independent timer guarantees the RPC always settles. We reject with a plain Error (NOT an RpcError),
    // so the caller treats it as a TRANSPORT failure and fails the session (a clean RpcError would be
    // taken as a live backend response). Grace of 5s lets the sidecar's own op-watchdog answer first.
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    const hardDeadline = new Promise<never>((_, reject) => {
      hardTimer = setTimeout(
        () => reject(new Error(`sidecar RPC exceeded ${callTimeout + 5000}ms (${method} ${path}) — transport hang`)),
        callTimeout + 5000,
      );
    });
    const work = (async () => {
      const r = await fetch(this.baseUrl + path, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      // Guard the body parse (F18): a non-JSON or non-2xx response (e.g. a Kestrel 500 HTML page if an
      // op handler ever threw before writing an envelope) would make r.json() reject with an opaque
      // SyntaxError. Synthesize a clean RpcError carrying the HTTP status + body text instead.
      const text = await r.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        throw new RpcError('unknown error', `sidecar returned non-JSON (HTTP ${r.status}): ${text.slice(0, 300)}`);
      }
      if (!r.ok && (parsed == null || typeof parsed !== 'object' || !('ok' in (parsed as object)))) {
        throw new RpcError('unknown error', `sidecar HTTP ${r.status}: ${text.slice(0, 300)}`);
      }
      return parsed;
    })();
    // Observe a late settle of `work` if the hard deadline won the race, so it never becomes an
    // unhandled rejection.
    work.catch(() => {});
    try {
      return await Promise.race([work, hardDeadline]);
    } finally {
      clearTimeout(t);
      if (hardTimer) clearTimeout(hardTimer);
    }
  }
}
