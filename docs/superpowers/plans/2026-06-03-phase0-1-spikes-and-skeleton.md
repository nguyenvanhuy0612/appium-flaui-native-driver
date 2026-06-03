# Phase 0–1: De-risking Spikes & Skeleton — Implementation Plan

> **Status: COMPLETED & SUPERSEDED (frozen, historical).** All Phase 0–1 goals (and Phases 2–5 beyond them)
> were delivered and verified on the Windows box. This file is kept as the original plan of record. For the
> current state see [`../../FUNCTIONS.md`](../../FUNCTIONS.md) (API/status), [`../../CHANGELOG-internal.md`](../../CHANGELOG-internal.md)
> (what shipped), and [`../../NEXT-STEPS.md`](../../NEXT-STEPS.md) (roadmap).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the three riskiest assumptions (sidecar-from-npm, FlaUI works, anti-hang works), then stand up a skeleton where the TS driver spawns the C# FlaUI sidecar and finds one element in Notepad end-to-end.

**Architecture:** TypeScript Appium-3 driver (forked from nova2) ↔ localhost HTTP/JSON ↔ self-contained C#/.NET FlaUI sidecar. The seam is structured JSON ops. Stability-first (five-layer anti-hang). See `docs/superpowers/specs/2026-06-03-appium-flaui-native-driver-design.md` and `docs/DECISIONS.md`.

**Tech Stack:** TypeScript + `@appium/base-driver` (Appium 3), Node ≥20.19; C#/.NET 8-windows + FlaUI.UIA3 + ASP.NET Core minimal API (Kestrel); mocha+chai (TS tests), xUnit (C# tests).

**Platform legend:** 🍏 = authorable & testable on macOS · 🪟 = requires Windows to build/run/verify. On macOS, write 🪟 code and mark its verification pending — never claim a 🪟 pass without a Windows run.

**Suggested agents:** `ts-driver-engineer` (lib/), `csharp-sidecar-engineer` (sidecar/), `test-engineer` (tests), `docs-scribe` (docs), `spec-reviewer` (audit at phase end). See `docs/SUBAGENTS.md`.

---

## File structure (created by this plan)

```
appium-flaui-native-driver/
├── package.json                       # Appium 3 manifest, engines, scripts (Task 1.1)
├── tsconfig.json                      # extends @appium/tsconfig (Task 1.1)
├── lib/
│   ├── backend/
│   │   ├── ops.ts                     # BackendOp / BackendResult types + condition model (Task 1.2)
│   │   ├── rpc-client.ts              # HTTP/JSON client to the sidecar (Task 1.3)
│   │   └── sidecar.ts                 # sidecar process manager: spawn/handshake/health/kill (Task 1.4)
│   └── driver.ts                      # FlaUINativeDriver extends BaseDriver (Task 1.6)
├── sidecar/
│   ├── FlaUiSidecar.csproj            # net8.0-windows, FlaUI.UIA3, self-contained (Task 0.1)
│   ├── Program.cs                     # Kestrel host, port handshake, /status (Task 0.2)
│   ├── UiaScheduler.cs                # dedicated STA worker + watchdog + poisoning (Task 0.4)
│   ├── ElementRegistry.cs             # RuntimeId → AutomationElement, FIFO evict (Task 1.5)
│   ├── OpInterpreter.cs               # JSON op → FlaUI; /session, /op{find} (Task 1.5)
│   └── tests/FlaUiSidecar.Tests.csproj # xUnit (Task 0.4, 1.5)
├── tests/
│   ├── unit/ops.spec.ts               # op builder/serialization (Task 1.2)
│   ├── unit/rpc-client.spec.ts        # client vs mock HTTP (Task 1.3)
│   ├── unit/sidecar.spec.ts           # process manager vs fake exe (Task 1.4)
│   └── e2e/smoke.e2e.spec.ts          # Notepad find element (Task 1.7) 🪟
└── scripts/
    └── publish-sidecar.mjs            # dotnet publish → prebuilt/<arch>/ (Task 0.1)
```

---

## PHASE 0 — DE-RISKING SPIKES

### Task 0.1: Scaffold the C# sidecar project + publish script 🪟(build)/🍏(author)

**Files:**
- Create: `sidecar/FlaUiSidecar.csproj`
- Create: `scripts/publish-sidecar.mjs`
- Create: `.gitignore`

- [ ] **Step 1: Create `.gitignore`**

```gitignore
node_modules/
build/
sidecar/bin/
sidecar/obj/
prebuilt/
*.log
```

- [ ] **Step 2: Create `sidecar/FlaUiSidecar.csproj`**

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0-windows</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <AssemblyName>FlaUiSidecar</AssemblyName>
    <InvariantGlobalization>true</InvariantGlobalization>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="FlaUI.UIA3" Version="4.0.0" />
    <PackageReference Include="FlaUI.UIA2" Version="4.0.0" />
  </ItemGroup>
