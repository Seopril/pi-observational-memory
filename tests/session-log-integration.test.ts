import { mkdtempSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));

const mockAgents = vi.hoisted(() => ({
	runObserver: vi.fn(),
	runReflector: vi.fn(),
	runDropper: vi.fn(),
}));

vi.mock("../src/agents/observer/agent.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/agents/observer/agent.js")>()),
	runObserver: mockAgents.runObserver,
}));
vi.mock("../src/agents/reflector/agent.js", () => ({ runReflector: mockAgents.runReflector }));
vi.mock("../src/agents/dropper/agent.js", () => ({ runDropper: mockAgents.runDropper }));

const { SessionLog } = await import("../src/session-log.js");

import { registerConsolidationTrigger } from "../src/hooks/consolidation-trigger.js";
import {
	OM_OBSERVATIONS_RECORDED,
} from "../src/session-ledger/index.js";
import {
	observationsRecordedEntry,
} from "./fixtures/session.js";
import {
	observation,
	reflection,
	textCustomMessage,
	type TestEntry,
} from "./fixtures/session.js";

beforeEach(() => {
	mockAgents.runObserver.mockReset();
	mockAgents.runReflector.mockReset();
	mockAgents.runDropper.mockReset();
	mockAgents.runObserver.mockResolvedValue({ observations: [], usage: undefined });
	mockAgents.runReflector.mockResolvedValue({ reflections: [], usage: undefined });
	mockAgents.runDropper.mockResolvedValue({ ids: [], usage: undefined });
});

function setup(args: {
	entries: TestEntry[];
	observeAfterTokens?: number;
	reflectAfterTokens?: number;
	observationsPoolTargetTokens?: number;
	sessionLog: SessionLog;
}) {
	let entries = [...args.entries];
	const sessionId = "integration-session";
	const handlers: Record<string, ((event: unknown, ctx: any) => void) | undefined> = {};
	const pi = {
		on: vi.fn((eventName: string, cb: (event: unknown, ctx: any) => void) => {
			handlers[eventName] = cb;
		}),
		appendEntry: vi.fn((customType: string, data: unknown) => {
			const id = `appended-${pi.appendEntry.mock.calls.length}`;
			entries = [...entries, { type: "custom", id, parentId: entries.at(-1)?.id ?? null, timestamp: "2026-05-02T10:00:00.000Z", customType, data }];
			return id;
		}),
	};
	let launchedWork: (() => Promise<void>) | undefined;
	const runtime = {
		config: {
			showWorkerNotifications: true,
			passive: false,
			debugLog: false,
			observeAfterTokens: args.observeAfterTokens ?? 1,
			reflectAfterTokens: args.reflectAfterTokens ?? 1,
			observerChunkMaxTokens: undefined,
			observationsPoolMaxTokens: 100,
			observationsPoolTargetTokens: args.observationsPoolTargetTokens ?? 10,
			agentMaxTurns: 9,
			agentMaxTokens: 32000,
			model: { provider: "anthropic", id: "memory", thinking: "minimal" },
			logUsage: true,
		},
		consolidationInFlight: false,
		consolidationPhase: undefined as "observer" | "reflector" | "dropper" | undefined,
		resolveFailureNotified: false,
		lastObserverError: undefined as string | undefined,
		lastReflectorError: undefined as string | undefined,
		lastDropperError: undefined as string | undefined,
		ensureConfig: vi.fn(),
		resolveModel: vi.fn(async () => ({ ok: true, model: { reasoning: true }, apiKey: "key", headers: { h: "v" } })),
		launchConsolidationTask: vi.fn((_ctx, work) => {
			runtime.consolidationInFlight = true;
			launchedWork = work;
			return Promise.resolve();
		}),
		recordConsolidationStageError: vi.fn(),
	};
	registerConsolidationTrigger(pi as any, runtime as any);
	if (!handlers.agent_start) throw new Error("agent_start consolidation handler not registered");
	if (!handlers.turn_end) throw new Error("turn_end consolidation handler not registered");
	const ctx = {
		cwd: "/tmp/project",
		hasUI: true,
		ui: { notify: vi.fn() },
		model: { provider: "session" },
		modelRegistry: {},
		sessionManager: {
			getBranch: () => entries,
			getSessionId: () => sessionId,
		},
		sessionLog: args.sessionLog,
	};
	return {
		pi,
		runtime,
		ctx,
		fire: (eventName = "turn_end") => handlers[eventName]!(undefined, ctx),
		runLaunchedWork: async () => launchedWork?.(),
		getEntries: () => entries,
	};
}

