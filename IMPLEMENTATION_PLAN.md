# Issue #53: Write "pi-compatible" log files to the session dir

## Problem

The `ccusage` analytics tool reads JSONL session files. Currently pi-observational-memory makes LLM calls but produces no usage records that `ccusage` can ingest, making it invisible in analytics dashboards.

### ccusage requirements (from parser.rs)

A parseable line needs:
- A top-level `timestamp` field
- `type: "message"` if `type` is present
- `message.role: "assistant"`
- A `message.usage` object with nonzero token usage

Required usage fields: `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`
Optional but useful: `model`, `cost.total`

### Requester's flexibility

> "A separate OM session store is also fine, because ccusage supports custom Pi paths and named stores."

**Verdict:** Separate JSONL log file in the session directory. Minimal intrusion, matches the `pi-automode` pattern, no risk of polluting the main session.

---

## TDD Phases

Each phase follows: **Write failing test → Write minimal code → Pass → Refactor → Move on.**

---

### Phase 1: SessionLog module (standalone)

**Goal:** A class that appends ccusage-compatible JSONL lines to a file in the session directory.

#### Test 1.1: `tests/session-log.test.ts` — Write fails (Red)

```
describe('SessionLog', () => {
  it('appends a ccusage-compatible JSONL line to the session dir', () => { ... });
});
```

