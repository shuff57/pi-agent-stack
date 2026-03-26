/**
 * Hivemind Curator — Autonomous memory management agent
 *
 * Dual-gate consolidation: full pass only when 24h elapsed AND 5+ sessions.
 * Light pass (git pull + embed new entries) every session start.
 *
 * Features:
 *   - Git sync (pull on start, push after changes)
 *   - Dual-gate consolidation trigger (24h + 5 sessions)
 *   - Lock file to prevent concurrent runs
 *   - Deduplication via embedding similarity
 *   - Contradiction detection (similar embeddings, opposing content)
 *   - Stale entry detection (referenced files/functions no longer exist)
 *   - Pattern analysis (themes, gaps, recurring failures)
 *   - Autonomous investigation subagent spawning
 *   - Agent creation via pi-pi (polished) or template (fallback)
 *   - Auto-creates teams when 3+ agents cluster around a domain
 *   - Auto-creates chains when 5+ workflow memories appear for a domain
 *
 * Commands:
 *   /curator status     — Show memory stats, gate state, last run
 *   /curator run        — Force a full curator pass (bypasses gate)
 *   /curator findings   — Show latest analysis report
 *   /curator agents     — Show suggested/auto-created agents
 *   /curator teams      — Show auto-created teams
 *   /curator chains     — Show auto-created chains
 *
 * Usage: pi -e extensions/hivemind-curator.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	existsSync,
	readFileSync,
	writeFileSync,
	unlinkSync,
	mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
const { spawn } = require("child_process") as any;

const MEMORIES_DIR = join(homedir(), "pi-memories", "hivemind");
const MEMORIES_FILE = join(MEMORIES_DIR, "memories.jsonl");
const REPO_DIR = join(homedir(), "pi-memories");
const CURATOR_STATE_DIR = join(MEMORIES_DIR, ".curator");
const FINDINGS_FILE = join(CURATOR_STATE_DIR, "findings.json");
const STATE_FILE = join(CURATOR_STATE_DIR, "state.json");
const LOCK_FILE = join(CURATOR_STATE_DIR, "lock");
const OLLAMA_BASE = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";

// Dual-gate thresholds
const CONSOLIDATION_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CONSOLIDATION_SESSION_THRESHOLD = 5;

interface Memory {
	id: string;
	information: string;
	tags: string;
	session_date: string;
	project: string;
	embedding?: number[];
	superseded_by?: string;
	superseded_reason?: string;
	consolidated_from?: string[];
	category?: "learning" | "failure" | "decision" | "pattern";
	stale?: boolean;
	stale_reason?: string;
}

interface CuratorFindings {
	timestamp: string;
	pass_type: "light" | "full";
	duplicates_merged: number;
	contradictions_found: number;
	stale_entries: number;
	clusters_found: number;
	memories_total: number;
	memories_embedded: number;
	learnings: string[];
	failures: string[];
	gaps: string[];
	agent_suggestions: { name: string; reason: string }[];
	investigations_spawned: number;
}

interface CuratorState {
	last_consolidation: string; // ISO timestamp
	sessions_since_consolidation: number;
	total_sessions: number;
	// Learning loop tracking
	investigations_history: InvestigationRecord[];
	failure_recurrence: Record<string, { count: number; last_seen: string; fixed: boolean }>;
	auto_created_agents: string[];
	// Self-healing tracking
	health: HealthState;
}

interface InvestigationRecord {
	topic: string;
	timestamp: string;
	status: "completed" | "failed" | "pending";
	findings_summary?: string;
	follow_up_needed: boolean;
	retry_count: number;
}

interface HealthState {
	ollama_failures: number;
	git_sync_failures: number;
	last_ollama_check: string;
	last_git_sync: string;
	embedding_backlog: number;
	self_heal_actions: { action: string; timestamp: string; success: boolean }[];
}

const LOCAL_AGENTS_DEF_DIR = join(process.cwd(), ".pi", "agents");
const GLOBAL_AGENTS_DEF_DIR = join(homedir(), ".pi", "agent", "agents");
const AGENTS_DEF_DIR = existsSync(LOCAL_AGENTS_DEF_DIR) ? LOCAL_AGENTS_DEF_DIR : GLOBAL_AGENTS_DEF_DIR;

const localTeamsPath = join(LOCAL_AGENTS_DEF_DIR, "teams.yaml");
const globalTeamsPath = join(GLOBAL_AGENTS_DEF_DIR, "teams.yaml");
const TEAMS_FILE = existsSync(localTeamsPath) ? localTeamsPath : globalTeamsPath;

const localChainsPath = join(LOCAL_AGENTS_DEF_DIR, "agent-chain.yaml");
const globalChainsPath = join(GLOBAL_AGENTS_DEF_DIR, "agent-chain.yaml");
const CHAINS_FILE = existsSync(localChainsPath) ? localChainsPath : globalChainsPath;
const INVESTIGATION_LOG = join(CURATOR_STATE_DIR, "investigations.json");
const AUTO_AGENT_THRESHOLD = 8; // Create agent when tag count reaches this
const AUTO_TEAM_THRESHOLD = 3;  // Create team when 3+ related agents exist for a domain
const MAX_INVESTIGATION_RETRIES = 2;

// --- Lock file ---

function acquireLock(): boolean {
	ensureCuratorDir();
	if (existsSync(LOCK_FILE)) {
		// Check if stale (PID no longer running)
		try {
			const pid = parseInt(readFileSync(LOCK_FILE, "utf8").trim(), 10);
			if (pid && !isNaN(pid)) {
				try {
					process.kill(pid, 0); // Check if process exists
					return false; // Process alive, lock is valid
				} catch {
					// Process dead, stale lock — remove it
					unlinkSync(LOCK_FILE);
				}
			}
		} catch {
			unlinkSync(LOCK_FILE);
		}
	}
	writeFileSync(LOCK_FILE, process.pid.toString());
	return true;
}

function releaseLock(): void {
	try {
		if (existsSync(LOCK_FILE)) unlinkSync(LOCK_FILE);
	} catch {}
}

// --- State management ---

function ensureCuratorDir(): void {
	if (!existsSync(CURATOR_STATE_DIR)) mkdirSync(CURATOR_STATE_DIR, { recursive: true });
}

function defaultHealth(): HealthState {
	return {
		ollama_failures: 0,
		git_sync_failures: 0,
		last_ollama_check: new Date(0).toISOString(),
		last_git_sync: new Date(0).toISOString(),
		embedding_backlog: 0,
		self_heal_actions: [],
	};
}

function defaultState(): CuratorState {
	return {
		last_consolidation: new Date(0).toISOString(),
		sessions_since_consolidation: 0,
		total_sessions: 0,
		investigations_history: [],
		failure_recurrence: {},
		auto_created_agents: [],
		health: defaultHealth(),
	};
}

function loadState(): CuratorState {
	ensureCuratorDir();
	if (!existsSync(STATE_FILE)) return defaultState();
	try {
		const raw = JSON.parse(readFileSync(STATE_FILE, "utf8"));
		// Merge with defaults for backward compat
		return { ...defaultState(), ...raw, health: { ...defaultHealth(), ...(raw.health || {}) } };
	} catch {
		return defaultState();
	}
}

function saveState(state: CuratorState): void {
	ensureCuratorDir();
	writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function shouldRunFullPass(state: CuratorState): boolean {
	const elapsed = Date.now() - new Date(state.last_consolidation).getTime();
	return (
		elapsed >= CONSOLIDATION_INTERVAL_MS &&
		state.sessions_since_consolidation >= CONSOLIDATION_SESSION_THRESHOLD
	);
}

// --- Git sync ---

function gitPull(): string {
	if (!existsSync(join(REPO_DIR, ".git"))) return "no-repo";
	try {
		execSync(`git -C "${REPO_DIR}" pull --rebase origin main 2>&1`, { stdio: "pipe" });
		return "ok";
	} catch {
		return "pull-failed";
	}
}

function gitPush(): string {
	if (!existsSync(join(REPO_DIR, ".git"))) return "no-repo";
	try {
		execSync(`git -C "${REPO_DIR}" add -A`, { stdio: "pipe" });
		const status = execSync(`git -C "${REPO_DIR}" status --porcelain`, { stdio: "pipe" }).toString();
		if (!status.trim()) return "nothing-to-push";
		const date = new Date().toISOString().split("T")[0];
		execSync(`git -C "${REPO_DIR}" commit -m "curator: consolidation ${date}"`, { stdio: "pipe" });
		execSync(`git -C "${REPO_DIR}" push origin main`, { stdio: "pipe" });
		return "ok";
	} catch {
		return "push-failed";
	}
}

// --- Memory I/O ---

function loadMemories(): Memory[] {
	if (!existsSync(MEMORIES_FILE)) return [];
	const raw = readFileSync(MEMORIES_FILE, "utf8");
	return raw.split("\n").filter((l) => l.trim()).map((line) => {
		try { return JSON.parse(line) as Memory; } catch { return null; }
	}).filter(Boolean) as Memory[];
}

function saveMemories(memories: Memory[]): void {
	if (!existsSync(MEMORIES_DIR)) mkdirSync(MEMORIES_DIR, { recursive: true });
	writeFileSync(MEMORIES_FILE, memories.map((m) => JSON.stringify(m)).join("\n") + "\n");
}

function saveFindings(findings: CuratorFindings): void {
	ensureCuratorDir();
	writeFileSync(FINDINGS_FILE, JSON.stringify(findings, null, 2));
}

function loadFindings(): CuratorFindings | null {
	if (!existsSync(FINDINGS_FILE)) return null;
	try { return JSON.parse(readFileSync(FINDINGS_FILE, "utf8")); } catch { return null; }
}

// --- Embedding helpers ---

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
	let dot = 0, normA = 0, normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	return denom === 0 ? 0 : dot / denom;
}

// --- Deduplication ---

function findDuplicates(memories: Memory[], threshold = 0.92): { ids: string[]; keep: string }[] {
	const embedded = memories.filter((m) => m.embedding && !m.superseded_by);
	const duplicates: { ids: string[]; keep: string }[] = [];
	const seen = new Set<string>();

	for (let i = 0; i < embedded.length; i++) {
		if (seen.has(embedded[i].id)) continue;
		const group = [embedded[i].id];

		for (let j = i + 1; j < embedded.length; j++) {
			if (seen.has(embedded[j].id)) continue;
			const sim = cosineSimilarity(embedded[i].embedding!, embedded[j].embedding!);
			if (sim >= threshold) {
				group.push(embedded[j].id);
				seen.add(embedded[j].id);
			}
		}

		if (group.length > 1) {
			const sorted = group
				.map((id) => memories.find((m) => m.id === id)!)
				.sort((a, b) => b.information.length - a.information.length);
			duplicates.push({ ids: group, keep: sorted[0].id });
			seen.add(sorted[0].id);
		}
	}
	return duplicates;
}

// --- Contradiction detection ---

function findContradictions(
	memories: Memory[],
	simThreshold = 0.75,
): { id1: string; id2: string; keep: string; reason: string }[] {
	const embedded = memories.filter((m) => m.embedding && !m.superseded_by);
	const contradictions: { id1: string; id2: string; keep: string; reason: string }[] = [];

	// Negation/opposition indicators
	const negationPairs = [
		["don't", "do"], ["never", "always"], ["avoid", "use"],
		["wrong", "right"], ["bad", "good"], ["fail", "succeed"],
		["shouldn't", "should"], ["not", ""], ["disable", "enable"],
		["remove", "add"], ["break", "fix"],
	];

	for (let i = 0; i < embedded.length; i++) {
		for (let j = i + 1; j < embedded.length; j++) {
			const sim = cosineSimilarity(embedded[i].embedding!, embedded[j].embedding!);
			// High similarity (same topic) but check for opposing sentiment
			if (sim >= simThreshold && sim < 0.92) {
				const a = embedded[i].information.toLowerCase();
				const b = embedded[j].information.toLowerCase();

				let hasContradiction = false;
				let reason = "";

				for (const [neg, pos] of negationPairs) {
					const aHasNeg = a.includes(neg);
					const bHasNeg = b.includes(neg);
					const aHasPos = pos ? a.includes(pos) : false;
					const bHasPos = pos ? b.includes(pos) : false;

					if ((aHasNeg && bHasPos && !bHasNeg) || (bHasNeg && aHasPos && !aHasNeg)) {
						hasContradiction = true;
						reason = `Opposing stance on same topic (${neg}/${pos})`;
						break;
					}
				}

				if (hasContradiction) {
					// Keep the newer one (higher ID = more recent)
					const newer = embedded[i].id > embedded[j].id ? embedded[i] : embedded[j];
					const older = newer === embedded[i] ? embedded[j] : embedded[i];
					contradictions.push({
						id1: older.id,
						id2: newer.id,
						keep: newer.id,
						reason,
					});
				}
			}
		}
	}
	return contradictions;
}

// --- Stale entry detection ---

function findStaleEntries(memories: Memory[]): { id: string; reason: string }[] {
	const stale: { id: string; reason: string }[] = [];
	const pathRegex = /(?:~\/|\/home\/\w+\/|\.\/)?(?:[\w.-]+\/)+[\w.-]+\.\w+/g;
	const funcRegex = /(?:function|class|const|let|var|def|fn)\s+(\w+)/gi;

	for (const mem of memories) {
		if (mem.superseded_by || mem.stale) continue;

		// Check file path references
		const paths = mem.information.match(pathRegex);
		if (paths) {
			for (const p of paths) {
				const resolved = p.startsWith("~/")
					? join(homedir(), p.slice(2))
					: p.startsWith("/")
						? p
						: null;
				if (resolved && !existsSync(resolved)) {
					stale.push({ id: mem.id, reason: `Referenced file "${p}" no longer exists` });
					break;
				}
			}
		}

		// Check function/class name references (grep in cwd if available)
		const funcs = [...mem.information.matchAll(funcRegex)];
		if (funcs.length > 0) {
			for (const match of funcs) {
				const name = match[1];
				if (name.length < 4) continue; // Skip short names (too generic)
				try {
					const result = execSync(
						`grep -r --include='*.ts' --include='*.js' --include='*.py' -l "${name}" . 2>/dev/null | head -1`,
						{ stdio: "pipe", timeout: 3000 },
					).toString().trim();
					if (!result) {
						stale.push({ id: mem.id, reason: `Referenced symbol "${name}" not found in codebase` });
						break;
					}
				} catch {
					// grep failed or timed out — skip this check
				}
			}
		}
	}
	return stale;
}

// --- Self-healing system ---

async function selfHeal(state: CuratorState, log: (msg: string) => void): Promise<void> {
	const now = new Date().toISOString();

	// Heal 1: Ollama down — try to restart it
	if (state.health.ollama_failures >= 3) {
		log("Self-heal: Ollama has failed 3+ times, attempting restart...");
		try {
			execSync("ollama serve &", { stdio: "ignore", timeout: 5000 });
			// Wait a moment for startup
			await new Promise((r) => setTimeout(r, 3000));
			const check = await fetch(`${OLLAMA_BASE}/api/tags`).catch(() => null);
			if (check?.ok) {
				state.health.ollama_failures = 0;
				state.health.self_heal_actions.push({ action: "restarted ollama", timestamp: now, success: true });
				log("Self-heal: Ollama restarted successfully");
			} else {
				state.health.self_heal_actions.push({ action: "restarted ollama", timestamp: now, success: false });
				log("Self-heal: Ollama restart failed — manual intervention needed");
			}
		} catch {
			state.health.self_heal_actions.push({ action: "restarted ollama", timestamp: now, success: false });
		}
	}

	// Heal 2: Git sync broken — try different strategies
	if (state.health.git_sync_failures >= 3) {
		log("Self-heal: Git sync has failed 3+ times, attempting recovery...");
		try {
			// Try resetting to remote state
			execSync(`git -C "${REPO_DIR}" fetch origin main 2>&1`, { stdio: "pipe", timeout: 15000 });
			execSync(`git -C "${REPO_DIR}" reset --soft origin/main 2>&1`, { stdio: "pipe" });
			state.health.git_sync_failures = 0;
			state.health.self_heal_actions.push({ action: "reset git to origin/main", timestamp: now, success: true });
			log("Self-heal: Git sync recovered");
		} catch {
			state.health.self_heal_actions.push({ action: "reset git to origin/main", timestamp: now, success: false });
			log("Self-heal: Git recovery failed — manual intervention needed");
		}
	}

	// Heal 3: Embedding backlog — batch process if Ollama is available
	if (state.health.embedding_backlog > 10) {
		log(`Self-heal: ${state.health.embedding_backlog} memories need embeddings, batch processing...`);
		const memories = loadMemories();
		let fixed = 0;
		for (const mem of memories) {
			if (!mem.embedding) {
				const emb = await getEmbedding(`${mem.information} ${mem.tags}`);
				if (emb) {
					mem.embedding = emb;
					fixed++;
				} else {
					break; // Ollama down again
				}
			}
		}
		if (fixed > 0) {
			saveMemories(memories);
			state.health.embedding_backlog -= fixed;
			state.health.self_heal_actions.push({ action: `backfilled ${fixed} embeddings`, timestamp: now, success: true });
			log(`Self-heal: Embedded ${fixed} memories`);
		}
	}

	// Keep self_heal_actions from growing unbounded
	if (state.health.self_heal_actions.length > 50) {
		state.health.self_heal_actions = state.health.self_heal_actions.slice(-25);
	}
}

// --- Learning loop: track failure recurrence ---

function trackFailureRecurrence(memories: Memory[], state: CuratorState): void {
	const failureKeywords = ["fail", "error", "bug", "broke", "crash"];
	const fixKeywords = ["fix", "fixed", "solution", "resolved", "solved"];

	for (const mem of memories) {
		if (mem.superseded_by || mem.stale) continue;
		const lower = mem.information.toLowerCase();
		const tags = mem.tags.toLowerCase();

		// Track failure patterns by tag
		const isFailure = failureKeywords.some((k) => lower.includes(k));
		const isFix = fixKeywords.some((k) => lower.includes(k));

		for (const tag of tags.split(",").map((t) => t.trim()).filter(Boolean)) {
			if (tag === "auto-save" || tag === "curator" || tag === "investigation") continue;

			if (!state.failure_recurrence[tag]) {
				state.failure_recurrence[tag] = { count: 0, last_seen: "", fixed: false };
			}

			if (isFailure) {
				state.failure_recurrence[tag].count++;
				state.failure_recurrence[tag].last_seen = mem.session_date;
				state.failure_recurrence[tag].fixed = false;
			}
			if (isFix) {
				state.failure_recurrence[tag].fixed = true;
			}
		}
	}
}

function getUnresolvedFailures(state: CuratorState): { tag: string; count: number; last_seen: string }[] {
	return Object.entries(state.failure_recurrence)
		.filter(([, v]) => !v.fixed && v.count >= 2)
		.sort((a, b) => b[1].count - a[1].count)
		.map(([tag, v]) => ({ tag, count: v.count, last_seen: v.last_seen }));
}

// --- Learning loop: investigation feedback ---

function processInvestigationResults(state: CuratorState, memories: Memory[]): string[] {
	const actions: string[] = [];

	// Find investigation memories that haven't been processed
	const investigationMems = memories.filter(
		(m) => m.tags.includes("investigation") && m.category === "learning" && !m.stale,
	);

	for (const record of state.investigations_history) {
		if (record.status !== "completed" || !record.follow_up_needed) continue;

		// Check if the investigation's topic still shows up as a gap
		const relatedFailures = getUnresolvedFailures(state).filter(
			(f) => record.topic.toLowerCase().includes(f.tag),
		);

		if (relatedFailures.length > 0) {
			// The investigation didn't resolve the underlying issue
			if (record.retry_count < MAX_INVESTIGATION_RETRIES) {
				record.retry_count++;
				record.status = "pending"; // Will be re-investigated
				actions.push(`Re-investigating "${record.topic}" (attempt ${record.retry_count + 1}) — issue persists`);
			} else {
				// Escalate — flag for human review
				actions.push(`ESCALATE: "${record.topic}" unresolved after ${MAX_INVESTIGATION_RETRIES + 1} attempts`);
				record.follow_up_needed = false; // Stop retrying
			}
		} else {
			// Issue appears resolved
			record.follow_up_needed = false;
			actions.push(`Resolved: "${record.topic}" — no longer recurring`);
		}
	}

	return actions;
}

// --- Auto-create agents from patterns ---

function autoCreateAgents(
	state: CuratorState,
	agentSuggestions: { name: string; reason: string }[],
	memories: Memory[],
	ctx: any,
	log: (msg: string) => void,
): string[] {
	const created: string[] = [];

	for (const suggestion of agentSuggestions) {
		// Skip if already created
		if (state.auto_created_agents.includes(suggestion.name)) continue;

		// Only auto-create if the tag count is high enough
		const tagMatch = suggestion.reason.match(/(\d+)\s+memories/);
		const count = tagMatch ? parseInt(tagMatch[1], 10) : 0;
		if (count < AUTO_AGENT_THRESHOLD) continue;

		const agentName = suggestion.name.replace(/[^a-z0-9-]/g, "-");
		const agentFile = join(AGENTS_DEF_DIR, `${agentName}.md`);

		if (existsSync(agentFile)) {
			state.auto_created_agents.push(suggestion.name);
			continue; // Already exists
		}

		const domain = agentName.replace(/-specialist$/, "").replace(/-/g, " ");

		// Gather relevant memory context for pi-pi
		const relevantMems = memories
			.filter(m => !m.superseded_by && !m.stale && m.tags.toLowerCase().includes(domain.replace(/ /g, "")))
			.slice(0, 10)
			.map(m => `- ${m.information}`)
			.join("\n");

		// Spawn pi-pi for a polished agent definition
		if (relevantMems.length > 0) {
			spawnPiPiAgent(agentName, domain, relevantMems, ctx);
			state.auto_created_agents.push(suggestion.name);
			created.push(agentName);
			log(`Spawned pi-pi to create agent: ${agentName} (${count} memory patterns)`);
		} else {
			// Fallback: write a basic template if no memory context
			const agentContent = `---
name: ${agentName}
description: Auto-generated specialist for ${domain} — created by Hivemind Curator based on ${count} memory patterns.
tools: read,grep,find,ls,bash
---

You are a ${domain} specialist, auto-generated by the Hivemind Curator because the memory store contains ${count}+ entries about ${domain}.

## Your Role

1. **Deep expertise** in ${domain} — answer questions, review code, and suggest improvements
2. **Pattern recognition** — identify recurring issues and best practices from past memories
3. **Knowledge synthesis** — consolidate scattered learnings into actionable guidelines

## How You Work

1. Check Hivemind memories for existing knowledge about ${domain}
2. Analyze the codebase for ${domain}-related patterns
3. Provide specific, actionable recommendations

## Stop Conditions
- Direct answer found with high confidence
- 2 search iterations with no new findings
`;
			try {
				if (!existsSync(AGENTS_DEF_DIR)) mkdirSync(AGENTS_DEF_DIR, { recursive: true });
				writeFileSync(agentFile, agentContent);
				state.auto_created_agents.push(suggestion.name);
				created.push(agentName);
				log(`Auto-created agent (template): ${agentName} (${count} memory patterns)`);
			} catch {}
		}
	}

	return created;
}

// --- Spawn pi-pi for polished agent creation ---

function spawnPiPiAgent(
	agentName: string,
	domain: string,
	memoryContext: string,
	ctx: any,
): void {
	const model = ctx.model
		? `${ctx.model.provider}/${ctx.model.id}`
		: "anthropic/claude-sonnet-4-6";

	const prompt = `Create a specialist agent definition for "${agentName}" focused on ${domain}.

Context from memory patterns:
${memoryContext}

Requirements:
- Write a proper .pi/agents/${agentName}.md file with frontmatter (name, description, tools) and a detailed system prompt
- The agent should be an expert in ${domain} based on the patterns found in the memory store
- Include specific workflows, output formats, and stop conditions
- Match the style of existing agents in .pi/agents/

Read a few existing agent files first to match the format, then write the new agent file.`;

	const sessionDir = join(homedir(), ".pi", "agent", "sessions", "curator-pipi");
	mkdirSync(sessionDir, { recursive: true });
	const sessionFile = join(sessionDir, `pipi-${Date.now()}.jsonl`);

	const proc = spawn("pi", [
		"--mode", "json",
		"-p",
		"--session", sessionFile,
		"--no-extensions",
		"--model", model,
		"--tools", "read,write,edit,grep,find,ls",
		"--thinking", "off",
		prompt,
	], {
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env },
	});

	proc.stdout?.setEncoding("utf-8");
	proc.stdout?.on("data", () => {});
	proc.stderr?.setEncoding("utf-8");
	proc.stderr?.on("data", () => {});

	proc.on("close", (code: number) => {
		const status = code === 0 ? "created" : "failed";
		ctx.ui?.notify(`Curator pi-pi: agent "${agentName}" ${status}`);
	});
}

// --- Auto-create teams from related agents ---

function autoCreateTeams(
	state: CuratorState,
	agentSuggestions: { name: string; reason: string }[],
	log: (msg: string) => void,
): string[] {
	if (!existsSync(TEAMS_FILE)) return [];

	// Group suggestions by domain prefix (e.g. "auth-specialist", "auth-reviewer" → "auth")
	const domainAgents = new Map<string, string[]>();
	const allCreated = state.auto_created_agents || [];

	for (const suggestion of agentSuggestions) {
		const agentName = suggestion.name.replace(/[^a-z0-9-]/g, "-");
		// Only consider agents that actually exist as files
		if (!existsSync(join(AGENTS_DEF_DIR, `${agentName}.md`))) continue;

		const domain = agentName.replace(/-specialist$/, "").replace(/-expert$/, "");
		if (!domainAgents.has(domain)) domainAgents.set(domain, []);
		domainAgents.get(domain)!.push(agentName);
	}

	// Also scan existing auto-created agents for domain grouping
	for (const name of allCreated) {
		const agentName = name.replace(/[^a-z0-9-]/g, "-");
		if (!existsSync(join(AGENTS_DEF_DIR, `${agentName}.md`))) continue;
		const domain = agentName.replace(/-specialist$/, "").replace(/-expert$/, "");
		if (!domainAgents.has(domain)) domainAgents.set(domain, []);
		if (!domainAgents.get(domain)!.includes(agentName)) {
			domainAgents.get(domain)!.push(agentName);
		}
	}

	const teamsCreated: string[] = [];
	let teamsContent = readFileSync(TEAMS_FILE, "utf-8");

	for (const [domain, agents] of domainAgents) {
		if (agents.length < AUTO_TEAM_THRESHOLD) continue;

		const teamName = `${domain}-team`;
		// Skip if team already exists
		if (teamsContent.includes(`${teamName}:`)) continue;

		// Build team: domain specialists + core agents (scout, builder, reviewer)
		const coreAgents = ["scout", "builder", "reviewer"];
		const teamMembers = [...new Set([...agents, ...coreAgents])];

		const teamBlock = `\n${teamName}:\n${teamMembers.map(m => `  - ${m}`).join("\n")}\n`;
		teamsContent += teamBlock;
		teamsCreated.push(teamName);
		log(`Auto-created team: ${teamName} (${teamMembers.join(", ")})`);
	}

	if (teamsCreated.length > 0) {
		writeFileSync(TEAMS_FILE, teamsContent);
	}

	return teamsCreated;
}

// --- Auto-create chains from workflow patterns ---

function autoCreateChains(
	state: CuratorState,
	memories: Memory[],
	log: (msg: string) => void,
): string[] {
	if (!existsSync(CHAINS_FILE)) return [];

	const active = memories.filter(m => !m.superseded_by && !m.stale);
	const chainsCreated: string[] = [];
	let chainsContent = readFileSync(CHAINS_FILE, "utf-8");

	// Detect workflow patterns: if memories mention a sequence of steps for a domain
	const workflowKeywords = ["first", "then", "after", "before", "next", "finally", "step"];
	const domainWorkflows = new Map<string, number>();

	for (const mem of active) {
		const lower = mem.information.toLowerCase();
		const hasWorkflow = workflowKeywords.some(k => lower.includes(k));
		if (!hasWorkflow) continue;

		for (const tag of mem.tags.split(",").map(t => t.trim()).filter(Boolean)) {
			if (["auto-save", "curator", "investigation"].includes(tag)) continue;
			domainWorkflows.set(tag, (domainWorkflows.get(tag) || 0) + 1);
		}
	}

	// Create chains for domains with 5+ workflow-related memories
	for (const [domain, count] of domainWorkflows) {
		if (count < 5) continue;

		const chainName = `${domain}-workflow`;
		if (chainsContent.includes(`${chainName}:`)) continue;

		// Check if a domain specialist exists
		const specialistName = `${domain}-specialist`;
		const hasSpecialist = existsSync(join(AGENTS_DEF_DIR, `${specialistName}.md`));

		// Build a standard research → plan → build → review chain, injecting specialist if available
		const steps: string[] = [];
		if (hasSpecialist) {
			steps.push(
				`    - agent: ${specialistName}`,
				`      prompt: "Research ${domain} patterns and best practices for: $INPUT\\n\\nReturn key findings and recommendations."`,
			);
		} else {
			steps.push(
				`    - agent: librarian`,
				`      prompt: "Research ${domain} documentation and best practices for: $INPUT\\n\\nReturn key findings and recommendations."`,
			);
		}
		steps.push(
			`    - agent: planner`,
			`      prompt: "Based on this ${domain} research, create an implementation plan for: $ORIGINAL\\n\\nResearch findings:\\n$INPUT"`,
			`    - agent: builder`,
			`      prompt: "Implement the following plan:\\n\\n$INPUT\\n\\nOriginal request: $ORIGINAL"`,
			`    - agent: reviewer`,
			`      prompt: "Review this ${domain} implementation for correctness and quality:\\n\\n$INPUT\\n\\nOriginal request: $ORIGINAL"`,
		);

		const chainBlock = `\n${chainName}:\n  description: "Auto-generated ${domain} workflow — research, plan, build, review"\n  steps:\n${steps.join("\n")}\n`;
		chainsContent += chainBlock;
		chainsCreated.push(chainName);
		log(`Auto-created chain: ${chainName} (${count} workflow memories)`);
	}

	if (chainsCreated.length > 0) {
		writeFileSync(CHAINS_FILE, chainsContent);
	}

	return chainsCreated;
}

// --- Clustering ---

interface Cluster {
	theme: string;
	memory_ids: string[];
	summary: string;
}

function clusterMemories(memories: Memory[], threshold = 0.7): Cluster[] {
	const embedded = memories.filter((m) => m.embedding && !m.superseded_by && !m.stale);
	if (embedded.length < 3) return [];

	const assigned = new Set<string>();
	const clusters: Cluster[] = [];

	for (const mem of embedded) {
		if (assigned.has(mem.id)) continue;

		const neighbors = embedded.filter(
			(other) =>
				other.id !== mem.id &&
				!assigned.has(other.id) &&
				cosineSimilarity(mem.embedding!, other.embedding!) >= threshold,
		);

		if (neighbors.length >= 2) {
			const group = [mem, ...neighbors];
			for (const m of group) assigned.add(m.id);

			const allTags = group.flatMap((m) => m.tags.split(",").map((t) => t.trim()).filter(Boolean));
			const tagCounts = new Map<string, number>();
			for (const t of allTags) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
			const topTags = [...tagCounts.entries()]
				.sort((a, b) => b[1] - a[1])
				.slice(0, 3)
				.map(([t]) => t);

			clusters.push({
				theme: topTags.join(", ") || group[0].project,
				memory_ids: group.map((m) => m.id),
				summary: `${group.length} related memories about ${topTags.join(", ") || "this topic"}`,
			});
		}
	}
	return clusters;
}

// --- Pattern analysis ---

function analyzePatterns(memories: Memory[]): {
	learnings: string[];
	failures: string[];
	gaps: string[];
	agent_suggestions: { name: string; reason: string }[];
} {
	const active = memories.filter((m) => !m.superseded_by && !m.stale);
	const learnings: string[] = [];
	const failures: string[] = [];
	const gaps: string[] = [];
	const agent_suggestions: { name: string; reason: string }[] = [];

	const projectCounts = new Map<string, number>();
	const tagCounts = new Map<string, number>();
	const failureKeywords = ["fail", "error", "bug", "broke", "wrong", "issue", "crash", "fix"];
	const learningKeywords = ["learned", "works", "solution", "best practice", "pattern", "approach"];

	for (const mem of active) {
		projectCounts.set(mem.project, (projectCounts.get(mem.project) || 0) + 1);
		for (const tag of mem.tags.split(",").map((t) => t.trim()).filter(Boolean)) {
			tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
		}

		const lower = mem.information.toLowerCase();
		if (failureKeywords.some((k) => lower.includes(k))) {
			failures.push(mem.information);
			if (!mem.category) mem.category = "failure";
		}
		if (learningKeywords.some((k) => lower.includes(k))) {
			learnings.push(mem.information);
			if (!mem.category) mem.category = "learning";
		}
	}

	const topTags = [...tagCounts.entries()]
		.sort((a, b) => b[1] - a[1])
		.filter(([, count]) => count >= 5);

	for (const [tag, count] of topTags) {
		agent_suggestions.push({
			name: `${tag}-specialist`,
			reason: `${count} memories tagged "${tag}" — a dedicated agent could systematize this knowledge`,
		});
	}

	const failureProjects = new Map<string, number>();
	for (const mem of active) {
		if (mem.category === "failure") {
			failureProjects.set(mem.project, (failureProjects.get(mem.project) || 0) + 1);
		}
	}
	for (const [project, count] of failureProjects) {
		if (count >= 3) {
			gaps.push(`Project "${project}" has ${count} recorded failures — needs investigation`);
		}
	}

	const failureTags = new Set<string>();
	const learningTags = new Set<string>();
	for (const mem of active) {
		const tags = mem.tags.split(",").map((t) => t.trim()).filter(Boolean);
		if (mem.category === "failure") tags.forEach((t) => failureTags.add(t));
		if (mem.category === "learning") tags.forEach((t) => learningTags.add(t));
	}
	for (const tag of failureTags) {
		if (!learningTags.has(tag)) {
			gaps.push(`Tag "${tag}" appears in failures but has no matching learnings — unresolved area`);
		}
	}

	return { learnings: learnings.slice(0, 10), failures: failures.slice(0, 10), gaps, agent_suggestions };
}

// --- Subagent spawning ---

function spawnInvestigationAgent(
	topic: string,
	context: string,
	ctx: any,
	pi: ExtensionAPI,
): void {
	const model = ctx.model
		? `${ctx.model.provider}/${ctx.model.id}`
		: "anthropic/claude-sonnet-4-6";

	const prompt = `You are a Hivemind investigation agent. Your task is to investigate the following pattern found in the memory store and produce actionable findings.

Topic: ${topic}
Context: ${context}

Instructions:
1. Analyze the pattern described above
2. Search the codebase for related code, configs, or documentation
3. Identify root causes if this is about failures
4. Propose concrete improvements or fixes
5. Summarize your findings concisely

Output your findings as a structured summary.`;

	const sessionDir = join(homedir(), ".pi", "agent", "sessions", "curator-investigations");
	mkdirSync(sessionDir, { recursive: true });
	const sessionFile = join(sessionDir, `investigation-${Date.now()}.jsonl`);

	const proc = spawn("pi", [
		"--mode", "json",
		"-p",
		"--session", sessionFile,
		"--no-extensions",
		"--model", model,
		"--tools", "read,bash,grep,find,ls",
		"--thinking", "off",
		prompt,
	], {
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env },
	});

	let result = "";
	proc.stdout?.setEncoding("utf-8");
	proc.stdout?.on("data", (chunk: string) => {
		for (const line of chunk.split("\n").filter((l: string) => l.trim())) {
			try {
				const event = JSON.parse(line);
				if (event.assistantMessageEvent?.type === "text_delta") {
					result += event.assistantMessageEvent.delta || "";
				}
			} catch {}
		}
	});

	proc.on("close", (code: number) => {
		const investigationStatus = code === 0 ? "completed" : "failed";
		pi.sendMessage({
			customType: "curator-investigation",
			content: `Curator investigation "${topic}" ${investigationStatus}.\n\nFindings:\n${result.slice(0, 6000)}${result.length > 6000 ? "\n... [truncated]" : ""}`,
			display: true,
		});

		// Update investigation history in state (learning loop feedback)
		const state = loadState();
		const record = state.investigations_history.find((r) => r.topic === topic);
		if (record) {
			record.status = investigationStatus as "completed" | "failed";
			record.findings_summary = result.slice(0, 300);
			record.follow_up_needed = investigationStatus === "completed"; // Will be checked in next full pass
		}
		saveState(state);

		if (code === 0 && result.length > 50) {
			const mem: Memory = {
				id: Date.now().toString(),
				information: `[Curator Investigation] ${topic}: ${result.slice(0, 500)}`,
				tags: "curator,investigation," + topic.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
				session_date: new Date().toISOString().split("T")[0],
				project: "hivemind-curator",
				category: "learning",
			};
			const memories = loadMemories();
			memories.push(mem);
			saveMemories(memories);
		}
	});

	ctx.ui?.notify(`Curator spawned investigation: "${topic}"`);
}

// --- Light pass (every session) ---

async function runLightPass(
	ctx: any,
): Promise<{ pulled: string; newEmbeddings: number; healed: boolean }> {
	const state = loadState();
	const pulled = gitPull();
	if (pulled === "pull-failed") {
		state.health.git_sync_failures++;
	} else {
		state.health.git_sync_failures = 0;
		state.health.last_git_sync = new Date().toISOString();
	}

	let newEmbeddings = 0;
	const memories = loadMemories();
	for (const mem of memories) {
		if (!mem.embedding) {
			const emb = await getEmbedding(`${mem.information} ${mem.tags}`);
			if (emb) {
				mem.embedding = emb;
				newEmbeddings++;
			} else {
				state.health.ollama_failures++;
				break;
			}
		}
	}
	if (newEmbeddings > 0) {
		state.health.ollama_failures = 0;
		saveMemories(memories);
		gitPush();
	}

	state.health.embedding_backlog = memories.filter((m) => !m.embedding).length;

	// Self-heal during light pass if needed
	let healed = false;
	if (state.health.ollama_failures >= 3 || state.health.git_sync_failures >= 3 || state.health.embedding_backlog > 10) {
		const log = (msg: string) => ctx.ui?.notify(msg);
		await selfHeal(state, log);
		healed = true;
	}

	saveState(state);
	return { pulled, newEmbeddings, healed };
}

// --- Full curator pass ---

async function runFullPass(
	ctx: any,
	pi: ExtensionAPI,
	verbose: boolean = false,
): Promise<CuratorFindings> {
	const log = verbose ? (msg: string) => ctx.ui?.notify(msg) : (_msg: string) => {};

	// Step 1: Git pull
	log("Curator: pulling latest memories...");
	gitPull();

	// Step 2: Load memories
	let memories = loadMemories();
	if (memories.length === 0) {
		const findings: CuratorFindings = {
			timestamp: new Date().toISOString(), pass_type: "full",
			duplicates_merged: 0, contradictions_found: 0, stale_entries: 0,
			clusters_found: 0, memories_total: 0, memories_embedded: 0,
			learnings: [], failures: [], gaps: [],
			agent_suggestions: [], investigations_spawned: 0,
		};
		saveFindings(findings);
		return findings;
	}

	// Step 3: Embed any un-embedded memories
	let newEmbeddings = 0;
	for (const mem of memories) {
		if (!mem.embedding) {
			const emb = await getEmbedding(`${mem.information} ${mem.tags}`);
			if (emb) {
				mem.embedding = emb;
				newEmbeddings++;
			} else {
				break;
			}
		}
	}
	if (newEmbeddings > 0) log(`Curator: embedded ${newEmbeddings} new memories`);

	// Step 4: Deduplicate
	const dupes = findDuplicates(memories);
	for (const dupe of dupes) {
		for (const id of dupe.ids) {
			if (id === dupe.keep) continue;
			const mem = memories.find((m) => m.id === id);
			if (mem) {
				mem.superseded_by = dupe.keep;
				mem.superseded_reason = "duplicate";
			}
		}
		const kept = memories.find((m) => m.id === dupe.keep);
		if (kept) {
			kept.consolidated_from = [...(kept.consolidated_from || []), ...dupe.ids.filter((id) => id !== dupe.keep)];
		}
	}
	if (dupes.length > 0) log(`Curator: merged ${dupes.length} duplicate groups`);

	// Step 5: Detect contradictions
	const contradictions = findContradictions(memories);
	for (const c of contradictions) {
		const older = memories.find((m) => m.id === c.id1);
		if (older) {
			older.superseded_by = c.keep;
			older.superseded_reason = `contradiction: ${c.reason}`;
		}
	}
	if (contradictions.length > 0) log(`Curator: resolved ${contradictions.length} contradictions`);

	// Step 6: Detect stale entries
	const staleEntries = findStaleEntries(memories);
	for (const s of staleEntries) {
		const mem = memories.find((m) => m.id === s.id);
		if (mem) {
			mem.stale = true;
			mem.stale_reason = s.reason;
		}
	}
	if (staleEntries.length > 0) log(`Curator: marked ${staleEntries.length} stale entries`);

	// Step 7: Cluster
	const clusters = clusterMemories(memories);
	if (clusters.length > 0) log(`Curator: found ${clusters.length} topic clusters`);

	// Step 8: Analyze patterns
	const analysis = analyzePatterns(memories);

	// Step 9: Save updated memories
	saveMemories(memories);

	// Step 10: Build findings
	const findings: CuratorFindings = {
		timestamp: new Date().toISOString(),
		pass_type: "full",
		duplicates_merged: dupes.length,
		contradictions_found: contradictions.length,
		stale_entries: staleEntries.length,
		clusters_found: clusters.length,
		memories_total: memories.length,
		memories_embedded: memories.filter((m) => m.embedding).length,
		learnings: analysis.learnings,
		failures: analysis.failures,
		gaps: analysis.gaps,
		agent_suggestions: analysis.agent_suggestions,
		investigations_spawned: 0,
	};

	// Step 11: Learning loop — track failure recurrence
	const state = loadState();
	trackFailureRecurrence(memories, state);
	const unresolvedFailures = getUnresolvedFailures(state);
	if (unresolvedFailures.length > 0) {
		log(`Curator: ${unresolvedFailures.length} unresolved recurring failures detected`);
	}

	// Step 12: Learning loop — process previous investigation results
	const loopActions = processInvestigationResults(state, memories);
	for (const action of loopActions) log(`Curator loop: ${action}`);

	// Step 13: Self-healing check
	// Update health stats from this pass
	const embeddingBacklog = memories.filter((m) => !m.embedding).length;
	state.health.embedding_backlog = embeddingBacklog;
	state.health.last_ollama_check = new Date().toISOString();
	if (newEmbeddings === 0 && embeddingBacklog > 0) {
		state.health.ollama_failures++;
	} else {
		state.health.ollama_failures = 0;
	}
	await selfHeal(state, log);

	// Step 14: Spawn investigation agents for gaps + unresolved failures
	const maxInvestigations = 2;
	const investigationTopics: string[] = [];

	// Prioritize re-investigations from the learning loop
	for (const record of state.investigations_history) {
		if (record.status === "pending" && investigationTopics.length < maxInvestigations) {
			investigationTopics.push(record.topic);
		}
	}

	// Then new gaps
	for (const gap of analysis.gaps) {
		if (investigationTopics.length >= maxInvestigations) break;
		const topic = gap.split("—")[0]?.trim() || gap;
		if (!investigationTopics.includes(topic)) {
			investigationTopics.push(topic);
		}
	}

	// Then unresolved recurring failures
	for (const failure of unresolvedFailures) {
		if (investigationTopics.length >= maxInvestigations) break;
		const topic = `Recurring failure: "${failure.tag}" (${failure.count}x)`;
		if (!investigationTopics.includes(topic)) {
			investigationTopics.push(topic);
		}
	}

	for (const topic of investigationTopics) {
		spawnInvestigationAgent(topic, topic, ctx, pi);
		findings.investigations_spawned++;

		// Track in investigation history
		const existing = state.investigations_history.find((r) => r.topic === topic);
		if (existing) {
			existing.status = "pending";
			existing.timestamp = new Date().toISOString();
		} else {
			state.investigations_history.push({
				topic,
				timestamp: new Date().toISOString(),
				status: "pending",
				follow_up_needed: true,
				retry_count: 0,
			});
		}
	}

	// Step 15: Auto-create agents from patterns (spawns pi-pi for polished definitions)
	const newAgents = autoCreateAgents(state, analysis.agent_suggestions, memories, ctx, log);
	if (newAgents.length > 0) {
		log(`Curator: created ${newAgents.length} agent(s) via pi-pi: ${newAgents.join(", ")}`);
	}

	// Step 16: Auto-create teams from related agents
	const newTeams = autoCreateTeams(state, analysis.agent_suggestions, log);
	if (newTeams.length > 0) {
		log(`Curator: auto-created ${newTeams.length} team(s): ${newTeams.join(", ")}`);
	}

	// Step 17: Auto-create chains from workflow patterns
	const newChains = autoCreateChains(state, memories, log);
	if (newChains.length > 0) {
		log(`Curator: auto-created ${newChains.length} chain(s): ${newChains.join(", ")}`);
	}

	// Keep investigation history bounded
	if (state.investigations_history.length > 50) {
		state.investigations_history = state.investigations_history.slice(-30);
	}

	// Step 18: Save findings, update state, push
	saveFindings(findings);
	state.last_consolidation = new Date().toISOString();
	state.sessions_since_consolidation = 0;
	saveState(state);

	const pushResult = gitPush();
	if (pushResult === "push-failed") {
		state.health.git_sync_failures++;
		saveState(state);
	} else {
		state.health.git_sync_failures = 0;
		state.health.last_git_sync = new Date().toISOString();
		saveState(state);
	}
	log("Curator: pushing changes...");

	return findings;
}

// --- Format findings for display ---

function formatFindings(f: CuratorFindings): string {
	const lines = [
		`Hivemind Curator Report [${f.pass_type}] (${f.timestamp.split("T")[0]})`,
		`─────────────────────────────────────`,
		`Memories: ${f.memories_total} total, ${f.memories_embedded} embedded`,
		`Duplicates merged: ${f.duplicates_merged}`,
		`Contradictions resolved: ${f.contradictions_found}`,
		`Stale entries marked: ${f.stale_entries}`,
		`Clusters found: ${f.clusters_found}`,
		`Investigations spawned: ${f.investigations_spawned}`,
	];

	if (f.learnings.length > 0) {
		lines.push("", "Key Learnings:");
		for (const l of f.learnings.slice(0, 5)) lines.push(`  + ${l.slice(0, 100)}`);
	}
	if (f.failures.length > 0) {
		lines.push("", "Recurring Failures:");
		for (const f2 of f.failures.slice(0, 5)) lines.push(`  - ${f2.slice(0, 100)}`);
	}
	if (f.gaps.length > 0) {
		lines.push("", "Knowledge Gaps:");
		for (const g of f.gaps) lines.push(`  ? ${g}`);
	}
	if (f.agent_suggestions.length > 0) {
		lines.push("", "Suggested New Agents:");
		for (const s of f.agent_suggestions) lines.push(`  > ${s.name}: ${s.reason}`);
	}
	return lines.join("\n");
}

// --- Extension entry ---

export default function (pi: ExtensionAPI) {
	// Auto-run on session start with dual-gate logic
	pi.on("session_start", async (_event, ctx) => {
		const memories = loadMemories();
		if (memories.length === 0) return;

		// Increment session counter
		const state = loadState();
		state.sessions_since_consolidation++;
		state.total_sessions++;
		saveState(state);

		if (shouldRunFullPass(state)) {
			// Full pass — acquire lock
			if (!acquireLock()) {
				ctx.ui?.notify("Curator: another instance running, skipping");
				return;
			}

			ctx.ui?.notify("Curator: full consolidation pass (24h + 5 sessions gate met)...");
			runFullPass(ctx, pi, false).then((findings) => {
				releaseLock();
				const summary = [];
				if (findings.duplicates_merged > 0) summary.push(`${findings.duplicates_merged} dupes`);
				if (findings.contradictions_found > 0) summary.push(`${findings.contradictions_found} contradictions`);
				if (findings.stale_entries > 0) summary.push(`${findings.stale_entries} stale`);
				if (findings.clusters_found > 0) summary.push(`${findings.clusters_found} clusters`);
				if (findings.investigations_spawned > 0) summary.push(`${findings.investigations_spawned} investigations`);
				ctx.ui?.notify(summary.length > 0
					? `Curator full pass done: ${summary.join(", ")}`
					: "Curator: memories up to date");
			}).catch(() => {
				releaseLock();
				ctx.ui?.notify("Curator: full pass failed");
			});
		} else {
			// Light pass — just sync and embed
			ctx.ui?.notify("Curator: light pass (sync + embed)...");
			runLightPass(ctx).then(({ newEmbeddings }) => {
				const gate = `${state.sessions_since_consolidation}/${CONSOLIDATION_SESSION_THRESHOLD} sessions`;
				const elapsed = Date.now() - new Date(state.last_consolidation).getTime();
				const hoursLeft = Math.max(0, (CONSOLIDATION_INTERVAL_MS - elapsed) / 3600000);
				ctx.ui?.notify(
					newEmbeddings > 0
						? `Curator: synced, ${newEmbeddings} new embeddings (full pass in: ${gate}, ${hoursLeft.toFixed(0)}h)`
						: `Curator: synced (full pass in: ${gate}, ${hoursLeft.toFixed(0)}h)`,
				);
			}).catch(() => {
				ctx.ui?.notify("Curator: light pass failed");
			});
		}
	});

	pi.registerCommand("curator", {
		description: "Memory curator: /curator status | run | findings | agents",
		handler: async (args: string, ctx) => {
			const parts = args.trim().split(/\s+/);
			const sub = parts[0]?.toLowerCase();

			if (!sub || sub === "help") {
				return [
					"Hivemind Curator Commands:",
					"  /curator status     — Memory stats, gate state, last run",
					"  /curator run        — Force full curator pass (bypasses gate)",
					"  /curator findings   — Show latest analysis report",
					"  /curator agents     — Show suggested/auto-created agents",
					"  /curator teams      — Show auto-created teams",
					"  /curator chains     — Show auto-created chains",
					"  /curator health     — Self-healing status (Ollama, git, embeddings)",
					"  /curator loop       — Learning loop: failures, investigations, auto-agents",
				].join("\n");
			}

			if (sub === "status") {
				const memories = loadMemories();
				const active = memories.filter((m) => !m.superseded_by && !m.stale);
				const embedded = memories.filter((m) => m.embedding);
				const superseded = memories.filter((m) => m.superseded_by);
				const stale = memories.filter((m) => m.stale);
				const findings = loadFindings();
				const state = loadState();

				const elapsed = Date.now() - new Date(state.last_consolidation).getTime();
				const hoursAgo = (elapsed / 3600000).toFixed(1);
				const gateReady = shouldRunFullPass(state);

				const lines = [
					`Hivemind Status:`,
					`  Total memories: ${memories.length}`,
					`  Active: ${active.length}`,
					`  Superseded: ${superseded.length}`,
					`  Stale: ${stale.length}`,
					`  Embedded: ${embedded.length}/${memories.length}`,
					"",
					`Consolidation Gate:`,
					`  Sessions since last: ${state.sessions_since_consolidation}/${CONSOLIDATION_SESSION_THRESHOLD}`,
					`  Time since last: ${hoursAgo}h / 24h`,
					`  Gate status: ${gateReady ? "READY (next session triggers full pass)" : "waiting"}`,
					`  Total sessions: ${state.total_sessions}`,
				];
				if (findings) {
					lines.push("", `Last Run [${findings.pass_type}]: ${findings.timestamp}`);
					lines.push(`  ${findings.duplicates_merged} dupes, ${findings.contradictions_found} contradictions, ${findings.stale_entries} stale, ${findings.investigations_spawned} investigations`);
				}
				return lines.join("\n");
			}

			if (sub === "run") {
				if (!acquireLock()) return "✗ Another curator instance is running. Try again later.";
				ctx.ui?.notify("Curator: starting forced full pass...");
				try {
					const findings = await runFullPass(ctx, pi, true);
					releaseLock();
					return formatFindings(findings);
				} catch (err) {
					releaseLock();
					return `✗ Full pass failed: ${err}`;
				}
			}

			if (sub === "findings") {
				const findings = loadFindings();
				if (!findings) return "No curator findings yet. Run /curator run first.";
				return formatFindings(findings);
			}

			if (sub === "agents") {
				const findings = loadFindings();
				if (!findings || findings.agent_suggestions.length === 0) {
					return "No agent suggestions yet. Run /curator run to analyze memory patterns.";
				}
				const lines = ["Suggested Agents Based on Memory Patterns:", ""];
				for (const s of findings.agent_suggestions) {
					lines.push(`  ${s.name}`);
					lines.push(`    ${s.reason}`);
					lines.push("");
				}
				return lines.join("\n");
			}

			if (sub === "health") {
				const state = loadState();
				const h = state.health;
				const lines = [
					"Hivemind Health:",
					`  Ollama failures: ${h.ollama_failures} (last check: ${h.last_ollama_check.split("T")[0]})`,
					`  Git sync failures: ${h.git_sync_failures} (last sync: ${h.last_git_sync.split("T")[0]})`,
					`  Embedding backlog: ${h.embedding_backlog}`,
				];
				if (h.self_heal_actions.length > 0) {
					lines.push("", "Recent Self-Heal Actions:");
					for (const a of h.self_heal_actions.slice(-5)) {
						lines.push(`  ${a.success ? "✓" : "✗"} ${a.action} (${a.timestamp.split("T")[0]})`);
					}
				} else {
					lines.push("", "  No self-heal actions taken yet");
				}
				return lines.join("\n");
			}

			if (sub === "loop") {
				const state = loadState();
				const lines = ["Learning Loop Status:", ""];

				// Unresolved failures
				const unresolved = getUnresolvedFailures(state);
				if (unresolved.length > 0) {
					lines.push("Unresolved Recurring Failures:");
					for (const f of unresolved.slice(0, 10)) {
						lines.push(`  ✗ "${f.tag}" — ${f.count}x (last: ${f.last_seen})`);
					}
				} else {
					lines.push("  No unresolved recurring failures");
				}

				// Investigation history
				const recent = state.investigations_history.slice(-10);
				if (recent.length > 0) {
					lines.push("", "Recent Investigations:");
					for (const r of recent) {
						const icon = r.status === "completed" ? "✓" : r.status === "failed" ? "✗" : "…";
						const retry = r.retry_count > 0 ? ` (retry #${r.retry_count})` : "";
						lines.push(`  ${icon} ${r.topic}${retry}`);
						if (r.findings_summary) {
							lines.push(`    → ${r.findings_summary.slice(0, 80)}...`);
						}
					}
				}

				// Auto-created agents
				if (state.auto_created_agents.length > 0) {
					lines.push("", "Auto-Created Agents:");
					for (const a of state.auto_created_agents) {
						lines.push(`  ★ ${a}`);
					}
				}

				return lines.join("\n");
			}

			if (sub === "teams") {
				const state = loadState();
				const created = state.auto_created_agents || [];
				if (created.length === 0) {
					return "No auto-created agents yet — teams are generated when 3+ agents cluster around a domain. Run /curator run first.";
				}
				if (!existsSync(TEAMS_FILE)) return "No teams.yaml found.";
				const content = readFileSync(TEAMS_FILE, "utf-8");
				const autoTeams = content.split("\n")
					.filter(l => l.match(/^[a-z].*-team:$/))
					.map(l => l.replace(":", ""));
				if (autoTeams.length === 0) return "No auto-created teams yet. Need 3+ related agents in a domain.";
				return `Auto-Created Teams:\n${autoTeams.map(t => `  ${t}`).join("\n")}`;
			}

			if (sub === "chains") {
				if (!existsSync(CHAINS_FILE)) return "No agent-chain.yaml found.";
				const content = readFileSync(CHAINS_FILE, "utf-8");
				const autoChains = content.split("\n")
					.filter(l => l.match(/^[a-z].*-workflow:$/))
					.map(l => l.replace(":", ""));
				if (autoChains.length === 0) return "No auto-created chains yet. Need 5+ workflow-related memories for a domain.";
				return `Auto-Created Chains:\n${autoChains.map(c => `  ${c}`).join("\n")}`;
			}

			return `Unknown subcommand: ${sub}. Try /curator help`;
		},
	});
}