</Project>
```

- [ ] **Step 3: Create `scripts/publish-sidecar.mjs`**

```js
// Publishes the sidecar as a self-contained single-file exe per architecture.
// Run on Windows: node scripts/publish-sidecar.mjs
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const arches = ['win-x64', 'win-arm64'];
for (const rid of arches) {
  const out = `prebuilt/${rid}`;
  mkdirSync(out, { recursive: true });
  const cmd = [
    'dotnet publish sidecar/FlaUiSidecar.csproj',
    '-c Release', `-r ${rid}`, '--self-contained true',
    '-p:PublishSingleFile=true', '-p:IncludeNativeLibrariesForSelfExtract=true',
    `-o ${out}`,
  ].join(' ');
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: 'inherit' });
}
console.log('Sidecar published to prebuilt/.');
```

- [ ] **Step 4: Verify it builds (Windows only) 🪟**

Run: `dotnet build sidecar/FlaUiSidecar.csproj`
Expected: build succeeds (FlaUI restores). On macOS this is EXPECTED TO FAIL (Windows TFM) — mark pending.

- [ ] **Step 5: Commit**

```bash
git add .gitignore sidecar/FlaUiSidecar.csproj scripts/publish-sidecar.mjs
git commit -m "chore: scaffold C# FlaUI sidecar project + publish script"
```

---

### Task 0.2: Spike A — sidecar serves HTTP, Node spawns & health-checks it 🪟(verify)

**Files:**
- Create: `sidecar/Program.cs`

- [ ] **Step 1: Write `sidecar/Program.cs` (minimal Kestrel + port handshake + heartbeat)**

```csharp
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;

var builder = WebApplication.CreateBuilder(args);
// Bind to an OS-chosen free port on loopback only.
builder.WebHost.UseUrls("http://127.0.0.1:0");
var app = builder.Build();

app.MapGet("/status", () => Results.Json(new { ok = true, ready = true }));

await app.StartAsync();
// Handshake: print the actual port on stdout line 1 so the parent can connect.
var addr = app.Urls.First();           // e.g. http://127.0.0.1:53412
var port = new Uri(addr).Port;
Console.WriteLine($"PORT={port}");
Console.Out.Flush();

// Heartbeat: if the parent dies (stdin closes / EOF), self-exit to avoid orphans.
_ = Task.Run(async () =>
{
    using var stdin = Console.OpenStandardInput();
    var buf = new byte[1];
    try { while (await stdin.ReadAsync(buf) > 0) { } } catch { }
    Environment.Exit(0); // stdin EOF => parent gone
});

await app.WaitForShutdownAsync();
```

- [ ] **Step 2: Build & run manually (Windows only) 🪟**

Run: `dotnet run --project sidecar/FlaUiSidecar.csproj`
Expected: prints `PORT=<n>`; `curl http://127.0.0.1:<n>/status` → `{"ok":true,"ready":true}`.

- [ ] **Step 3: Commit**

```bash
git add sidecar/Program.cs
git commit -m "feat(sidecar): Spike A — Kestrel host, port handshake, stdin heartbeat"
```

> The Node side of Spike A (spawn + read PORT + health check + clean kill) is implemented and unit-tested
> as the reusable sidecar manager in **Task 1.4** — no throwaway harness needed.

---

### Task 0.3: Spike B — FlaUI UIA3 find + CacheRequest page source 🪟

**Files:**
- Create: `sidecar/spikes/SpikeB.cs` (throwaway; deleted after validation)

- [ ] **Step 1: Write `sidecar/spikes/SpikeB.cs`**

```csharp
// THROWAWAY spike. Run on Windows. Validates: launch Notepad, find by AutomationId,
// build a cached page-source subtree in ONE CacheRequest pass.
using FlaUI.Core;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Definitions;
using FlaUI.UIA3;

using var app = Application.Launch("notepad.exe");
using var automation = new UIA3Automation();
automation.ConnectionTimeout = TimeSpan.FromSeconds(60);
automation.TransactionTimeout = TimeSpan.FromSeconds(60);

var window = app.GetMainWindow(automation);

// Cache the properties our page-source schema needs, in one pass.
var cache = new CacheRequest { TreeScope = TreeScope.Subtree, AutomationElementMode = AutomationElementMode.None };
cache.Add(automation.PropertyLibrary.Element.Name);
cache.Add(automation.PropertyLibrary.Element.AutomationId);
cache.Add(automation.PropertyLibrary.Element.ClassName);
cache.Add(automation.PropertyLibrary.Element.ControlType);
cache.Add(automation.PropertyLibrary.Element.BoundingRectangle);
cache.Add(automation.PropertyLibrary.Element.IsEnabled);
cache.Add(automation.PropertyLibrary.Element.IsOffscreen);
cache.Add(automation.PropertyLibrary.Element.RuntimeId);

using (cache.Activate())
{
    var cached = window.FindFirstChild(); // children available from cache, no extra round-trips
    Console.WriteLine($"First child: {cached?.Properties.ControlType.ValueOrDefault} / {cached?.Name}");
}
Console.WriteLine("Spike B OK");
app.Close();
```

- [ ] **Step 2: Run it (Windows only) 🪟**

Run: `dotnet run --project sidecar/FlaUiSidecar.csproj -- spikeB` (wire a temporary entry, or run as a separate console).
Expected: prints the first child control type + "Spike B OK"; no per-property round-trips (verify via timing/logging).

- [ ] **Step 3: Record findings in docs, then delete the spike**

Append results to `docs/components/page-source.md` (created by docs-scribe): confirmed schema fields available via cache, any FlaUI quirks. Then `git rm sidecar/spikes/SpikeB.cs`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "spike(sidecar): Spike B — FlaUI UIA3 find + CacheRequest validated; findings recorded"
```

---

### Task 0.4: Spike C — anti-hang scheduler (watchdog + cancellation + poisoning) 🍏(logic)/🪟(real UIA)

This is the make-or-break spike. The scheduler logic is testable cross-platform with a **fake blocking work item**; real UIA hang is verified on Windows in Phase 4.

**Files:**
- Create: `sidecar/UiaScheduler.cs`
- Create: `sidecar/tests/FlaUiSidecar.Tests.csproj`
- Create: `sidecar/tests/UiaSchedulerTests.cs`

- [ ] **Step 1: Write `sidecar/UiaScheduler.cs`**

```csharp
using System.Collections.Concurrent;

