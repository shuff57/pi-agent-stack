/**
 * Hivemind — Persistent cross-session memory for pi agent
 *
 * Provides /memory commands to store, search, and list learnings.
 * Storage: ~/Documents/GitHub/pi-memories/hivemind/memories.jsonl
 * Search: FTS via substring match (Ollama embeddings optional, requires running Ollama)
 *
 * Commands:
 *   /memory store <text>     — Store a new learning
 *   /memory search <query>   — Search stored memories
 *   /memory list             — List recent memories (last 10)
 *   /memory sync             — Git commit + push pi-memories
 *
 * Usage: pi -e extensions/hivemind.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	existsSync,
	readFileSync,
	appendFileSync,
	mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

const MEMORIES_DIR = join(homedir(), "Documents", "GitHub", "pi-memories", "hivemind");
const MEMORIES_FILE = join(MEMORIES_DIR, "memories.jsonl");

interface Memory {
	id: string;
	information: string;
	tags: string;
	session_date: string;
	project: string;
}

function ensureDir(): void {
	if (!existsSync(MEMORIES_DIR)) {
		mkdirSync(MEMORIES_DIR, { recursive: true });
	}
	if (!existsSync(MEMORIES_FILE)) {
		appendFileSync(MEMORIES_FILE, "");
	}
}

function loadMemories(): Memory[] {
	ensureDir();
	const raw = readFileSync(MEMORIES_FILE, "utf8");
	const lines = raw.split("\n").filter((l) => l.trim());
	const memories: Memory[] = [];
	for (const line of lines) {
		try {
			memories.push(JSON.parse(line) as Memory);
		} catch {
			// skip malformed lines
		}
	}
	return memories;
}

function storeMemory(information: string, tags: string, project: string): Memory {
	ensureDir();
	const id = Date.now().toString();
	const session_date = new Date().toISOString().split("T")[0];
	const mem: Memory = { id, information, tags, session_date, project };
	appendFileSync(MEMORIES_FILE, JSON.stringify(mem) + "\n");
	return mem;
}

function searchMemories(query: string, memories: Memory[]): Memory[] {
	const q = query.toLowerCase();
	return memories.filter(
		(m) =>
			m.information.toLowerCase().includes(q) ||
			m.tags.toLowerCase().includes(q) ||
			m.project.toLowerCase().includes(q),
	);
}

function formatMemory(m: Memory, idx?: number): string {
	const prefix = idx !== undefined ? `[${idx + 1}] ` : "";
	return `${prefix}[${m.session_date}] [${m.project}] ${m.information}\n    tags: ${m.tags}`;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand({
		name: "memory",
		description:
			"Persistent memory: /memory store <text> | search <query> | list | sync",
		handler: async (args: string, ctx) => {
			const parts = args.trim().split(/\s+/);
			const subcommand = parts[0]?.toLowerCase();
			const rest = parts.slice(1).join(" ");

			if (!subcommand || subcommand === "help") {
				return [
					"Hivemind Memory Commands:",
					"  /memory store <text>     — Store a learning (add 'tags:t1,t2' at end for tags)",
					"  /memory search <query>   — Semantic/FTS search",
					"  /memory list             — Show last 10 memories",
					"  /memory sync             — Sync to git remote",
				].join("\n");
			}

			if (subcommand === "store") {
				if (!rest) return "Usage: /memory store <text> [tags:tag1,tag2]";

				// Extract tags if provided: "Learning text tags:tag1,tag2"
				const tagsMatch = rest.match(/\s+tags:([^\s]+)$/);
				const tags = tagsMatch ? tagsMatch[1] : "";
				const information = tagsMatch ? rest.slice(0, -tagsMatch[0].length).trim() : rest;

				const project = ctx.cwd ? ctx.cwd.split(/[/\\]/).pop() || "unknown" : "unknown";
				const mem = storeMemory(information, tags, project);
				return `✓ Stored memory [${mem.id}]\n${formatMemory(mem)}`;
			}

			if (subcommand === "search") {
				if (!rest) return "Usage: /memory search <query>";
				const memories = loadMemories();
				const results = searchMemories(rest, memories);
				if (results.length === 0) return `No memories found for: ${rest}`;
				const lines = results.slice(0, 10).map((m, i) => formatMemory(m, i));
				return `Found ${results.length} memories (showing ${Math.min(10, results.length)}):\n\n${lines.join("\n\n")}`;
			}

			if (subcommand === "list") {
				const memories = loadMemories();
				if (memories.length === 0) return "No memories stored yet.";
				const recent = memories.slice(-10).reverse();
				const lines = recent.map((m, i) => formatMemory(m, i));
				return `Last ${recent.length} memories (${memories.length} total):\n\n${lines.join("\n\n")}`;
			}

			if (subcommand === "sync") {
				const repoDir = join(homedir(), "Documents", "GitHub", "pi-memories");
				if (!existsSync(join(repoDir, ".git"))) {
					return "⚠ pi-memories repo not found. Clone it to ~/Documents/GitHub/pi-memories first.";
				}
				try {
					const date = new Date().toISOString().split("T")[0];
					const project = ctx.cwd ? ctx.cwd.split(/[/\\]/).pop() || "unknown" : "unknown";
					execSync(`git -C "${repoDir}" add -A`, { stdio: "pipe" });
					const status = execSync(`git -C "${repoDir}" status --porcelain`, { stdio: "pipe" }).toString();
					if (!status.trim()) return "✓ Nothing to sync — already up to date";
					execSync(`git -C "${repoDir}" commit -m "sync: ${project} ${date}"`, { stdio: "pipe" });
					try {
						execSync(`git -C "${repoDir}" push origin main`, { stdio: "pipe" });
						return `✓ Synced pi-memories to remote`;
					} catch {
						return `✓ Committed locally (push failed — run 'gh auth login' to enable remote sync)`;
					}
				} catch (err) {
					return `⚠ Sync failed: ${err}`;
				}
			}

			return `Unknown subcommand: ${subcommand}. Try /memory help`;
		},
	});
}
