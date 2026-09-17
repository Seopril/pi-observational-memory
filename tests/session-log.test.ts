import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SessionLog } from "../src/session-log.js";

describe("SessionLog", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = join(tmpdir(), `om-session-log-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		mkdirSync(tmp, { recursive: true });
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("appends a ccusage-compatible JSONL line to the session dir", () => {
		const log = new SessionLog(tmp);

		log.log({
			type: "message",
			id: "test-1",
			timestamp: "2026-01-01T00:00:00.000Z",
			message: {
				role: "assistant",
				model: "claude-sonnet-4-5",
				usage: {
					input: 100,
					output: 50,
					cacheRead: 30,
					cacheWrite: 20,
					totalTokens: 150,
					cost: { total: 0.001 },
				},
			},
		});

		const filePath = join(tmp, "session-om.jsonl");
		const content = readFileSync(filePath, "utf8");
		const line = content.trim();
		const entry = JSON.parse(line) as Record<string, unknown>;

		expect(entry.type).toBe("message");
		expect(entry.message.role).toBe("assistant");
		expect(entry.message.model).toBe("claude-sonnet-4-5");
	});

	it("appends multiple lines without overwriting", () => {
		const log = new SessionLog(tmp);

		log.log({
			type: "message",
			id: "test-1",
			timestamp: "2026-01-01T00:00:00.000Z",
			message: {
				role: "assistant",
				model: "model-a",
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0 } },
			},
		});

		log.log({
			type: "message",
			id: "test-2",
			timestamp: "2026-01-01T00:00:01.000Z",
			message: {
				role: "assistant",
				model: "model-b",
				usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { total: 0 } },
			},
		});

		const filePath = join(tmp, "session-om.jsonl");
		const lines = readFileSync(filePath, "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0]!).message.model).toBe("model-a");
		expect(JSON.parse(lines[1]!).message.model).toBe("model-b");
	});

	it("creates the file only on first write", () => {
		const filePath = join(tmp, "session-om.jsonl");
		expect(() => readFileSync(filePath, "utf8")).toThrow();

		const log = new SessionLog(tmp);
		log.log({
			type: "message",
			id: "test-1",
			timestamp: "2026-01-01T00:00:00.000Z",
			message: {
				role: "assistant",
				model: "model-a",
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0 } },
			},
		});

		expect(readFileSync(filePath, "utf8")).toContain("model-a");
	});

	it("produces lines parseable by ccusage requirements", () => {
		const log = new SessionLog(tmp);

		log.log({
			type: "message",
			id: "ccusage-test",
			timestamp: "2026-09-15T12:00:00.000Z",
			message: {
				role: "assistant",
				model: "claude-sonnet-4-5",
				usage: {
					input: 1200,
					output: 300,
					cacheRead: 800,
					cacheWrite: 100,
					totalTokens: 2400,
					cost: { total: 0.012 },
				},
			},
		});

		const filePath = join(tmp, "session-om.jsonl");
		const line = readFileSync(filePath, "utf8").trim();
		const entry = JSON.parse(line) as Record<string, unknown>;
		const msg = entry.message as Record<string, unknown>;
		const usage = msg.usage as Record<string, unknown>;

		// ccusage requirements
		expect(entry.type).toBe("message");
		expect(entry.timestamp).toBeDefined();
		expect(msg.role).toBe("assistant");
		expect(Number(usage.totalTokens)).toBeGreaterThan(0);
		expect(Number(usage.input)).toBeGreaterThanOrEqual(0);
		expect(Number(usage.output)).toBeGreaterThanOrEqual(0);
		expect(Number(usage.cacheRead)).toBeGreaterThanOrEqual(0);
		expect(Number(usage.cacheWrite)).toBeGreaterThanOrEqual(0);
	});
});