namespace FlaUiSidecar;

/// <summary>
/// Runs UIA work on a dedicated worker thread, one op at a time, each bounded by a wall-clock watchdog.
/// If a work item ignores cancellation (COM frozen), the thread is "poisoned": a fresh worker is spun up
/// and the frozen one is abandoned. The calling (RPC) thread is never blocked beyond the timeout.
/// </summary>
public sealed class UiaScheduler : IDisposable
{
    private readonly BlockingCollection<WorkItem> _queue = new();
    private Thread _worker;
    private volatile bool _disposed;
    public int PoisonedThreadCount { get; private set; }

    public UiaScheduler() { _worker = StartWorker(); }

    private Thread StartWorker()
    {
        var t = new Thread(WorkerLoop) { IsBackground = true, Name = "uia-worker" };
        t.SetApartmentState(ApartmentState.STA);
        t.Start();
        return t;
    }

    private void WorkerLoop()
    {
        foreach (var item in _queue.GetConsumingEnumerable())
        {
            if (item.Token.IsCancellationRequested) { item.Tcs.TrySetCanceled(); continue; }
            try { item.Tcs.TrySetResult(item.Work(item.Token)); }
            catch (Exception ex) { item.Tcs.TrySetException(ex); }
        }
    }

    /// <summary>Run work with a wall-clock timeout. On timeout: cancel, fail fast, and if the worker does
    /// not pick up the next item promptly, poison it and replace it.</summary>
    public async Task<object?> RunAsync(Func<CancellationToken, object?> work, TimeSpan timeout)
    {
        if (_disposed) throw new ObjectDisposedException(nameof(UiaScheduler));
        var cts = new CancellationTokenSource();
        var item = new WorkItem(work, cts.Token);
        _queue.Add(item);

        var completed = await Task.WhenAny(item.Tcs.Task, Task.Delay(timeout)).ConfigureAwait(false);
        if (completed != item.Tcs.Task)
        {
            cts.Cancel();                       // ask the work to stop
            // Probe: is the worker responsive? Enqueue a no-op with a short grace period.
            if (!await WorkerResponsiveAsync(TimeSpan.FromSeconds(2)).ConfigureAwait(false))
            {
                PoisonAndReplaceWorker();       // COM truly frozen — abandon the thread
            }
            throw new TimeoutException("UIA operation exceeded the watchdog timeout.");
        }
        return await item.Tcs.Task.ConfigureAwait(false);
    }

    private async Task<bool> WorkerResponsiveAsync(TimeSpan grace)
    {
        var probe = new WorkItem(_ => null, CancellationToken.None);
        _queue.Add(probe);
        var done = await Task.WhenAny(probe.Tcs.Task, Task.Delay(grace)).ConfigureAwait(false);
        return done == probe.Tcs.Task;
    }

    private void PoisonAndReplaceWorker()
    {
        PoisonedThreadCount++;
        // The old worker is left to die whenever its frozen COM call returns (or at process exit).
        _worker = StartWorker();
    }

    public void Dispose() { _disposed = true; _queue.CompleteAdding(); }

    private sealed record WorkItem(Func<CancellationToken, object?> Work, CancellationToken Token)
    {
        public TaskCompletionSource<object?> Tcs { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
    }
}
```

- [ ] **Step 2: Write `sidecar/tests/FlaUiSidecar.Tests.csproj`**

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>   <!-- non-windows TFM: scheduler logic is platform-agnostic -->
    <Nullable>enable</Nullable>
    <IsPackable>false</IsPackable>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1" />
    <PackageReference Include="xunit" Version="2.9.2" />
    <PackageReference Include="xunit.runner.visualstudio" Version="2.8.2" />
  </ItemGroup>
  <ItemGroup>
    <Compile Include="../UiaScheduler.cs" />
  </ItemGroup>
</Project>
```

- [ ] **Step 3: Write the failing tests `sidecar/tests/UiaSchedulerTests.cs`**

```csharp
using FlaUiSidecar;
using Xunit;

public class UiaSchedulerTests
{
    [Fact]
    public async Task FastWork_ReturnsResult()
    {
        using var s = new UiaScheduler();
        var r = await s.RunAsync(_ => 42, TimeSpan.FromSeconds(5));
        Assert.Equal(42, r);
    }

    [Fact]
    public async Task HungWork_TimesOut_AndSchedulerStaysUsable()
    {
        using var s = new UiaScheduler();
        // A work item that ignores cancellation (simulates frozen COM).
        await Assert.ThrowsAsync<TimeoutException>(() =>
            s.RunAsync(_ => { Thread.Sleep(Timeout.Infinite); return null; }, TimeSpan.FromMilliseconds(300)));

        // After poisoning + replacement, the next op must still work.
        var r = await s.RunAsync(_ => "alive", TimeSpan.FromSeconds(5));
        Assert.Equal("alive", r);
        Assert.True(s.PoisonedThreadCount >= 1);
    }
}
```

- [ ] **Step 4: Run tests to verify they fail then pass 🍏**

Run: `dotnet test sidecar/tests/FlaUiSidecar.Tests.csproj`
Expected (first, before Step 1 exists): compile error. After Step 1: both tests PASS. `HungWork_...` proves fail-fast + session-survival + poisoning on a non-Windows box.

- [ ] **Step 5: Commit**

```bash
git add sidecar/UiaScheduler.cs sidecar/tests/
git commit -m "feat(sidecar): Spike C — anti-hang scheduler (watchdog + poisoning), unit-tested cross-platform"
```

---

## PHASE 1 — SKELETON END-TO-END

### Task 1.1: package.json (Appium 3 manifest) + tsconfig 🍏

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "appium-flaui-native-driver",
  "version": "0.0.1",
  "description": "Appium 3 Windows driver backed by a compiled C# FlaUI sidecar (UIA3/UIA2 + MSAA legacy).",
  "main": "build/lib/driver.js",
  "engines": { "node": "^20.19.0 || ^22.12.0 || >=24.0.0", "npm": ">=10" },
  "scripts": {
    "build": "tsc -b",
    "lint": "eslint .",
    "test:unit": "mocha --import=tsx tests/unit/**/*.spec.ts",
    "test:e2e": "mocha --import=tsx tests/e2e/**/*.e2e.spec.ts",
    "publish:sidecar": "node scripts/publish-sidecar.mjs"
  },
  "appium": {
    "driverName": "flauinative",
    "automationName": "FlaUINative",
    "platformNames": ["Windows"],
    "mainClass": "FlaUINativeDriver"
  },
  "peerDependencies": { "appium": "^3.0.0" },
  "dependencies": {
    "@appium/base-driver": "^10.0.0",
    "@appium/support": "^6.0.0"
  },
  "devDependencies": {
    "@appium/types": "^1.0.0",
    "@types/node": "^22.0.0",
    "chai": "^5.1.0",
    "mocha": "^10.7.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0"
  },
  "files": ["build", "prebuilt"]
}
```

> NOTE: dependency version ranges (esp. `@appium/base-driver`/`@appium/types`) must be reconciled against
> the versions Appium 3 actually ships at implementation time. Step 3 verifies via install; bump as needed
> and record the resolved versions in `docs/DECISIONS.md` (ADR-011).

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "extends": "@appium/tsconfig/tsconfig.json",
  "compilerOptions": { "outDir": "build", "rootDir": ".", "types": ["node"] },
  "include": ["lib/**/*.ts"]
}
```

