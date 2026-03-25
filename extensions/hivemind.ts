/**
 * Hivemind — Persistent cross-session memory for pi agent
 *
 * Provides /memory commands to store, search, and list learnings.
 * Storage: ~/Documents/GitHub/pi-memories/hivemind/memories.jsonl
 * Search: Semantic vector search via Ollama embeddings, falls back to substring match
 *
 * Auto-save: Implicitly captures learnings from:
 *   - User corrections and "remember this" patterns (input hook)
 *   - Bash commands that fail then succeed (tool_execution_end hook)
 *   - Session insights summary (agent_end hook)
 *
 * Commands:
 *   /memory store <text>     — Store a new learning (auto-embeds if Ollama available)
 *   /memory search <query>   — Semantic search (falls back to FTS)
 *   /memory list             — List recent memories (last 10)
 *   /memory sync             — Git commit + push pi-memories
 *   /memory embed            — Backfill embeddings for un-embedded memories
 *   /memory auto [on|off]    — Toggle auto-save (default: on)
 *
 * Usage: pi -e extensions/hivemind.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import {
	existsSync,
	readFileSync,
	writeFileSync,
	appendFileSync,
	mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

const MEMORIES_DIR = join(homedir(), "Documents", "GitHub", "pi-memories", "hivemind");
const MEMORIES_FILE = join(MEMORIES_DIR, "memories.jsonl");
const MEMORY_INDEX = join(MEMORIES_DIR, "MEMORY.md");
const TOPICS_DIR = join(MEMORIES_DIR, "topics");
const OLLAMA_BASE = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";

// Topic categories for organizing memories into files
const TOPIC_MAP: Record<string, { file: string; label: string }> = {
	"fix": { file: "debugging.md", label: "Debugging & Fixes" },
	"bash": { file: "debugging.md", label: "Debugging & Fixes" },
	"error": { file: "debugging.md", label: "Debugging & Fixes" },
	"bug": { file: "debugging.md", label: "Debugging & Fixes" },
	"crash": { file: "debugging.md", label: "Debugging & Fixes" },
	"architecture": { file: "architecture.md", label: "Architecture Decisions" },
	"design": { file: "architecture.md", label: "Architecture Decisions" },
	"pattern": { file: "patterns.md", label: "Patterns & Best Practices" },
	"best-practice": { file: "patterns.md", label: "Patterns & Best Practices" },
	"convention": { file: "patterns.md", label: "Patterns & Best Practices" },
	"correction": { file: "corrections.md", label: "User Corrections" },
	"failure": { file: "failures.md", label: "Failures & Lessons" },
	"fail": { file: "failures.md", label: "Failures & Lessons" },
	"investigation": { file: "investigations.md", label: "Curator Investigations" },
	"curator": { file: "investigations.md", label: "Curator Investigations" },
};

interface Memory {
	id: string;
	information: string;
	tags: string;
	session_date: string;
	project: string;
	embedding?: number[];
	agent?: string; // Agent namespace (e.g., "librarian", "architect")
	shared?: boolean; // Promoted to shared memory
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

function saveAllMemories(memories: Memory[]): void {
	ensureDir();
	const content = memories.map((m) => JSON.stringify(m)).join("\n") + "\n";
	writeFileSync(MEMORIES_FILE, content);
}

// --- Topic file organization ---

function getTopicFile(mem: Memory): string {
	const allTags = mem.tags.toLowerCase().split(",").map((t) => t.trim());
	for (const tag of allTags) {
		if (TOPIC_MAP[tag]) return TOPIC_MAP[tag].file;
	}
	// Check information content for topic keywords
	const lower = mem.information.toLowerCase();
	for (const [keyword, topic] of Object.entries(TOPIC_MAP)) {
		if (lower.includes(keyword)) return topic.file;
	}
	return "general.md";
}

function writeTopicFile(topicFile: string, memories: Memory[]): void {
	if (!existsSync(TOPICS_DIR)) mkdirSync(TOPICS_DIR, { recursive: true });
	const label = Object.values(TOPIC_MAP).find((t) => t.file === topicFile)?.label || topicFile.replace(".md", "");
	const lines = [`# ${label}`, ""];
	for (const mem of memories) {
		lines.push(`## [${mem.session_date}] ${mem.project}`);
		lines.push(mem.information);
		if (mem.tags) lines.push(`*Tags: ${mem.tags}*`);
		lines.push("");
	}
	writeFileSync(join(TOPICS_DIR, topicFile), lines.join("\n"));
}

function rebuildTopicFiles(memories: Memory[]): void {
	const active = memories.filter((m) => !((m as any).superseded_by) && !((m as any).stale));
	const byTopic = new Map<string, Memory[]>();

	for (const mem of active) {
		const topic = getTopicFile(mem);
		if (!byTopic.has(topic)) byTopic.set(topic, []);
		byTopic.get(topic)!.push(mem);
	}

	for (const [file, mems] of byTopic) {
		writeTopicFile(file, mems);
	}

	return;
}

function rebuildMemoryIndex(memories: Memory[]): void {
	const active = memories.filter((m) => !((m as any).superseded_by) && !((m as any).stale));
	const embedded = memories.filter((m) => m.embedding).length;
	const byTopic = new Map<string, number>();

	for (const mem of active) {
		const topic = getTopicFile(mem);
		byTopic.set(topic, (byTopic.get(topic) || 0) + 1);
	}

	const lines = [
		"# Hivemind Memory Index",
		"",
		`*${active.length} active memories, ${embedded} embedded, ${memories.length} total*`,
		`*Last updated: ${new Date().toISOString().split("T")[0]}*`,
		"",
		"## Topic Files",
		"",
	];

	const sorted = [...byTopic.entries()].sort((a, b) => b[1] - a[1]);
	for (const [file, count] of sorted) {
		const label = Object.values(TOPIC_MAP).find((t) => t.file === file)?.label || file;
		lines.push(`- [${label}](topics/${file}) — ${count} memories`);
	}

	lines.push("", "## Recent Memories", "");
	const recent = active.slice(-10).reverse();
	for (const mem of recent) {
		lines.push(`- [${mem.session_date}] **${mem.project}**: ${mem.information.slice(0, 80)}${mem.information.length > 80 ? "..." : ""}`);
	}

	// Keep under 200 lines
	const output = lines.slice(0, 200);
	writeFileSync(MEMORY_INDEX, output.join("\n") + "\n");
}

// --- Per-agent memory namespaces ---

const AGENTS_DIR = join(MEMORIES_DIR, "agents");

function getAgentMemoryFile(agentName: string): string {
	const agentDir = join(AGENTS_DIR, agentName);
	if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });
	return join(agentDir, "memories.jsonl");
}

function loadAgentMemories(agentName: string): Memory[] {
	const file = getAgentMemoryFile(agentName);
	if (!existsSync(file)) return [];
	const raw = readFileSync(file, "utf8");
	return raw.split("\n").filter((l) => l.trim()).map((line) => {
		try { return JSON.parse(line) as Memory; } catch { return null; }
	}).filter(Boolean) as Memory[];
}

function storeAgentMemory(agentName: string, mem: Memory): void {
	const file = getAgentMemoryFile(agentName);
	mem.agent = agentName;
	appendFileSync(file, JSON.stringify(mem) + "\n");
}

function promoteToShared(agentName: string, memoryId: string): Memory | null {
	const agentMems = loadAgentMemories(agentName);
	const mem = agentMems.find((m) => m.id === memoryId);
	if (!mem) return null;
	mem.shared = true;
	// Write to shared JSONL
	appendFileSync(MEMORIES_FILE, JSON.stringify(mem) + "\n");
	// Update agent file to mark as shared
	const updatedAgent = agentMems.map((m) =>
		m.id === memoryId ? { ...m, shared: true } : m,
	);
	const agentFile = getAgentMemoryFile(agentName);
	writeFileSync(agentFile, updatedAgent.map((m) => JSON.stringify(m)).join("\n") + "\n");
	return mem;
}

function listAgentNamespaces(): { name: string; count: number }[] {
	if (!existsSync(AGENTS_DIR)) return [];
	const { readdirSync } = require("node:fs");
	const dirs = readdirSync(AGENTS_DIR, { withFileTypes: true })
		.filter((d: any) => d.isDirectory())
		.map((d: any) => d.name);
	return dirs.map((name: string) => ({
		name,
		count: loadAgentMemories(name).length,
	}));
}

// --- Ollama Embedding ---

async function getEmbedding(text: string): Promise<number[] | null> {
	try {
		const res = await fetch(`${OLLAMA_BASE}/api/embed`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model: EMBED_MODEL, input: text }),
		});
		if (!res.ok) return null;
		const data = (await res.json()) as { embeddings: number[][] };
		return data.embeddings?.[0] || null;
	} catch {
		return null;
	}
}

function cosineSimilarity(a: number[], b: number[]): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	return denom === 0 ? 0 : dot / denom;
}

async function semanticSearch(
	query: string,
	memories: Memory[],
	topK: number = 10,
): Promise<{ memory: Memory; score: number }[]> {
	const queryEmbedding = await getEmbedding(query);
	if (!queryEmbedding) return [];

	const withEmbeddings = memories.filter((m) => m.embedding && m.embedding.length > 0);
	if (withEmbeddings.length === 0) return [];

	const scored = withEmbeddings.map((m) => ({
		memory: m,
		score: cosineSimilarity(queryEmbedding, m.embedding!),
	}));

	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, topK);
}

// --- Substring fallback ---

function substringSearch(query: string, memories: Memory[]): Memory[] {
	const q = query.toLowerCase();
	return memories.filter(
		(m) =>
			m.information.toLowerCase().includes(q) ||
			m.tags.toLowerCase().includes(q) ||
			m.project.toLowerCase().includes(q),
	);
}

// --- Store with embedding ---

async function storeMemory(
	information: string,
	tags: string,
	project: string,
): Promise<{ mem: Memory; embedded: boolean }> {
	ensureDir();
	const id = Date.now().toString();
	const session_date = new Date().toISOString().split("T")[0];
	const embedding = await getEmbedding(`${information} ${tags}`);
	const mem: Memory = { id, information, tags, session_date, project };
	if (embedding) mem.embedding = embedding;
	appendFileSync(MEMORIES_FILE, JSON.stringify(mem) + "\n");

	// Update topic files and index incrementally
	const all = loadMemories();
	rebuildMemoryIndex(all);
	rebuildTopicFiles(all);

	return { mem, embedded: !!embedding };
}

function formatMemory(m: Memory, idx?: number, score?: number): string {
	const prefix = idx !== undefined ? `[${idx + 1}] ` : "";
	const scoreStr = score !== undefined ? ` (${(score * 100).toFixed(0)}% match)` : "";
	const embedIcon = m.embedding ? " ●" : " ○";
	return `${prefix}[${m.session_date}] [${m.project}]${embedIcon} ${m.information}${scoreStr}\n    tags: ${m.tags}`;
}

export default function (pi: ExtensionAPI) {
	// --- Auto-save state ---
	let autoSaveEnabled = true;
	let lastBashFailed: { command: string; error: string } | null = null;
	let sessionMemoriesStored = 0;
	const AUTO_SAVE_THROTTLE_MS = 30_000; // Min 30s between auto-saves
	let lastAutoSaveTime = 0;

	// "remember this" and correction patterns
	const rememberPatterns = [
		/\bremember\s+(?:that|this|to)\b/i,
		/\bnote\s+(?:that|this|to)\b/i,
		/\bkeep\s+in\s+mind\b/i,
		/\bdon'?t\s+forget\b/i,
		/\bimportant:\s/i,
	];
	const correctionPatterns = [
		/\bno,?\s+(?:actually|use|it'?s|that'?s|we)\b/i,
		/\bactually,?\s+(?:we|you|it|the)\b/i,
		/\bstop\s+(?:doing|using)\b/i,
		/\bdon'?t\s+(?:do|use|add|create|make)\b/i,
		/\binstead,?\s+(?:use|do|try)\b/i,
		/\bthat'?s\s+wrong\b/i,
		/\bnot\s+like\s+that\b/i,
	];

	function canAutoSave(): boolean {
		if (!autoSaveEnabled) return false;
		const now = Date.now();
		if (now - lastAutoSaveTime < AUTO_SAVE_THROTTLE_MS) return false;
		return true;
	}

	async function autoSave(information: string, tags: string, project: string): Promise<void> {
		if (!canAutoSave()) return;
		lastAutoSaveTime = Date.now();
		await storeMemory(information, tags, project);
		sessionMemoriesStored++;
	}

	// --- Hook: Detect user corrections and "remember this" ---
	pi.on("input", async (event: any, ctx) => {
		if (!autoSaveEnabled) return { action: "continue" as const };

		const text = typeof event === "string" ? event : event?.content || event?.text || "";
		if (!text || text.startsWith("/")) return { action: "continue" as const };

		const project = ctx.cwd ? ctx.cwd.split(/[/\\]/).pop() || "unknown" : "unknown";

		// Check for explicit "remember" requests
		for (const pattern of rememberPatterns) {
			if (pattern.test(text)) {
				await autoSave(
					text.replace(/^(remember|note|keep in mind|don'?t forget)\s*(that|this|to)?\s*/i, "").trim(),
					"auto-save,user-request",
					project,
				);
				return { action: "continue" as const };
			}
		}

		// Check for corrections (indicates a learning moment)
		for (const pattern of correctionPatterns) {
			if (pattern.test(text)) {
				await autoSave(
					`[User Correction] ${text.slice(0, 300)}`,
					"auto-save,correction",
					project,
				);
				return { action: "continue" as const };
			}
		}

		return { action: "continue" as const };
	});

	// --- Hook: Detect bash fail→fix patterns ---
	pi.on("tool_call", async (event: any, ctx) => {
		// Track bash commands to detect fail→succeed patterns
		if (isToolCallEventType("bash", event)) {
			// If we have a previous failure and this is a new bash command,
			// it might be a fix attempt. We'll check the result in tool_execution_end.
			if (lastBashFailed) {
				// Store the failed command context for comparison
			}
		}
		return { block: false };
	});

	pi.on("tool_execution_end", async (event: any, ctx) => {
		if (!autoSaveEnabled) return;

		// Check if this is a bash tool result
		const toolName = event?.toolName || event?.name || "";
		if (toolName !== "bash") return;

		const exitCode = event?.result?.exitCode ?? event?.exitCode;
		const command = event?.input?.command || event?.command || "";
		const output = event?.result?.output || event?.output || "";

		if (exitCode !== 0 && exitCode !== undefined) {
			// Command failed — track it
			lastBashFailed = {
				command: command.slice(0, 200),
				error: output.slice(0, 200),
			};
		} else if (lastBashFailed && exitCode === 0) {
			// Command succeeded after a previous failure — this is a fix!
			const project = ctx.cwd ? ctx.cwd.split(/[/\\]/).pop() || "unknown" : "unknown";
			await autoSave(
				`[Fix] Command "${lastBashFailed.command}" failed with: ${lastBashFailed.error.slice(0, 100)}. Fixed by: ${command.slice(0, 200)}`,
				"auto-save,fix,bash",
				project,
			);
			lastBashFailed = null;
		} else {
			// Successful command with no prior failure — reset tracker
			lastBashFailed = null;
		}
	});

	// --- Hook: Session end summary ---
	pi.on("agent_end", async (_event, ctx) => {
		if (!autoSaveEnabled || sessionMemoriesStored === 0) return;

		const project = ctx.cwd ? ctx.cwd.split(/[/\\]/).pop() || "unknown" : "unknown";
		ctx.ui?.notify(`Hivemind: ${sessionMemoriesStored} memories auto-saved this session`);
	});

	pi.registerCommand("memory", {
		description:
			"Persistent memory: /memory store | search | list | sync | embed | auto",
		handler: async (args: string, ctx) => {
			const parts = args.trim().split(/\s+/);
			const subcommand = parts[0]?.toLowerCase();
			const rest = parts.slice(1).join(" ");

			if (!subcommand || subcommand === "help") {
				return [
					"Hivemind Memory Commands:",
					"  /memory store <text>     — Store a learning (add 'tags:t1,t2' at end)",
					"  /memory search <query>   — Semantic search (falls back to FTS if Ollama is down)",
					"  /memory list             — Show last 10 memories (● = embedded, ○ = not)",
					"  /memory sync             — Sync to git remote",
					"  /memory embed            — Backfill embeddings for un-embedded memories",
					"  /memory topics           — Rebuild topic files and MEMORY.md index",
					"  /memory agent <cmd>      — Per-agent namespaces (list|store|search|promote)",
					"  /memory auto [on|off]    — Toggle auto-save (currently " + (autoSaveEnabled ? "on" : "off") + ")",
					"",
					`Auto-save: ${autoSaveEnabled ? "ON" : "OFF"} | ${sessionMemoriesStored} auto-saved this session`,
				].join("\n");
			}

			if (subcommand === "store") {
				if (!rest) return "Usage: /memory store <text> [tags:tag1,tag2]";

				const tagsMatch = rest.match(/\s+tags:([^\s]+)$/);
				const tags = tagsMatch ? tagsMatch[1] : "";
				const information = tagsMatch ? rest.slice(0, -tagsMatch[0].length).trim() : rest;

				const project = ctx.cwd ? ctx.cwd.split(/[/\\]/).pop() || "unknown" : "unknown";
				const { mem, embedded } = await storeMemory(information, tags, project);
				const embedNote = embedded ? " (embedded ●)" : " (no embedding ○ — Ollama unavailable)";
				return `✓ Stored memory [${mem.id}]${embedNote}\n${formatMemory(mem)}`;
			}

			if (subcommand === "search") {
				if (!rest) return "Usage: /memory search <query>";
				const memories = loadMemories();

				// Try semantic search first
				const semanticResults = await semanticSearch(rest, memories);
				if (semanticResults.length > 0) {
					const lines = semanticResults.map((r, i) =>
						formatMemory(r.memory, i, r.score),
					);
					return `Semantic search (${semanticResults.length} results):\n\n${lines.join("\n\n")}`;
				}

				// Fall back to substring
				const results = substringSearch(rest, memories);
				if (results.length === 0) return `No memories found for: ${rest}`;
				const lines = results.slice(0, 10).map((m, i) => formatMemory(m, i));
				return `FTS fallback (${results.length} results, Ollama unavailable for semantic):\n\n${lines.join("\n\n")}`;
			}

			if (subcommand === "list") {
				const memories = loadMemories();
				if (memories.length === 0) return "No memories stored yet.";
				const embedded = memories.filter((m) => m.embedding).length;
				const recent = memories.slice(-10).reverse();
				const lines = recent.map((m, i) => formatMemory(m, i));
				return `Last ${recent.length} memories (${memories.length} total, ${embedded} embedded):\n\n${lines.join("\n\n")}`;
			}

			if (subcommand === "embed") {
				const memories = loadMemories();
				const unembedded = memories.filter((m) => !m.embedding);
				if (unembedded.length === 0) return "✓ All memories already have embeddings.";

				let success = 0;
				let failed = 0;
				for (const mem of unembedded) {
					const embedding = await getEmbedding(`${mem.information} ${mem.tags}`);
					if (embedding) {
						mem.embedding = embedding;
						success++;
					} else {
						failed++;
						if (failed === 1) break; // Ollama likely down, stop trying
					}
				}

				if (success > 0) {
					saveAllMemories(memories);
				}

				if (failed > 0 && success === 0) {
					return `✗ Ollama unavailable — could not generate embeddings. Is it running at ${OLLAMA_BASE}?`;
				}
				return `✓ Embedded ${success} memories${failed > 0 ? ` (${failed} failed)` : ""}. Total: ${memories.filter((m) => m.embedding).length}/${memories.length} embedded.`;
			}

			if (subcommand === "agent") {
				const agentParts = rest.split(/\s+/);
				const action = agentParts[0]?.toLowerCase();

				if (!action || action === "list") {
					const namespaces = listAgentNamespaces();
					if (namespaces.length === 0) return "No agent memory namespaces yet.";
					const lines = ["Agent Memory Namespaces:", ""];
					for (const ns of namespaces) {
						lines.push(`  ${ns.name.padEnd(25)} ${ns.count} memories`);
					}
					return lines.join("\n");
				}

				if (action === "store") {
					const agentName = agentParts[1];
					const agentRest = agentParts.slice(2).join(" ");
					if (!agentName || !agentRest) return "Usage: /memory agent store <agent-name> <text> [tags:t1,t2]";

					const tagsMatch = agentRest.match(/\s+tags:([^\s]+)$/);
					const tags = tagsMatch ? tagsMatch[1] : "";
					const information = tagsMatch ? agentRest.slice(0, -tagsMatch[0].length).trim() : agentRest;
					const project = ctx.cwd ? ctx.cwd.split(/[/\\]/).pop() || "unknown" : "unknown";

					const id = Date.now().toString();
					const session_date = new Date().toISOString().split("T")[0];
					const embedding = await getEmbedding(`${information} ${tags}`);
					const mem: Memory = { id, information, tags, session_date, project, agent: agentName };
					if (embedding) mem.embedding = embedding;
					storeAgentMemory(agentName, mem);
					return `✓ Stored in agent "${agentName}" namespace [${mem.id}]\n${formatMemory(mem)}`;
				}

				if (action === "search") {
					const agentName = agentParts[1];
					const query = agentParts.slice(2).join(" ");
					if (!agentName || !query) return "Usage: /memory agent search <agent-name> <query>";

					const agentMems = loadAgentMemories(agentName);
					if (agentMems.length === 0) return `No memories in agent "${agentName}" namespace.`;

					const results = await semanticSearch(query, agentMems);
					if (results.length > 0) {
						const lines = results.map((r, i) => formatMemory(r.memory, i, r.score));
						return `Agent "${agentName}" semantic search (${results.length} results):\n\n${lines.join("\n\n")}`;
					}

					const ftsResults = substringSearch(query, agentMems);
					if (ftsResults.length === 0) return `No matches in agent "${agentName}" for: ${query}`;
					const lines = ftsResults.slice(0, 10).map((m, i) => formatMemory(m, i));
					return `Agent "${agentName}" FTS (${ftsResults.length} results):\n\n${lines.join("\n\n")}`;
				}

				if (action === "promote") {
					const agentName = agentParts[1];
					const memId = agentParts[2];
					if (!agentName || !memId) return "Usage: /memory agent promote <agent-name> <memory-id>";

					const promoted = promoteToShared(agentName, memId);
					if (!promoted) return `✗ Memory ${memId} not found in agent "${agentName}".`;
					return `✓ Promoted to shared memory:\n${formatMemory(promoted)}`;
				}

				return [
					"Agent Memory Commands:",
					"  /memory agent list                          — List all agent namespaces",
					"  /memory agent store <name> <text>           — Store in agent's namespace",
					"  /memory agent search <name> <query>         — Search agent's memories",
					"  /memory agent promote <name> <memory-id>    — Promote to shared memory",
				].join("\n");
			}

			if (subcommand === "topics") {
				const memories = loadMemories();
				rebuildTopicFiles(memories);
				rebuildMemoryIndex(memories);
				const byTopic = new Map<string, number>();
				for (const mem of memories.filter((m) => !((m as any).superseded_by) && !((m as any).stale))) {
					const topic = getTopicFile(mem);
					byTopic.set(topic, (byTopic.get(topic) || 0) + 1);
				}
				const lines = ["Topic Files (rebuilt):", ""];
				for (const [file, count] of [...byTopic.entries()].sort((a, b) => b[1] - a[1])) {
					const label = Object.values(TOPIC_MAP).find((t) => t.file === file)?.label || file;
					lines.push(`  ${label.padEnd(30)} ${count} memories → topics/${file}`);
				}
				lines.push("", `MEMORY.md index updated at ${MEMORY_INDEX}`);
				return lines.join("\n");
			}

			if (subcommand === "auto") {
				if (rest === "on") {
					autoSaveEnabled = true;
					return "✓ Auto-save enabled. Hivemind will capture corrections, fixes, and 'remember' requests.";
				}
				if (rest === "off") {
					autoSaveEnabled = false;
					return "✓ Auto-save disabled. Use /memory store for manual saves only.";
				}
				return `Auto-save is ${autoSaveEnabled ? "ON" : "OFF"}. ${sessionMemoriesStored} auto-saved this session.\nUsage: /memory auto on|off`;
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