The test imports `SessionLog` (which doesn't exist yet) — compile error = red.

#### Code 1.1: Create `src/session-log.ts` (Green)

```typescript
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

export interface LogEntry {
  type: 'message';
  id: string;
  timestamp: string;        // ISO 8601
  message: {
    role: 'assistant';
    model: string;
    usage: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      totalTokens: number;
      cost: { total: number };
    };
  };
}

export class SessionLog {
  private readonly filePath: string;

  constructor(sessionDir: string) {
    this.filePath = join(sessionDir, 'session-om.jsonl');
  }

  log(entry: LogEntry): void {
    const line = JSON.stringify(entry) + '\n';
    appendFileSync(this.filePath, line, 'utf8');
  }
}
```

Re-run test — green.

#### Test 1.2: `tests/session-log.test.ts` — Idempotent append (Red)

```
it('appends multiple lines without overwriting', () => { ... });
it('creates the file only on first write', () => { ... });
```

Run — red (file doesn't exist yet, but `appendFileSync` creates it).
Code — already green. Refactor: verify with assertions.

#### Test 1.3: `tests/session-log.test.ts` — Error handling (Red)

```
it('does not throw when the session dir is unwritable', () => { ... });
```

Mock `appendFileSync` to throw → test fails.
Code — wrap in try/catch, log via `debugLog`.
Re-run — green.

#### Test 1.4: `tests/session-log.test.ts` — ccusage format compliance (Red)

```
it('produces lines parseable by ccusage requirements', () => { ... });
```

Parse the written JSONL, assert:
- `type === 'message'`
- `timestamp` is ISO 8601
- `message.role === 'assistant'`
- `message.usage` has all required fields with nonzero values
- `message.usage.totalTokens > 0`

Code — already compliant. Add assertions.

---

### Phase 2: Config option

**Goal:** Add `logUsage: boolean` (default `true`) to the config schema.

#### Test 2.1: `tests/config.test.ts` — `logUsage` defaults to true (Red)

```
it('includes logUsage: true in DEFAULTS', () => { ... });
it('parses logUsage from config file', () => { ... });
it('defaults to true when config file omits logUsage', () => { ... });
```

Run — red (field doesn't exist in schema).

#### Code 2.1: Add to `src/config.ts`

```typescript
// In DEFAULTS
logUsage: true,

// In schema
logUsage: Type.Boolean({
  description: 'Write ccusage-compatible JSONL usage records to the session directory.',
  default: true,
}),
```

Run — green.

---

### Phase 3: Extract usage from agentLoop streams

**Goal:** Capture `Usage` from `AssistantMessage` events in each agent's stream drain loop.

**Key insight:** The `agentLoop` stream yields `AssistantMessage` objects with `usage: Usage`. We need to accumulate the last one.

#### Test 3.1: `tests/observer.test.ts` — Usage returned from runObserver (Red)

```
it('returns usage from the stream result', async () => {
  const result = await runObserver({ ... });
  expect(result).toHaveProperty('usage');
  expect(result.usage).toMatchObject({ input: 100, output: 50, totalTokens: 150 });
});
```

Run — red (return type is `Observation[] | undefined`, no `usage` field).

#### Code 3.1: Modify `src/agents/observer/agent.ts`

Change return type to:
```typescript
type RunObserverResult = { observations: Observation[]; usage: Usage | undefined };
```

In the stream drain loop:
```typescript
let lastUsage: Usage | undefined;

for await (const event of stream) {
  logAgentStreamError('observer', event);
  const msg = (event as { message?: { role?: string; usage?: Usage } }).message;
  if (msg?.role === 'assistant' && msg.usage) {
    lastUsage = msg.usage;
  }
}
await stream.result();

if (accumulated.size === 0) {
  if (streamError) throw new ObserverStreamError(streamError.stopReason, streamError.errorMessage);
  return { observations: [], usage: lastUsage };
}
return { observations: Array.from(accumulated.values()), usage: lastUsage };
```

Run — green.

#### Test 3.2: `tests/reflector.test.ts` — Usage returned from runReflector (Red)

Same pattern as Test 3.1 for the reflector.

#### Test 3.3: `tests/dropper.test.ts` — Usage returned from runDropper (Red)

Same pattern for the dropper.

#### Code 3.2: Apply same pattern to `src/agents/reflector/agent.ts` and `src/agents/dropper/agent.ts`

Identical change: new return type, stream drain accumulates `lastUsage`, return `{ result, usage }`.

Run both — green.

---

### Phase 4: Wire SessionLog into the consolidation pipeline ✅ COMPLETED

**Goal:** After each stage completes, log a usage record if `config.logUsage` is true and usage data is available.

#### Test 4.1: `tests/consolidation-trigger.test.ts` — Observer stage logs usage (Red)

```
it('logs a ccusage-compatible record after observer completes with usage', async () => {
  const log = new MockSessionLog();
  await runConsolidationPipeline(pi, runtime, { ... config: { logUsage: true }, sessionLog: log });
  expect(log.entries).toHaveLength(1);
  expect(log.entries[0].message.role).toBe('assistant');
  expect(log.entries[0].message.usage.totalTokens).toBeGreaterThan(0);
});
```

Run — red (`sessionLog` doesn't exist in context, no logging happens).

#### Code 4.1: Modify `src/hooks/consolidation-trigger.ts`

Add `sessionLog: SessionLog | null` to `ConsolidationCtx`.

In `runObserverStage`, after `runObserver` returns:
```typescript
if (config.logUsage && result.usage && result.observations.length > 0) {
  sessionLog?.log({
    type: 'message',
    id: `om-observer-${Date.now().toString(36)}`,
    timestamp: new Date().toISOString(),
    message: {
      role: 'assistant',
      model: resolved.model.name,
      usage: result.usage,
    },
  });
}
```

Repeat for `runReflectorStage` and `runDropperStage`.

Run — green.

#### Test 4.2: `tests/consolidation-trigger.test.ts` — Skipped when disabled (Red)

```
it('does not log when config.logUsage is false', async () => { ... });
it('does not log when usage is undefined (some providers)', async () => { ... });
```

Run — red (currently logs unconditionally or doesn't check config).
Code — add `config.logUsage` guard and `usage !== undefined` guard.
Re-run — green.

#### Test 4.3: `tests/consolidation-trigger.test.ts` — All three stages log (Red)

```
it('logs one record per stage when all three run', async () => { ... });
```

Run — red (only observer logs, or nothing logs yet).
Code — add logging to reflector and dropper stages.
Re-run — green.

#### Test 4.4: `tests/consolidation-trigger.test.ts` — Error recovery (Red)

```
it('does not crash the pipeline when sessionLog.log throws', async () => { ... });
```

Mock `sessionLog.log` to throw → verify pipeline continues.
Code — wrap `sessionLog.log()` in try/catch in each stage.
Re-run — green.

---

### Phase 5: Integration

**Goal:** End-to-end verification that the full pipeline produces valid JSONL output.

#### Test 5.1: `tests/session-log-integration.test.ts` — Full pipeline (Red)

```
it('writes valid JSONL to the session dir after a full consolidation run', async () => {
  const tmpDir = await mkdtemp('/tmp/om-test-');
  const log = new SessionLog(tmpDir);
  // Mock the full pipeline with a sessionLog injected
  await runConsolidationPipeline(pi, runtime, { ... sessionLog: log });
  const lines = readFileSync(join(tmpDir, 'session-om.jsonl'), 'utf8').trim().split('\n');
  for (const line of lines) {
    const entry = JSON.parse(line);
    expect(entry.type).toBe('message');
    expect(entry.message.role).toBe('assistant');
    expect(entry.message.usage.totalTokens).toBeGreaterThan(0);
  }
});
```

Run — red (pipeline doesn't accept or use `sessionLog` yet).

#### Code 5.1: Wire in `src/index.ts`

```typescript
import { SessionLog } from './session-log.js';

export default function observationalMemory(pi: ExtensionAPI) {
  const runtime = new Runtime();

  // Create session log if config enables it
  let sessionLog: SessionLog | null = null;

  registerConsolidationTrigger(pi, runtime, sessionLog);
  // ...
}
```

Inject `sessionLog` into the consolidation trigger context.

Run — green.

---

## File Change Summary

| File | Change |
|------|--------|
| `src/session-log.ts` | **NEW** — JSONL log writer |
| `tests/session-log.test.ts` | **NEW** — Log writer tests |
| `tests/session-log-integration.test.ts` | **NEW** — End-to-end test |
| `src/config.ts` | Add `logUsage` config option |
| `tests/config.test.ts` | Add `logUsage` config tests |
| `src/agents/observer/agent.ts` | Capture `usage` from stream; change return type |
| `tests/observer.test.ts` | Add usage-return test |
| `src/agents/reflector/agent.ts` | Capture `usage` from stream; change return type |
| `tests/reflector.test.ts` | Add usage-return test |
| `src/agents/dropper/agent.ts` | Capture `usage` from stream; change return type |
| `tests/dropper.test.ts` | Add usage-return test |
| `src/hooks/consolidation-trigger.ts` | Pass `sessionLog` through; log usage after each stage |
| `tests/consolidation-trigger.test.ts` | Add usage-logging tests |
| `src/index.ts` | Create `SessionLog` instance; pass to consolidation trigger |

---

## TDD Red-Green-Refactor Cycle Per Phase

For each phase:

1. **RED** — Write the test that expresses the desired behavior. It must fail (compile error or assertion failure).
2. **GREEN** — Write the minimal code to make it pass. No more, no less.
3. **REFACTOR** — Clean up the code, add assertions, ensure no duplication.
4. **REPEAT** — Move to the next test.

This ensures:
- Every line of production code is motivated by a test
- The test suite is always green after each phase
- Regression risk is minimized
- The API surface is discovered through tests, not designed in a vacuum

---

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Stream usage data unavailable from some providers | Test with mocked `undefined` usage; log only when present |
| File I/O errors corrupting the log | Test error handling; wrap in try/catch, log to debug-log |
| Breaking changes to agent return types | Tests verify the new shape; callers adapted in same PR |
| Config option bloat | Single boolean flag; defaults to `true` (opt-out) |
| Test coupling to internal implementation | Use integration tests to verify external behavior (JSONL format), unit tests for internal logic |

---

## Implementation Order

1. **Phase 1:** SessionLog module + tests (standalone, no dependencies)
2. **Phase 2:** Config option + tests (standalone)
3. **Phase 3:** Agent usage extraction (observer → reflector → dropper, each with its own test)
4. **Phase 4:** Pipeline wiring (consolidation trigger + tests)
5. **Phase 5:** Integration test + `src/index.ts` wiring

### Phase 5: Integration test + `src/index.ts` wiring ✅ COMPLETED

**Goal:** Wire `SessionLog` into the extension entry point (`src/index.ts`) and write a full integration test that exercises the entire pipeline with a real session directory.

#### Test 5.1: `tests/session-log-integration.test.ts` — Full pipeline with real session dir (Red)

```ts
it('writes usage records to session-om.jsonl when pipeline runs', async () => {
  const tmpdir = await mkdtemp(join(os.tmpdir(), 'om-integration-'));
  const sessionLog = new SessionLog(tmpdir);
  // ... setup entries, run pipeline, verify file contains 3 JSONL lines with usage data
});
```

#### Implementation steps:

1. **`src/hooks/consolidation-trigger.ts`** — In `registerConsolidationTrigger`, create `SessionLog` in the `launch` handler before calling `maybeLaunchConsolidation`:
   ```ts
   const launch = (_event: unknown, ctx: ConsolidationCtx) => {
		try {
			const sessionDir = ctx.sessionManager.getSessionDir();
			(ctx as ConsolidationCtx & { sessionLog: SessionLog }).sessionLog = new SessionLog(sessionDir);
		} catch {
			// sessionLog unavailable — pipeline will skip logging gracefully
		}
		maybeLaunchConsolidation(pi, runtime, ctx);
	};
   ```

2. **Verify** the log file is written to the correct session directory.

This order ensures each phase builds on a green test suite from the previous phase.