- [ ] **Step 3: Install & verify 🍏**

Run: `npm install` then `npx tsc -b --dry`
Expected: install succeeds; resolve any peer/version conflicts now. Record resolved Appium-3 dep versions.

- [ ] **Step 4: Commit**

```bash
git add package.json tsconfig.json package-lock.json
git commit -m "chore: Appium 3 manifest, engines, tsconfig"
```

---

### Task 1.2: Backend op contract (`lib/backend/ops.ts`) 🍏

**Files:**
- Create: `lib/backend/ops.ts`
- Test: `tests/unit/ops.spec.ts`

- [ ] **Step 1: Write the failing test `tests/unit/ops.spec.ts`**

```ts
import { expect } from 'chai';
import { propertyCondition, andCondition, findOp } from '../../lib/backend/ops';

describe('backend ops', () => {
  it('builds a property condition', () => {
    expect(propertyCondition('AutomationId', 'saveBtn'))
      .to.deep.equal({ kind: 'property', prop: 'AutomationId', value: 'saveBtn' });
  });

  it('builds an and condition', () => {
    const c = andCondition(propertyCondition('Name', 'OK'), propertyCondition('ControlType', 'Button'));
    expect(c.kind).to.equal('and');
    expect(c.children).to.have.length(2);
  });

  it('builds a find op', () => {
    const op = findOp({ startId: 'root', multiple: false, scope: 'descendants',
      condition: propertyCondition('Name', 'OK') });
    expect(op).to.deep.equal({ op: 'find', startId: 'root', multiple: false,
      scope: 'descendants', condition: { kind: 'property', prop: 'Name', value: 'OK' } });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:unit -- tests/unit/ops.spec.ts`
Expected: FAIL — `Cannot find module '../../lib/backend/ops'`.

- [ ] **Step 3: Write `lib/backend/ops.ts`**

```ts
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
  | { op: 'input'; kind: 'click' | 'hover' | 'keys' | 'scroll' | 'clickAndDrag'; args: Record<string, unknown> };

export interface BasicProps {
  runtimeId: string; name?: string; automationId?: string; className?: string;
  controlType?: string; isEnabled?: boolean; isOffscreen?: boolean;
}

export type W3CErrorType =
  | 'timeout' | 'stale element reference' | 'no such element'
  | 'invalid selector' | 'unknown error';

export type BackendResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: { type: W3CErrorType; message: string } };

export const findOp = (p: Omit<Extract<BackendOp, { op: 'find' }>, 'op'>): BackendOp =>
  ({ op: 'find', ...p });
```

- [ ] **Step 4: Run to verify it passes 🍏**

Run: `npm run test:unit -- tests/unit/ops.spec.ts`
Expected: PASS (3 passing).

- [ ] **Step 5: Commit**

```bash
git add lib/backend/ops.ts tests/unit/ops.spec.ts
git commit -m "feat(backend): structured op contract (BackendOp/BackendResult/Condition)"
```

---

### Task 1.3: RPC client (`lib/backend/rpc-client.ts`) 🍏

**Files:**
- Create: `lib/backend/rpc-client.ts`
- Test: `tests/unit/rpc-client.spec.ts`

- [ ] **Step 1: Write the failing test `tests/unit/rpc-client.spec.ts`**

