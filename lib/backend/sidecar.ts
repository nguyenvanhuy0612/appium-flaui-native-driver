import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { RpcClient } from './rpc-client.js';

export interface SidecarOptions {
  command: string;
  args: string[];
  startupTimeoutMs?: number;
  /** Default RPC timeout (ms) for the client; the driver wires this to operationTimeout+grace (D). */
  rpcTimeoutMs?: number;
}

/** Owns the sidecar child process: spawn, port handshake, health, and clean shutdown. */
export class Sidecar {
  private proc?: ChildProcessWithoutNullStreams;
  baseUrl = '';
  client!: RpcClient;
  /** Set by the persistent exit listener once the child process actually dies (any cause). */
  private exited = false;
  private exitInfo?: { code: number | null; signal: NodeJS.Signals | null };
  /** Set by the persistent 'error' listener on a spawn-level failure (ENOENT / EACCES / blocked exe). */
  private spawnError?: Error;

  get isRunning(): boolean {
    // A spawn-level failure never gives the process an exitCode, so guard on `exited` (set by the 'error'
    // listener) too — otherwise a process that failed to launch would falsely report as running.
    return !!this.proc && this.proc.exitCode === null && !this.exited;
  }

  /** True once the child process has died (C: sidecar-death → fail session). */
  get hasExited(): boolean {
    return this.exited;
  }

  /** Human-readable exit reason for error messages (e.g. "code 3" / "signal SIGKILL"). */
  get exitReason(): string {
    if (!this.exited) return 'running';
    if (this.spawnError) return `failed to start (${this.spawnError.message})`;
    if (this.exitInfo?.signal) return `signal ${this.exitInfo.signal}`;
    return `code ${this.exitInfo?.code ?? 'unknown'}`;
  }

  constructor(private opts: SidecarOptions) {}

  async start(): Promise<void> {
    const proc = spawn(this.opts.command, this.opts.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');

    // Persistent exit listener (C): record death from ANY cause (crash, idle self-exit, kill). Attached
    // UP FRONT — before the handshake — so an early-phase death is tracked too, and so stop() never awaits
    // an 'exit' that already fired.
    proc.on('exit', (code, signal) => {
      this.exited = true;
      this.exitInfo = { code, signal };
    });
    // Persistent 'error' listener (P0-3): a spawn-level failure (exe not found / not executable / blocked by
    // AV) emits 'error' on the process, NOT a normal 'exit'. With NO listener Node escalates it to a
    // process-level uncaughtException that can take down the whole Appium server. Record it as a death so
    // hasExited/isRunning reflect reality; the handshake promise below rejects cleanly on the same event.
    proc.on('error', (err) => {
      this.exited = true;
      this.spawnError = err;
    });

    try {
      const port = await new Promise<number>((resolve, reject) => {
        const to = setTimeout(
          () => reject(new Error('sidecar startup timeout')),
          this.opts.startupTimeoutMs ?? 15_000,
        );
        let buf = '';
        proc.stdout.on('data', (chunk: string) => {
          buf += chunk;
          const m = buf.match(/PORT=(\d+)/);
          if (m) {
            clearTimeout(to);
            resolve(Number(m[1]));
          }
        });
        proc.on('exit', (code) => {
          clearTimeout(to);
          reject(new Error(`sidecar exited early: ${code}`));
        });
        // Spawn-level failure → reject the handshake with a clear, path-bearing message instead of letting
        // it surface as an uncaughtException (P0-3).
        proc.on('error', (err) => {
          clearTimeout(to);
          reject(new Error(`failed to launch sidecar at '${this.opts.command}': ${err.message}`));
        });
      });

      this.baseUrl = `http://127.0.0.1:${port}`;
      this.client = new RpcClient(this.baseUrl, this.opts.rpcTimeoutMs);

      // Wait until /status is ready (bounded ~5s). A SHORT per-probe timeout keeps the loop near its
      // budget even if the sidecar printed PORT then wedged (the default-timeout probe could block ~40s).
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (await this.client.health(2_000)) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('sidecar did not become healthy');
    } catch (e) {
      // Never leak the spawned child on a failed start (port-timeout / unhealthy / early-exit).
      try {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      throw e;
    }
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    const p = this.proc;
    this.proc = undefined;
    // Already dead? (the sidecar may self-exit or crash DURING teardown — e.g. its idle guard fires, or a
    // blocked DELETE handler is killed). The 'exit' event has then already fired, so attaching a new 'exit'
    // listener below would NEVER resolve and `await stop()` would hang forever — which wedges deleteSession.
    if (this.exited || p.exitCode !== null || p.signalCode !== null) return;
    try {
      p.stdin.end(); // triggers heartbeat self-exit in the sidecar
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => {
      if (p.exitCode !== null || p.signalCode !== null) {
        resolve();
        return; // raced to exit between the check above and here
      }
      const killTimer = setTimeout(() => {
        try {
          p.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, 2_000);
      // Hard cap: resolve even if the 'exit' event never arrives, so teardown can never wedge.
      const hardTimer = setTimeout(resolve, 4_000);
      p.once('exit', () => {
        clearTimeout(killTimer);
        clearTimeout(hardTimer);
        resolve();
      });
    });
  }
}
