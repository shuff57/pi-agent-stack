/**
 * CASS — Cross-Agent Session Search
 *
 * Searches session histories from multiple AI coding agents to find
 * how similar problems were solved in past sessions.
 *
 * Indexed sources (auto-detected):
 *   ~/.config/opencode/sessions/     — OpenCode sessions (JSONL)
 *   ~/.pi/agent/sessions/            — Pi agent sessions (JSONL)
 *   ~/.cursor-tutor/                 — Cursor sessions
 *
 * Commands:
 *   /cass <query>                    — Search all session histories
 *   /cass --agent opencode <query>   — Search specific agent only
 *   /cass --recent 7 <query>         — Limit to last N days
 *
 * Usage: pi -e extensions/cass.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	existsSync,
	readdirSync,
	readFileSync,
	statSync,
} from "node:fs";
import { join, extname } from "node:path";
import { homedir } from "node:os";

interface SessionMessage {
	role: string;
	content: string;
	timestamp?: string;
}

interface SessionResult {
	agent: string;
	sessionFile: string;
	date: string;
	matchingMessages: Array<{ role: string; snippet: string; relevance: number }>;
}

const SESSION_SOURCES: Array<{ agent: string; path: string }> = [
	{ agent: "opencode", path: join(homedir(), ".config", "opencode", "sessions") },
	{ agent: "pi", path: join(homedir(), ".pi", "agent", "sessions") },
	{ agent: "cursor", path: join(homedir(), ".cursor-tutor") },
];

function extractTextFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((c: unknown) => {
				if (typeof c === "string") return c;
				if (typeof c === "object" && c !== null) {
					const obj = c as Record<string, unknown>;
					if (obj.type === "text" && typeof obj.text === "string") return obj.text;
				}
				return "";
			})
			.join(" ");
	}
	return "";
}

function loadSessionMessages(filePath: string): SessionMessage[] {
	try {
		const raw = readFileSync(filePath, "utf8");
		const messages: SessionMessage[] = [];

		// Try JSONL format first
		const lines = raw.split("\n").filter((l) => l.trim());
		for (const line of lines) {
			try {
				const obj = JSON.parse(line);
				if (obj.role && obj.content !== undefined) {
					messages.push({
						role: obj.role,
						content: extractTextFromContent(obj.content),
						timestamp: obj.timestamp || obj.created_at,
					});
				}
			} catch {
				// not JSONL
			}
		}
		if (messages.length > 0) return messages;

		// Try single JSON object
		try {
			const obj = JSON.parse(raw);
			if (Array.isArray(obj.messages)) {
				return obj.messages.map((m: Record<string, unknown>) => ({
					role: String(m.role || ""),
					content: extractTextFromContent(m.content),
					timestamp: String(m.timestamp || ""),
				}));
			}
		} catch {
			// not JSON
		}

		return messages;
	} catch {
		return [];
	}
}

function getFileDate(filePath: string): string {
	try {
		const stat = statSync(filePath);
		return stat.mtime.toISOString().split("T")[0];
	} catch {
		return "unknown";
	}
}

function searchSessions(
	query: string,
	agentFilter?: string,
	recentDays?: number,
): SessionResult[] {
	const q = query.toLowerCase();
	const results: SessionResult[] = [];
	const cutoffMs = recentDays ? Date.now() - recentDays * 86400000 : 0;

	for (const source of SESSION_SOURCES) {
		if (agentFilter && source.agent !== agentFilter) continue;
		if (!existsSync(source.path)) continue;

		let files: string[] = [];
		try {
			files = readdirSync(source.path)
				.filter((f) => extname(f) === ".json" || extname(f) === ".jsonl" || f.endsWith(".json"))
				.map((f) => join(source.path, f));
		} catch {
			continue;
		}

		// Filter by date if requested
		if (cutoffMs > 0) {
			files = files.filter((f) => {
				try {
					return statSync(f).mtime.getTime() >= cutoffMs;
				} catch {
					return true;
				}
			});
		}

		for (const file of files) {
			const messages = loadSessionMessages(file);
			const matching = messages
				.filter((m) => m.content.toLowerCase().includes(q))
				.slice(0, 3)
				.map((m) => ({
					role: m.role,
					snippet: m.content.slice(0, 200).replace(/\n/g, " "),
					relevance: (m.content.toLowerCase().split(q).length - 1),
				}));

			if (matching.length > 0) {
				results.push({
					agent: source.agent,
					sessionFile: file.split(/[/\\]/).pop() || file,
					date: getFileDate(file),
					matchingMessages: matching,
				});
			}
		}
	}

	// Sort by most recent first
	results.sort((a, b) => b.date.localeCompare(a.date));
	return results.slice(0, 8);
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("cass", {
		description: "Search session histories: /cass <query> [--agent opencode|pi|cursor] [--recent N]",
		handler: async (args: string, _ctx) => {
			if (!args.trim()) {
				return [
					"CASS — Cross-Agent Session Search",
					"Usage: /cass <query>",
					"       /cass --agent opencode <query>",
					"       /cass --recent 7 <query>",
					"",
					"Searches: OpenCode, Pi, Cursor session histories",
				].join("\n");
			}

			// Parse flags
			let agentFilter: string | undefined;
			let recentDays: number | undefined;
			let query = args.trim();

			const agentMatch = query.match(/--agent\s+(\w+)\s*/);
			if (agentMatch) {
				agentFilter = agentMatch[1];
				query = query.replace(agentMatch[0], "").trim();
			}

			const recentMatch = query.match(/--recent\s+(\d+)\s*/);
			if (recentMatch) {
				recentDays = parseInt(recentMatch[1], 10);
				query = query.replace(recentMatch[0], "").trim();
			}

			if (!query) return "Please provide a search query after flags.";

			const results = searchSessions(query, agentFilter, recentDays);

			if (results.length === 0) {
				const filters = [
					agentFilter ? `agent: ${agentFilter}` : null,
					recentDays ? `last ${recentDays} days` : null,
				].filter(Boolean).join(", ");
				return `No sessions found for "${query}"${filters ? ` (${filters})` : ""}`;
			}

			const lines: string[] = [
				`Found ${results.length} session(s) matching "${query}":`,
				"",
			];

			for (const result of results) {
				lines.push(`[${result.agent}] ${result.sessionFile} (${result.date})`);
				for (const msg of result.matchingMessages) {
					lines.push(`  ${msg.role}: "${msg.snippet}${msg.snippet.length >= 200 ? "..." : ""}"`);
				}
				lines.push("");
			}

			return lines.join("\n");
		},
	});
}