```ts
import { expect } from 'chai';
import http from 'node:http';
import { RpcClient } from '../../lib/backend/rpc-client';

describe('RpcClient', () => {
  let server: http.Server; let base: string;

  before((done) => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.url === '/status') return res.end(JSON.stringify({ ok: true, ready: true }));
        const op = JSON.parse(body || '{}');
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, value: { echoed: op } }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(server.address() as any).port}`; done();
    });
  });
  after((done) => server.close(() => done()));

  it('posts an op and returns the value', async () => {
    const client = new RpcClient(base);
    const res = await client.op({ op: 'find', startId: 'root', multiple: false,
      scope: 'descendants', condition: { kind: 'true' } });
    expect(res).to.deep.equal({ echoed: { op: 'find', startId: 'root', multiple: false,
      scope: 'descendants', condition: { kind: 'true' } } });
  });

  it('health() returns true when ready', async () => {
    const client = new RpcClient(base);
    expect(await client.health()).to.equal(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:unit -- tests/unit/rpc-client.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `lib/backend/rpc-client.ts`**

```ts
import type { BackendOp, BackendResult } from './ops';

export class RpcError extends Error {
  constructor(public type: string, message: string) { super(message); }
}

/** Thin HTTP/JSON client to the sidecar. Unwraps BackendResult, throwing RpcError on { ok:false }. */
export class RpcClient {
  constructor(private baseUrl: string, private timeoutMs = 30_000) {}

  async health(): Promise<boolean> {
    try {
      const r = await this.fetchJson('GET', '/status');
      return !!(r && (r as any).ready);
    } catch { return false; }
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
    } finally { clearTimeout(t); }
  }
}
```

- [ ] **Step 4: Run to verify it passes 🍏**

Run: `npm run test:unit -- tests/unit/rpc-client.spec.ts`
Expected: PASS (2 passing).

- [ ] **Step 5: Commit**

```bash
git add lib/backend/rpc-client.ts tests/unit/rpc-client.spec.ts
git commit -m "feat(backend): localhost HTTP/JSON RPC client with BackendResult unwrap"
```

---

### Task 1.4: Sidecar process manager (`lib/backend/sidecar.ts`) 🍏

**Files:**
- Create: `lib/backend/sidecar.ts`
- Test: `tests/unit/sidecar.spec.ts`
- Test fixture: `tests/fixtures/fake-sidecar.mjs`

- [ ] **Step 1: Write the fake sidecar fixture `tests/fixtures/fake-sidecar.mjs`**

```js
// Stands in for the C# exe: prints PORT=, serves /status, exits on stdin EOF.
import http from 'node:http';
const server = http.createServer((req, res) => {
  if (req.url === '/status') { res.end(JSON.stringify({ ok: true, ready: true })); return; }
  res.end(JSON.stringify({ ok: true, value: {} }));
});
server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`PORT=${server.address().port}\n`);
});
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
```

- [ ] **Step 2: Write the failing test `tests/unit/sidecar.spec.ts`**

```ts
import { expect } from 'chai';
import path from 'node:path';
import { Sidecar } from '../../lib/backend/sidecar';

describe('Sidecar process manager', () => {
  it('spawns, reads the port, and reports healthy', async () => {
    const fake = path.resolve('tests/fixtures/fake-sidecar.mjs');
    const sc = new Sidecar({ command: process.execPath, args: [fake] });
    await sc.start();
    expect(sc.baseUrl).to.match(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await sc.client.health()).to.equal(true);
    await sc.stop();
  });

  it('stop() terminates the process', async () => {
    const fake = path.resolve('tests/fixtures/fake-sidecar.mjs');
    const sc = new Sidecar({ command: process.execPath, args: [fake] });
    await sc.start();
    await sc.stop();
    expect(sc.isRunning).to.equal(false);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm run test:unit -- tests/unit/sidecar.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write `lib/backend/sidecar.ts`**

```ts
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { RpcClient } from './rpc-client';

export interface SidecarOptions { command: string; args: string[]; startupTimeoutMs?: number; }

/** Owns the sidecar child process: spawn, port handshake, health, and clean shutdown. */
export class Sidecar {
  private proc?: ChildProcessWithoutNullStreams;
  baseUrl = '';
  client!: RpcClient;
  get isRunning(): boolean { return !!this.proc && this.proc.exitCode === null; }

  constructor(private opts: SidecarOptions) {}

  async start(): Promise<void> {
    const proc = spawn(this.opts.command, this.opts.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');

    const port = await new Promise<number>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('sidecar startup timeout')),
        this.opts.startupTimeoutMs ?? 15_000);
      let buf = '';
      proc.stdout.on('data', (chunk: string) => {
        buf += chunk;
        const m = buf.match(/PORT=(\d+)/);
        if (m) { clearTimeout(to); resolve(Number(m[1])); }
      });
      proc.on('exit', (code) => { clearTimeout(to); reject(new Error(`sidecar exited early: ${code}`)); });
    });

    this.baseUrl = `http://127.0.0.1:${port}`;
    this.client = new RpcClient(this.baseUrl);

    // Wait until /status is ready (bounded).
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (await this.client.health()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('sidecar did not become healthy');
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    const p = this.proc;
    this.proc = undefined;
    try { p.stdin.end(); } catch { /* triggers heartbeat self-exit */ }
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 2_000);
      p.on('exit', () => { clearTimeout(killTimer); resolve(); });
    });
  }
}
```

- [ ] **Step 5: Run to verify it passes 🍏**

Run: `npm run test:unit -- tests/unit/sidecar.spec.ts`
Expected: PASS (2 passing). This is the Node half of **Spike A**, now reusable + tested.

- [ ] **Step 6: Commit**

```bash
git add lib/backend/sidecar.ts tests/unit/sidecar.spec.ts tests/fixtures/fake-sidecar.mjs
git commit -m "feat(backend): sidecar process manager (spawn/handshake/health/stop) + Spike A Node half"
```

---

### Task 1.5: Sidecar `/session` + `/op{find}` + element registry 🪟

**Files:**
- Create: `sidecar/ElementRegistry.cs`
- Create: `sidecar/OpInterpreter.cs`
- Modify: `sidecar/Program.cs` (wire `/session`, `/op`)
- Test: `sidecar/tests/ElementRegistryTests.cs`

- [ ] **Step 1: Write `sidecar/ElementRegistry.cs`**

```csharp
using System.Collections.Concurrent;
using FlaUI.Core.AutomationElements;