describe("SessionLog integration", () => {
	it("writes usage records to session-om.jsonl when pipeline runs", async () => {
		const sessionDir = mkdtempSync(join(osTmpdir(), "om-integration-"));
		const sessionLog = new SessionLog(sessionDir);

		const obs = observation("cccccccccccccccc", { sourceEntryIds: ["raw-2"], tokenCount: 100 });
		const newRef = reflection("ffffffffffff", ["cccccccccccc"]);
		const mockUsage = { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, totalTokens: 165, cost: { total: 0.001 } };
		mockAgents.runObserver.mockResolvedValueOnce({ observations: [obs], usage: mockUsage });
		mockAgents.runReflector.mockResolvedValueOnce({ reflections: [newRef], usage: mockUsage });
		mockAgents.runDropper.mockResolvedValueOnce({ ids: ["aaaaaaaaaaaa"], usage: mockUsage });

		const entries: TestEntry[] = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", {
				observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"], tokenCount: 100 })],
				coversUpToId: "raw-1",
			}),
			textCustomMessage("raw-2", "bbbbbbbb"),
		];

		const { fire, runLaunchedWork } = setup({
			entries,
			observeAfterTokens: 1,
			reflectAfterTokens: 1,
			observationsPoolTargetTokens: 10,
			sessionLog,
		});

		fire();
		await runLaunchedWork();

		const filePath = join(sessionDir, "session-om.jsonl");
		const content = readFileSync(filePath, "utf8");
		const lines = content.trim().split("\n");

		expect(lines).toHaveLength(3);

		// Verify each line is valid JSON with correct structure
		for (const line of lines) {
			const record = JSON.parse(line);
			expect(record.type).toBe("message");
			expect(record.timestamp).toBeTruthy();
			expect(record.message.role).toBe("assistant");
			expect(record.message.usage).toEqual(mockUsage);
		}

		// Verify model names match stages
		expect(lines[0]).toContain('"model":"observer"');
		expect(lines[1]).toContain('"model":"reflector"');
		expect(lines[2]).toContain('"model":"dropper"');

		// Cleanup
		unlinkSync(filePath);
	});

	it("logs usage when only observer runs", async () => {
		const sessionDir = mkdtempSync(join(osTmpdir(), "om-integration-"));
		const sessionLog = new SessionLog(sessionDir);

		const obs = observation("cccccccccccccccc", { sourceEntryIds: ["raw-2"], tokenCount: 100 });
		const mockUsage = { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, totalTokens: 165, cost: { total: 0.001 } };
		mockAgents.runObserver.mockResolvedValueOnce({ observations: [obs], usage: mockUsage });

		const entries: TestEntry[] = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", {
				observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"], tokenCount: 100 })],
				coversUpToId: "raw-1",
			}),
			textCustomMessage("raw-2", "bbbbbbbb"),
		];

		const { fire, runLaunchedWork } = setup({
			entries,
			observeAfterTokens: 1,
			reflectAfterTokens: 9999, // Prevent reflector from running
			observationsPoolTargetTokens: 10,
			sessionLog,
		});

		fire();
		await runLaunchedWork();

		const filePath = join(sessionDir, "session-om.jsonl");
		const content = readFileSync(filePath, "utf8");
		const lines = content.trim().split("\n");

		expect(lines).toHaveLength(1);
		const record = JSON.parse(lines[0]);
		expect(record.message.model).toBe("observer");

		// Cleanup
		unlinkSync(filePath);
	});
});
