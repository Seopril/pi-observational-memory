import { appendFileSync } from "node:fs";
import { join } from "node:path";

export interface LogEntry {
	type: "message";
	id?: string;
	timestamp: string;
	message: {
		role: "assistant";
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
		this.filePath = join(sessionDir, "session-om.jsonl");
	}

	log(entry: LogEntry): void {
		const line = JSON.stringify(entry) + "\n";
		appendFileSync(this.filePath, line, "utf8");
	}
}