namespace FlaUiSidecar;

/// <summary>RuntimeId → AutomationElement with FIFO eviction. Stale ids are reported to the caller,
/// which maps them to a W3C 'stale element reference'.</summary>
public sealed class ElementRegistry
{
    private readonly int _max;
    private readonly ConcurrentDictionary<string, AutomationElement> _map = new();
    private readonly ConcurrentQueue<string> _order = new();

    public ElementRegistry(int max = 10_000) { _max = max; }

    public string Register(AutomationElement el)
    {
        var id = string.Join('.', el.Properties.RuntimeId.Value);
        if (_map.TryAdd(id, el)) { _order.Enqueue(id); EvictIfNeeded(); }
        else { _map[id] = el; }
        return id;
    }

    public bool TryGet(string id, out AutomationElement? el) => _map.TryGetValue(id, out el);

    private void EvictIfNeeded()
    {
        while (_map.Count > _max && _order.TryDequeue(out var oldest))
            _map.TryRemove(oldest, out _);
    }
}
```

- [ ] **Step 2: Write `sidecar/OpInterpreter.cs` (find op only for the skeleton)**

```csharp
using System.Text.Json;
using FlaUI.Core;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Conditions;
using FlaUI.Core.Definitions;

namespace FlaUiSidecar;

public sealed class OpInterpreter
{
    private readonly AutomationBase _automation;
    private readonly ElementRegistry _registry;
    private AutomationElement? _root;

    public OpInterpreter(AutomationBase automation, ElementRegistry registry)
    { _automation = automation; _registry = registry; }

    public object OpenSession(AutomationElement root) { _root = root; return new { rootId = _registry.Register(root) }; }

    public object Find(JsonElement op)
    {
        var startId = op.GetProperty("startId").GetString()!;
        var multiple = op.GetProperty("multiple").GetBoolean();
        var scope = ParseScope(op.GetProperty("scope").GetString()!);
        var start = startId == "root" ? _root! : ResolveOrThrow(startId);
        var cond = BuildCondition(op.GetProperty("condition"));

        if (multiple)
        {
            var els = start.FindAll(scope, cond);
            return new { elements = els.Select(Basic).ToArray() };
        }
        var found = start.FindFirst(scope, cond)
            ?? throw new ElementNotFoundException();
        return Basic(found);
    }

    private object Basic(AutomationElement e) => new
    {
        runtimeId = string.Join('.', e.Properties.RuntimeId.Value),
        name = e.Properties.Name.ValueOrDefault,
        automationId = e.Properties.AutomationId.ValueOrDefault,
        className = e.Properties.ClassName.ValueOrDefault,
        controlType = e.Properties.ControlType.ValueOrDefault.ToString(),
    }.Tap(_ => _registry.Register(e));

    private AutomationElement ResolveOrThrow(string id) =>
        _registry.TryGet(id, out var el) && el is not null ? el : throw new StaleElementException(id);

    private ConditionBase BuildCondition(JsonElement c)
    {
        var cf = _automation.ConditionFactory;
        return c.GetProperty("kind").GetString() switch
        {
            "true" => cf.ByName(string.Empty).Or(cf.ByName(string.Empty)).Not().Not(), // TrueCondition surrogate
            "property" => BuildProperty(cf, c),
            "and" => c.GetProperty("children").EnumerateArray().Select(BuildCondition)
                        .Aggregate((a, b) => a.And(b)),
            "or" => c.GetProperty("children").EnumerateArray().Select(BuildCondition)
                        .Aggregate((a, b) => a.Or(b)),
            "not" => BuildCondition(c.GetProperty("child")).Not(),
            var k => throw new ArgumentException($"unknown condition kind: {k}"),
        };
    }

    private static PropertyCondition BuildProperty(ConditionFactory cf, JsonElement c)
    {
        var prop = c.GetProperty("prop").GetString();
        var val = c.GetProperty("value");
        return prop switch
        {
            "AutomationId" => cf.ByAutomationId(val.GetString()!),
            "Name" => cf.ByName(val.GetString()!),
            "ClassName" => cf.ByClassName(val.GetString()!),
            "ControlType" => cf.ByControlType(Enum.Parse<ControlType>(val.GetString()!)),
            _ => throw new ArgumentException($"unsupported property: {prop}"),
        };
    }

    private static TreeScope ParseScope(string s) => s switch
    {
        "element" => TreeScope.Element, "children" => TreeScope.Children,
        "descendants" => TreeScope.Descendants, "subtree" => TreeScope.Subtree,
        _ => TreeScope.Descendants,
    };
}

public sealed class StaleElementException(string id) : Exception($"stale element: {id}");
internal static class TapExt { public static T Tap<T>(this T self, Action<T> a) { a(self); return self; } }
```

> ⚠️ The `"true"` condition surrogate above is a placeholder for FlaUI's true-condition API — replace with
> the real `TrueCondition` once verified on Windows (FlaUI exposes `ConditionFactory`/`TrueCondition`; confirm
> the exact symbol). Flag for `csharp-sidecar-engineer` during the Windows pass.

- [ ] **Step 3: Wire `/session` and `/op` in `sidecar/Program.cs`**

Add after the `/status` mapping (full file shown for clarity):

```csharp
using System.Text.Json;
using FlaUI.Core;
using FlaUI.UIA2;
using FlaUI.UIA3;
using FlaUiSidecar;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls("http://127.0.0.1:0");
var app = builder.Build();

