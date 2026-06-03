# Subagents

Specialized agents defined for this project, in [`.claude/agents/`](../.claude/agents/). Each is a focused
role with its own required-reading, scope, and "definition of done", so work is split cleanly and each agent
holds only what it needs in context. Invoke them with the Agent tool (`subagent_type: <name>`), or let the
orchestration plan dispatch them.

| Agent | Owns | Use it when |
|---|---|---|
| **ts-driver-engineer** | `lib/` — driver.ts, command handlers, the `backend/` op-builder + RPC-client seam, capabilities, Appium-3 manifest | Any TypeScript driver work |
| **csharp-sidecar-engineer** | `sidecar/` — Kestrel RPC host, UIA scheduler, op interpreter, element registry, CacheRequest page-source builder, anti-hang machinery | Any C#/FlaUI sidecar work |
| **test-engineer** | TS mocha unit, C# xUnit unit, E2E (smoke/xpath/pagesource/click/stress/**hang-injection**/schema-compat) | Any test authoring or test-strategy work |
| **docs-scribe** | All markdown — spec, ADRs, NEXT-STEPS, component explainers, README, internal changelog | After any behavior/structure/decision change, or to write new explainer docs |
| **spec-reviewer** | Read-only adversarial review against spec + ADRs | Before merging a phase; to audit anti-hang / compatibility / Appium-3 compliance |

## How they work together (per phase)

```
plan a phase ──► ts-driver-engineer  ─┐
                 csharp-sidecar-engineer ├─ implement (TDD with test-engineer)
                 test-engineer        ─┘
                        │
                        ▼
                 spec-reviewer  ──► findings ──► fix ──► docs-scribe records what changed
```

## Why these roles

- The work splits along a hard technical boundary (**TypeScript driver** vs **C# sidecar**) plus the
  cross-cutting concerns (**tests**, **docs**, **review**). Each engineer can reason about its half without
  holding the other in context.
- **docs-scribe** exists because the user explicitly requires thorough md documentation of everything —
  making it a dedicated role guarantees docs never lag behind code.
- **spec-reviewer** is adversarial by design: the whole project's premise is stability, and the cheapest
  place to catch an unbounded-hang regression is a skeptical review against spec §6.

## Note on this macOS environment
These agents can be dispatched here, but they inherit the **Windows-only** constraint: TS and platform-agnostic
C#/test logic can be written and (partly) unit-tested on macOS; UIA execution and E2E must run on Windows.
Every agent is instructed to mark Windows-verification-pending work explicitly and never fake a pass.