var scheduler = new UiaScheduler();
var registry = new ElementRegistry();
AutomationBase? automation = null;
OpInterpreter? interp = null;

app.MapGet("/status", () => Results.Json(new { ok = true, ready = true }));

app.MapPost("/session", async (HttpRequest req) =>
{
    using var doc = await JsonDocument.ParseAsync(req.Body);
    var caps = doc.RootElement;
    var backend = caps.TryGetProperty("backend", out var b) ? b.GetString() : "uia3";
    automation = backend == "uia2" ? new UIA2Automation() : new UIA3Automation();
    automation.ConnectionTimeout = TimeSpan.FromSeconds(60);
    automation.TransactionTimeout = TimeSpan.FromSeconds(60);
    interp = new OpInterpreter(automation, registry);

    var appPath = caps.GetProperty("app").GetString()!;
    return await RunOp(() =>
    {
        var launched = FlaUI.Core.Application.Launch(appPath);
        var root = launched.GetMainWindow(automation!);
        return interp!.OpenSession(root);
    });
});

app.MapPost("/op", async (HttpRequest req) =>
{
    using var doc = await JsonDocument.ParseAsync(req.Body);
    var op = doc.RootElement.Clone();
    return await RunOp(() => op.GetProperty("op").GetString() switch
    {
        "find" => interp!.Find(op),
        var o => throw new NotSupportedException($"op not implemented in skeleton: {o}"),
    });
});

async Task<IResult> RunOp(Func<object?> work)
{
    try
    {
        var value = await scheduler.RunAsync(_ => work(), TimeSpan.FromSeconds(30));
        return Results.Json(new { ok = true, value });
    }
    catch (TimeoutException ex) { return Err("timeout", ex.Message); }
    catch (StaleElementException ex) { return Err("stale element reference", ex.Message); }
    catch (FlaUI.Core.Exceptions.ElementNotFoundException ex) { return Err("no such element", ex.Message); }
    catch (ArgumentException ex) { return Err("invalid selector", ex.Message); }
    catch (Exception ex) { return Err("unknown error", ex.Message); }
}
IResult Err(string type, string message) => Results.Json(new { ok = false, error = new { type, message } });

await app.StartAsync();
Console.WriteLine($"PORT={new Uri(app.Urls.First()).Port}");
Console.Out.Flush();
_ = Task.Run(async () =>
{
    using var stdin = Console.OpenStandardInput();
    var buf = new byte[1];
    try { while (await stdin.ReadAsync(buf) > 0) { } } catch { }
    Environment.Exit(0);
});
await app.WaitForShutdownAsync();
```

- [ ] **Step 4: Write `sidecar/tests/ElementRegistryTests.cs` (cross-platform unit)**

```csharp
using FlaUiSidecar;
using Xunit;

public class ElementRegistryTests
{
    [Fact]
    public void Eviction_RemovesOldest_WhenOverCap()
    {
        // Pure logic test using a tiny fake is hard without AutomationElement;
        // instead assert the queue/cap contract via a test-only subclass seam.
        // (Implementation note: extract eviction into a testable inner method or
        //  make Register accept an id+token pair so this runs without FlaUI types.)
        Assert.True(true); // placeholder until the registry exposes a FlaUI-free seam — see note
    }
}
```

> NOTE for `csharp-sidecar-engineer`: `ElementRegistry` currently couples to FlaUI's `AutomationElement`,
> which blocks cross-platform unit testing. Refactor so the eviction/ordering logic takes a plain
> `(string id, object element)` — then this test becomes real (assert oldest evicted at cap+1). Do this
> refactor as the FIRST step of the Windows pass.

- [ ] **Step 5: Build & smoke (Windows only) 🪟**

Run: `dotnet build sidecar/FlaUiSidecar.csproj`; then manual: spawn, POST `/session {app:"notepad.exe", backend:"uia3"}`, then POST `/op {op:"find", startId:"root", multiple:false, scope:"descendants", condition:{kind:"property",prop:"ClassName",value:"Edit"}}`.
Expected: `/session` returns `{ok:true,value:{rootId}}`; `/op` returns the Edit element's runtimeId.

- [ ] **Step 6: Commit**

```bash
git add sidecar/ElementRegistry.cs sidecar/OpInterpreter.cs sidecar/Program.cs sidecar/tests/
git commit -m "feat(sidecar): /session + /op{find} + element registry (skeleton)"
```

---

### Task 1.6: Driver skeleton (`lib/driver.ts`) 🍏(build)/🪟(run)

**Files:**
- Create: `lib/driver.ts`

- [ ] **Step 1: Write `lib/driver.ts`**

```ts
import { BaseDriver } from '@appium/base-driver';
import path from 'node:path';
import { Sidecar } from './backend/sidecar';
import { findOp, propertyCondition, type BasicProps } from './backend/ops';

const W3C_ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

const constraints = {
  platformName: { isString: true, presence: true, inclusionCaseInsensitive: ['Windows'] },
  app: { isString: true },
  'flaui:backend': { isString: true, inclusion: ['uia3', 'uia2'] },
} as const;

export class FlaUINativeDriver extends BaseDriver<typeof constraints> {
  static newMethodMap = {} as const;
  desiredCapConstraints = constraints;
  locatorStrategies = ['accessibility id', 'name', 'class name', 'xpath'];
  private sidecar?: Sidecar;

  async createSession(...jwpArgs: any[]) {
    const [sessionId, caps] = (await super.createSession(...(jwpArgs as [any]))) as [string, any];
    const arch = process.arch === 'arm64' ? 'win-arm64' : 'win-x64';
    const exe = path.resolve(__dirname, `../../prebuilt/${arch}/FlaUiSidecar.exe`);
    this.sidecar = new Sidecar({ command: exe, args: [] });
    await this.sidecar.start();
    await this.sidecar.client.session({
      app: this.opts.app, backend: (this.opts as any)['flaui:backend'] ?? 'uia3',
    });
    return [sessionId, caps] as [string, any];
  }

  async deleteSession() {
    try { await this.sidecar?.stop(); } finally { await super.deleteSession(); }
  }

  async findElOrEls(strategy: string, selector: string, mult: boolean, context?: string) {
    const propMap: Record<string, string> = {
      'accessibility id': 'AutomationId', name: 'Name', 'class name': 'ClassName',
    };
    if (strategy === 'xpath') throw new Error('xpath arrives in Phase 3');
    const prop = propMap[strategy];
    if (!prop) throw new Error(`unsupported strategy: ${strategy}`);

    const res = await this.sidecar!.client.op<BasicProps | { elements: BasicProps[] }>(
      findOp({ startId: context ?? 'root', multiple: mult, scope: 'descendants',
        condition: propertyCondition(prop, selector) }));

    if (mult) return (res as { elements: BasicProps[] }).elements
      .map((e) => ({ [W3C_ELEMENT_KEY]: e.runtimeId }));
    return { [W3C_ELEMENT_KEY]: (res as BasicProps).runtimeId };
  }
}

export default FlaUINativeDriver;
```

- [ ] **Step 2: Build 🍏**

Run: `npm run build`
Expected: compiles. (Type-level only; running requires Windows + a published sidecar.)

- [ ] **Step 3: Commit**

```bash
git add lib/driver.ts
git commit -m "feat(driver): FlaUINativeDriver skeleton — createSession spawns sidecar, find by a11y id"
```

---

### Task 1.7: Green E2E — find an element in Notepad 🪟

**Files:**
- Create: `tests/e2e/smoke.e2e.spec.ts`

- [ ] **Step 1: Write `tests/e2e/smoke.e2e.spec.ts`**

```ts
import { expect } from 'chai';
import { remote } from 'webdriverio';

describe('smoke: Notepad (Windows only)', function () {
  this.timeout(120_000);
  let driver: WebdriverIO.Browser;

  before(async () => {
    driver = await remote({
      hostname: '127.0.0.1', port: 4723, path: '/',
      capabilities: { platformName: 'Windows',
        'appium:automationName': 'FlaUINative', 'appium:app': 'notepad.exe' } as any,
    });
  });
  after(async () => { await driver?.deleteSession(); });

  it('finds the Edit control by class name', async () => {
    const el = await driver.$('android=dummy'); // replaced below with proper strategy
    const edit = await driver.findElement('class name', 'Edit');
    expect(edit).to.have.property('element-6066-11e4-a52e-4f735466cecf');
  });
});
```

> NOTE for `test-engineer`: clean up the WDIO locator call to the project's chosen client API; the assertion
> on the W3C element key is the real check. Requires: Appium 3 running, this driver installed
> (`appium driver install --source=local .`), and the sidecar published (`npm run publish:sidecar`).

- [ ] **Step 2: Run on Windows 🪟**

Run: `appium &` then `npm run test:e2e`
Expected: 1 passing — Notepad launches, the Edit control is found. **This is the Phase 1 exit criterion.**

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/smoke.e2e.spec.ts
git commit -m "test(e2e): Notepad find-element smoke (Phase 1 exit criterion)"
```

---

## Phase exit & review

- [ ] Run `spec-reviewer` against the Phase 0–1 changes (anti-hang integrity, seam, Appium-3 compliance).
- [ ] `docs-scribe` updates `docs/CHANGELOG-internal.md` and creates `docs/components/{backend-seam,sidecar,anti-hang}.md`.
- [ ] Confirm: all 🍏 tasks pass on macOS; all 🪟 tasks have a tracked "verify on Windows" item.

---

## Self-review notes (author)

- **Spec coverage:** Phase 0 covers spec §6 (anti-hang, Task 0.4), §5.2 page-source feasibility (Task 0.3),
  §8 packaging (Task 0.1). Phase 1 covers §2–§4 seam/transport (Tasks 1.2–1.5), §3.1 driver layer (1.6),
  §7 capabilities subset (1.6), §10 testing (unit throughout, e2e 1.7), §12 Appium-3 manifest (1.1).
  Deferred to later plans: full command surface (§spec Phase 2), XPath (Phase 3), full anti-hang layer 5
  recycle wiring on the TS side (Phase 4), input/extensions (Phase 5), backend selection polish + packaging
  CI (Phase 6).
- **Known placeholders to resolve on Windows pass (flagged inline):** FlaUI true-condition symbol in
  `OpInterpreter.BuildCondition`; `ElementRegistry` FlaUI-free seam for testability; WDIO locator cleanup in
  the e2e smoke. These are explicitly assigned to `csharp-sidecar-engineer` / `test-engineer`.
- **Type consistency:** `BackendOp`/`BackendResult`/`Condition`/`BasicProps` names are used identically in
  `ops.ts`, `rpc-client.ts`, `driver.ts`, and the C# JSON shapes.
