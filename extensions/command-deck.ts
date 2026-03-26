/**
 * Command Deck — Clean HUD with Planner/Orchestrator mode toggle
 *
 * Planner mode:  Read-only tools, Opus 4.6 — create plans, analyze code
 * Orchestrator:  dispatch_agent + run_chain + run_team tools — delegate work
 *                to individual agents, sequential chains, or full teams
 *
 * Shortcuts:
 *   F1  — Toggle between Planner ↔ Orchestrator mode
 *   Ctrl+L — Open model picker (Pi built-in)
 *
 * Commands:
 *   /mode              — Toggle mode (or /mode planner | /mode orchestrator)
 *   /switch-model      — Open model picker (or /switch-model <provider/id>)
 *
 * Footer: [P/O] mode  model  [context bar] %  F1 mode  ^L model
 *
 * Usage: pi -e extensions/command-deck.ts
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { spawn } from "child_process";
import { readFileSync, existsSync, readdirSync, mkdirSync, unlinkSync, writeFileSync, renameSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir } from "node:os";
import { applyExtensionDefaults } from "./themeMap.ts";

// ── Types ────────────────────────────────────────

type Mode = "planner" | "orchestrator";

interface AgentDef {
	name: string;
	description: string;
	tools: string;
	systemPrompt: string;
}

interface ChainStep {
	agent: string;
	prompt: string;
}

interface ChainDef {
	name: string;
	description: string;
	steps: ChainStep[];
}

interface ModelOption {
	id: string;
	label: string;
}

type TaskStatus = "pending" | "running" | "done" | "error";

interface TaskEntry {
	id: number;
	label: string;        // e.g. "scout", "chain:plan-build-review", "team:full"
	task: string;         // short description of what's being done
	status: TaskStatus;
	elapsed: number;
	timer?: ReturnType<typeof setInterval>;
	startTime?: number;
}

// ── Parsers ──────────────────────────────────────

function parseAgentFile(filePath: string): AgentDef | null {
	try {
		const raw = readFileSync(filePath, "utf-8");
		const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
		if (!match) return null;
		const fm: Record<string, string> = {};
		for (const line of match[1].split("\n")) {
			const idx = line.indexOf(":");
			if (idx > 0) fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
		}
		if (!fm.name) return null;
		return {
			name: fm.name,
			description: fm.description || "",
			tools: fm.tools || "read,grep,find,ls",
			systemPrompt: match[2].trim(),
		};
	} catch { return null; }
}

function scanAgentDirs(cwd: string): Map<string, AgentDef> {
	const dirs = [
		join(homedir(), ".pi", "agent", "agents"),
		join(cwd, "agents"),
		join(cwd, ".claude", "agents"),
		join(cwd, ".pi", "agents"),
	];
	const agents = new Map<string, AgentDef>();
	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		try {
			for (const file of readdirSync(dir)) {
				if (!file.endsWith(".md")) continue;
				const def = parseAgentFile(resolve(dir, file));
				if (def && !agents.has(def.name.toLowerCase())) {
					agents.set(def.name.toLowerCase(), def);
				}
			}
		} catch {}
	}
	return agents;
}

function parseTeamsYaml(raw: string): Record<string, string[]> {
	const teams: Record<string, string[]> = {};
	let current: string | null = null;
	for (const line of raw.split("\n")) {
		const teamMatch = line.match(/^(\S[^:]*):$/);
		if (teamMatch) { current = teamMatch[1].trim(); teams[current] = []; continue; }
		const itemMatch = line.match(/^\s+-\s+(.+)$/);
		if (itemMatch && current) teams[current].push(itemMatch[1].trim());
	}
	return teams;
}

function parseChainYaml(raw: string): ChainDef[] {
	const chains: ChainDef[] = [];
	let current: ChainDef | null = null;
	let currentStep: ChainStep | null = null;
	for (const line of raw.split("\n")) {
		const chainMatch = line.match(/^(\S[^:]*):$/);
		if (chainMatch) {
			if (current && currentStep) { current.steps.push(currentStep); currentStep = null; }
			current = { name: chainMatch[1].trim(), description: "", steps: [] };
			chains.push(current);
			continue;
		}
		const descMatch = line.match(/^\s+description:\s+(.+)$/);
		if (descMatch && current && !currentStep) {
			let desc = descMatch[1].trim();
			if ((desc.startsWith('"') && desc.endsWith('"')) || (desc.startsWith("'") && desc.endsWith("'")))
				desc = desc.slice(1, -1);
			current.description = desc;
			continue;
		}
		if (line.match(/^\s+steps:\s*$/) && current) continue;
		const agentMatch = line.match(/^\s+-\s+agent:\s+(.+)$/);
		if (agentMatch && current) {
			if (currentStep) current.steps.push(currentStep);
			currentStep = { agent: agentMatch[1].trim(), prompt: "" };
			continue;
		}
		const promptMatch = line.match(/^\s+prompt:\s+(.+)$/);
		if (promptMatch && currentStep) {
			let prompt = promptMatch[1].trim();
			if ((prompt.startsWith('"') && prompt.endsWith('"')) || (prompt.startsWith("'") && prompt.endsWith("'")))
				prompt = prompt.slice(1, -1);
			currentStep.prompt = prompt.replace(/\\n/g, "\n");
			continue;
		}
	}
	if (current && currentStep) current.steps.push(currentStep);
	return chains;
}

function displayName(name: string): string {
	return name.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// ── Model presets ────────────────────────────────

const MODEL_PRESETS: { id: string; label: string }[] = [
	{ id: "claude-sonnet-4-6",         label: "Sonnet 4.6" },
	{ id: "claude-opus-4-6",           label: "Opus 4.6" },
	{ id: "claude-sonnet-4-20250514",  label: "Sonnet 4" },
	{ id: "claude-opus-4-20250514",    label: "Opus 4" },
	{ id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
];

const MODE_MODELS: Record<Mode, string> = {
	planner:      "claude-opus-4-6",
	orchestrator: "claude-sonnet-4-6",
};

// ── Extension ────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let currentMode: Mode = "planner";
	let plannerDef: AgentDef | null = null;
	let orchestratorDef: AgentDef | null = null;
	let allAgents: Map<string, AgentDef> = new Map();
	let teams: Record<string, string[]> = {};
	let chains: ChainDef[] = [];
	let defaultTools: string[] = [];
	let sessionDir = "";
	let draftsDir = "";
	let plansDir = "";
	const agentSessions: Map<string, string | null> = new Map();
	let ctx: ExtensionContext | undefined;

	// ── Task tracker ────────────────────────────
	const taskList: TaskEntry[] = [];
	let nextTaskId = 1;

	function addTask(label: string, task: string): TaskEntry {
		const entry: TaskEntry = {
			id: nextTaskId++,
			label,
			task: task.length > 80 ? task.slice(0, 77) + "..." : task,
			status: "running",
			elapsed: 0,
			startTime: Date.now(),
		};
		entry.timer = setInterval(() => {
			entry.elapsed = Date.now() - entry.startTime!;
			updateWidget();
		}, 1000);
		taskList.push(entry);
		updateWidget();
		return entry;
	}

	function finishTask(entry: TaskEntry, status: "done" | "error") {
		if (entry.timer) clearInterval(entry.timer);
		entry.status = status;
		entry.elapsed = Date.now() - (entry.startTime || Date.now());
		updateWidget();
	}

	function updateWidget() {
		if (!ctx) return;
		const context = ctx;

		// Hide widget in planner mode or when no tasks exist
		if (currentMode === "planner" || taskList.length === 0) {
			context.ui.setWidget("task-tracker", undefined);
			return;
		}

		context.ui.setWidget("task-tracker", (_tui, theme) => {
			const text = new Text("", 0, 1);
			return {
				render(width: number): string[] {
					const lines: string[] = [];
					const border = theme.fg("dim", "─".repeat(width));
					const title = theme.fg("accent", theme.bold(" Tasks"));
					const done = taskList.filter(t => t.status === "done").length;
					const total = taskList.length;
					const counter = theme.fg("dim", ` ${done}/${total}`);
					lines.push(border);
					lines.push(title + counter);

					for (const t of taskList) {
						const icon = t.status === "pending" ? "○"
							: t.status === "running" ? "●"
							: t.status === "done" ? "✓" : "✗";
						const color = t.status === "pending" ? "dim"
							: t.status === "running" ? "accent"
							: t.status === "done" ? "success" : "error";
						const time = t.elapsed > 0 ? theme.fg("dim", ` ${Math.round(t.elapsed / 1000)}s`) : "";
						const labelStr = theme.fg(color, ` ${icon} `) + theme.fg("muted", t.label);
						const taskStr = theme.fg("dim", ` — ${t.task}`);
						const line = labelStr + taskStr + time;
						lines.push(truncateToWidth(line, width));
					}

					lines.push(border);
					text.setText(lines.join("\n"));
					return text.render(width);
				},
				invalidate() { text.invalidate(); },
			};
		});
	}

	// ── Orchestrator tools list (for tool restriction) ──
	const ORCHESTRATOR_TOOLS = ["dispatch_agent", "run_chain", "run_team"];

	// ── Helpers ──────────────────────────────────

	function getActiveDef(): AgentDef | null {
		return currentMode === "planner" ? plannerDef : orchestratorDef;
	}

	function applyMode(context: ExtensionContext) {
		if (currentMode === "planner") {
			const def = plannerDef;
			if (def && def.tools) {
				pi.setActiveTools(def.tools.split(",").map(t => t.trim()));
			} else {
				pi.setActiveTools(defaultTools);
			}
			// Hide task widget in planner mode
			context.ui.setWidget("task-tracker", undefined);
		} else {
			// Orchestrator: default tools + dispatch tools
			// System prompt guides the model to prefer dispatching over direct work
			const orchTools = [...new Set([...defaultTools, ...ORCHESTRATOR_TOOLS])];
			pi.setActiveTools(orchTools);
		}
		updateFooter(context);
		const icon = currentMode === "planner" ? "P" : "O";
		context.ui.setStatus("mode", `[${icon}] ${currentMode}`);
		context.ui.notify(`Mode: ${currentMode}`, "info");
	}

	function toggleMode(context: ExtensionContext) {
		currentMode = currentMode === "planner" ? "orchestrator" : "planner";
		applyMode(context);
	}

	// ── Subprocess: run a single agent ──────────

	function spawnAgent(
		agentDef: AgentDef,
		task: string,
		context: any,
	): Promise<{ output: string; exitCode: number; elapsed: number }> {
		const model = context.model
			? `${context.model.provider}/${context.model.id}`
			: "anthropic/claude-sonnet-4-6";

		const agentKey = agentDef.name.toLowerCase().replace(/\s+/g, "-");
		const agentSessionFile = join(sessionDir, `${agentKey}.json`);
		const hasSession = agentSessions.get(agentKey);

		const args = [
			"--mode", "json",
			"-p",
			"--no-extensions",
			"--model", model,
			"--tools", agentDef.tools,
			"--thinking", "off",
			"--append-system-prompt", agentDef.systemPrompt,
			"--session", agentSessionFile,
		];
		if (hasSession) args.push("-c");
		args.push(task);

		const textChunks: string[] = [];
		const startTime = Date.now();

		return new Promise((res) => {
			const proc = spawn("pi", args, {
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env },
			});

			let buffer = "";
			proc.stdout!.setEncoding("utf-8");
			proc.stdout!.on("data", (chunk: string) => {
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const event = JSON.parse(line);
						if (event.type === "message_update") {
							const delta = event.assistantMessageEvent;
							if (delta?.type === "text_delta") textChunks.push(delta.delta || "");
						}
					} catch {}
				}
			});
			proc.stderr!.setEncoding("utf-8");
			proc.stderr!.on("data", () => {});

			proc.on("close", (code) => {
				if (buffer.trim()) {
					try {
						const event = JSON.parse(buffer);
						if (event.type === "message_update") {
							const delta = event.assistantMessageEvent;
							if (delta?.type === "text_delta") textChunks.push(delta.delta || "");
						}
					} catch {}
				}
				const elapsed = Date.now() - startTime;
				if (code === 0) agentSessions.set(agentKey, agentSessionFile);
				res({ output: textChunks.join(""), exitCode: code ?? 1, elapsed });
			});

			proc.on("error", (err) => {
				res({ output: `Error spawning agent: ${err.message}`, exitCode: 1, elapsed: Date.now() - startTime });
			});
		});
	}

	// ── Tool: dispatch_agent ────────────────────

	pi.registerTool({
		name: "dispatch_agent",
		label: "Dispatch Agent",
		description: "Dispatch a task to a single specialist agent. The agent executes the task and returns the result.",
		parameters: Type.Object({
			agent: Type.String({ description: "Agent name (case-insensitive)" }),
			task: Type.String({ description: "Task description for the agent" }),
		}),
		async execute(_id, params, _signal, onUpdate, context) {
			const { agent, task } = params as { agent: string; task: string };
			const def = allAgents.get(agent.toLowerCase());
			if (!def) {
				const available = Array.from(allAgents.keys()).join(", ");
				return { content: [{ type: "text", text: `Agent "${agent}" not found. Available: ${available}` }] };
			}
			if (onUpdate) onUpdate({ content: [{ type: "text", text: `Dispatching to ${displayName(def.name)}...` }] });
			const entry = addTask(def.name, task);
			const result = await spawnAgent(def, task, context);
			const status = result.exitCode === 0 ? "done" : "error";
			finishTask(entry, status);
			const truncated = result.output.length > 8000 ? result.output.slice(0, 8000) + "\n\n... [truncated]" : result.output;
			return {
				content: [{ type: "text", text: `[${displayName(def.name)}] ${status} in ${Math.round(result.elapsed / 1000)}s\n\n${truncated}` }],
				details: { agent, status, elapsed: result.elapsed, fullOutput: result.output },
			};
		},
		renderCall(args, theme) {
			const a = (args as any).agent || "?";
			const t = (args as any).task || "";
			return new Text(
				theme.fg("toolTitle", theme.bold("dispatch_agent ")) +
				theme.fg("accent", a) + theme.fg("dim", " — ") +
				theme.fg("muted", t.length > 60 ? t.slice(0, 57) + "..." : t), 0, 0);
		},
		renderResult(result, options, theme) {
			const d = result.details as any;
			if (!d) return new Text(result.content[0]?.type === "text" ? (result.content[0] as any).text : "", 0, 0);
			if (options.isPartial) return new Text(theme.fg("accent", `● ${d.agent}`) + theme.fg("dim", " working..."), 0, 0);
			const icon = d.status === "done" ? "✓" : "✗";
			const color = d.status === "done" ? "success" : "error";
			const header = theme.fg(color, `${icon} ${d.agent}`) + theme.fg("dim", ` ${Math.round((d.elapsed || 0) / 1000)}s`);
			if (options.expanded && d.fullOutput) {
				const out = d.fullOutput.length > 4000 ? d.fullOutput.slice(0, 4000) + "\n... [truncated]" : d.fullOutput;
				return new Text(header + "\n" + theme.fg("muted", out), 0, 0);
			}
			return new Text(header, 0, 0);
		},
	});

	// ── Tool: run_chain ─────────────────────────

	pi.registerTool({
		name: "run_chain",
		label: "Run Chain",
		description: "Execute a named agent chain (sequential pipeline). Each step's output feeds into the next.",
		parameters: Type.Object({
			chain: Type.String({ description: "Chain name from agent-chain.yaml" }),
			task: Type.String({ description: "The task/prompt to start the chain with" }),
		}),
		async execute(_id, params, _signal, onUpdate, context) {
			const { chain: chainName, task } = params as { chain: string; task: string };
			const chain = chains.find(c => c.name.toLowerCase() === chainName.toLowerCase());
			if (!chain) {
				const available = chains.map(c => c.name).join(", ");
				return { content: [{ type: "text", text: `Chain "${chainName}" not found. Available: ${available}` }] };
			}
			if (onUpdate) {
				const flow = chain.steps.map(s => displayName(s.agent)).join(" → ");
				onUpdate({ content: [{ type: "text", text: `Running chain: ${chain.name} (${flow})...` }] });
			}

			// Add pending tasks for each chain step
			const stepEntries: TaskEntry[] = chain.steps.map((s, i) => {
				const entry: TaskEntry = {
					id: nextTaskId++,
					label: `${chain.name}[${i + 1}] ${s.agent}`,
					task: i === 0 ? task : "awaiting input",
					status: "pending",
					elapsed: 0,
				};
				taskList.push(entry);
				return entry;
			});
			updateWidget();

			const chainStart = Date.now();
			let input = task;
			const original = task;

			for (let i = 0; i < chain.steps.length; i++) {
				const step = chain.steps[i];
				const agentDef = allAgents.get(step.agent.toLowerCase());
				if (!agentDef) {
					stepEntries[i].status = "error";
					stepEntries[i].task = "agent not found";
					updateWidget();
					return { content: [{ type: "text", text: `Chain error at step ${i + 1}: agent "${step.agent}" not found` }] };
				}
				const resolvedPrompt = step.prompt
					.replace(/\$INPUT/g, input)
					.replace(/\$ORIGINAL/g, original);

				// Mark step running
				stepEntries[i].status = "running";
				stepEntries[i].task = resolvedPrompt.length > 80 ? resolvedPrompt.slice(0, 77) + "..." : resolvedPrompt;
				stepEntries[i].startTime = Date.now();
				stepEntries[i].timer = setInterval(() => {
					stepEntries[i].elapsed = Date.now() - stepEntries[i].startTime!;
					updateWidget();
				}, 1000);
				updateWidget();

				if (onUpdate) onUpdate({ content: [{ type: "text", text: `Step ${i + 1}/${chain.steps.length}: ${displayName(step.agent)}...` }] });

				const result = await spawnAgent(agentDef, resolvedPrompt, context);
				finishTask(stepEntries[i], result.exitCode === 0 ? "done" : "error");

				if (result.exitCode !== 0) {
					// Mark remaining steps as skipped
					for (let j = i + 1; j < stepEntries.length; j++) {
						stepEntries[j].status = "error";
						stepEntries[j].task = "skipped";
						updateWidget();
					}
					return {
						content: [{ type: "text", text: `Chain failed at step ${i + 1} (${step.agent}): ${result.output}` }],
						details: { chain: chain.name, status: "error", elapsed: Date.now() - chainStart },
					};
				}
				input = result.output;
			}

			const elapsed = Date.now() - chainStart;
			const truncated = input.length > 8000 ? input.slice(0, 8000) + "\n\n... [truncated]" : input;
			return {
				content: [{ type: "text", text: `[chain:${chain.name}] done in ${Math.round(elapsed / 1000)}s\n\n${truncated}` }],
				details: { chain: chain.name, status: "done", elapsed, fullOutput: input },
			};
		},
		renderCall(args, theme) {
			const c = (args as any).chain || "?";
			const t = (args as any).task || "";
			return new Text(
				theme.fg("toolTitle", theme.bold("run_chain ")) +
				theme.fg("accent", c) + theme.fg("dim", " — ") +
				theme.fg("muted", t.length > 60 ? t.slice(0, 57) + "..." : t), 0, 0);
		},
		renderResult(result, options, theme) {
			const d = result.details as any;
			if (!d) return new Text(result.content[0]?.type === "text" ? (result.content[0] as any).text : "", 0, 0);
			if (options.isPartial) return new Text(theme.fg("accent", `● chain:${d.chain}`) + theme.fg("dim", " running..."), 0, 0);
			const icon = d.status === "done" ? "✓" : "✗";
			const color = d.status === "done" ? "success" : "error";
			return new Text(theme.fg(color, `${icon} chain:${d.chain}`) + theme.fg("dim", ` ${Math.round((d.elapsed || 0) / 1000)}s`), 0, 0);
		},
	});

	// ── Tool: run_team ──────────────────────────

	pi.registerTool({
		name: "run_team",
		label: "Run Team",
		description: "Dispatch a task to every agent in a named team. All agents run sequentially, each receiving the task plus accumulated context from prior agents.",
		parameters: Type.Object({
			team: Type.String({ description: "Team name from teams.yaml" }),
			task: Type.String({ description: "The task for the team" }),
		}),
		async execute(_id, params, _signal, onUpdate, context) {
			const { team: teamName, task } = params as { team: string; task: string };
			const members = teams[teamName] || teams[Object.keys(teams).find(k => k.toLowerCase() === teamName.toLowerCase()) || ""];
			if (!members) {
				const available = Object.keys(teams).join(", ");
				return { content: [{ type: "text", text: `Team "${teamName}" not found. Available: ${available}` }] };
			}
			if (onUpdate) {
				onUpdate({ content: [{ type: "text", text: `Running team: ${teamName} (${members.map(displayName).join(", ")})...` }] });
			}

			// Add pending tasks for each team member
			const memberEntries: TaskEntry[] = members.map((m, i) => {
				const entry: TaskEntry = {
					id: nextTaskId++,
					label: `${teamName}[${i + 1}] ${m}`,
					task: task.length > 80 ? task.slice(0, 77) + "..." : task,
					status: "pending",
					elapsed: 0,
				};
				taskList.push(entry);
				return entry;
			});
			updateWidget();

			const teamStart = Date.now();
			const results: string[] = [];

			for (let i = 0; i < members.length; i++) {
				const agentDef = allAgents.get(members[i].toLowerCase());
				if (!agentDef) {
					memberEntries[i].status = "error";
					memberEntries[i].task = "agent not found";
					updateWidget();
					results.push(`[${members[i]}] SKIPPED — agent not found`);
					continue;
				}
				const context_so_far = results.length > 0
					? `\n\nPrior team results:\n${results.join("\n\n---\n\n")}`
					: "";
				const fullTask = task + context_so_far;

				// Mark member running
				memberEntries[i].status = "running";
				memberEntries[i].startTime = Date.now();
				memberEntries[i].timer = setInterval(() => {
					memberEntries[i].elapsed = Date.now() - memberEntries[i].startTime!;
					updateWidget();
				}, 1000);
				updateWidget();

				if (onUpdate) onUpdate({ content: [{ type: "text", text: `Team member ${i + 1}/${members.length}: ${displayName(agentDef.name)}...` }] });

				const result = await spawnAgent(agentDef, fullTask, context);
				const status = result.exitCode === 0 ? "done" : "error";
				finishTask(memberEntries[i], status);
				results.push(`[${displayName(agentDef.name)}] ${status} (${Math.round(result.elapsed / 1000)}s)\n${result.output}`);
			}

			const elapsed = Date.now() - teamStart;
			const combined = results.join("\n\n---\n\n");
			const truncated = combined.length > 8000 ? combined.slice(0, 8000) + "\n\n... [truncated]" : combined;
			return {
				content: [{ type: "text", text: `[team:${teamName}] done in ${Math.round(elapsed / 1000)}s\n\n${truncated}` }],
				details: { team: teamName, status: "done", elapsed, fullOutput: combined },
			};
		},
		renderCall(args, theme) {
			const t = (args as any).team || "?";
			const task = (args as any).task || "";
			return new Text(
				theme.fg("toolTitle", theme.bold("run_team ")) +
				theme.fg("accent", t) + theme.fg("dim", " — ") +
				theme.fg("muted", task.length > 60 ? task.slice(0, 57) + "..." : task), 0, 0);
		},
		renderResult(result, options, theme) {
			const d = result.details as any;
			if (!d) return new Text(result.content[0]?.type === "text" ? (result.content[0] as any).text : "", 0, 0);
			if (options.isPartial) return new Text(theme.fg("accent", `● team:${d.team}`) + theme.fg("dim", " running..."), 0, 0);
			const icon = d.status === "done" ? "✓" : "✗";
			const color = d.status === "done" ? "success" : "error";
			return new Text(theme.fg(color, `${icon} team:${d.team}`) + theme.fg("dim", ` ${Math.round((d.elapsed || 0) / 1000)}s`), 0, 0);
		},
	});

	// ── Helpers: draft/plan file management ──────

	function slugify(name: string): string {
		return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
	}

	function saveDraft(name: string, content: string): string {
		const slug = slugify(name);
		const filePath = join(draftsDir, `${slug}.md`);
		writeFileSync(filePath, content, "utf-8");
		return filePath;
	}

	function elevateDraft(slug: string): string | null {
		const draftPath = join(draftsDir, `${slug}.md`);
		if (!existsSync(draftPath)) return null;
		const planPath = join(plansDir, `${slug}.md`);
		renameSync(draftPath, planPath);
		return planPath;
	}

	function listFiles(dir: string): { slug: string; title: string; path: string }[] {
		if (!existsSync(dir)) return [];
		return readdirSync(dir)
			.filter(f => f.endsWith(".md"))
			.map(f => {
				const path = join(dir, f);
				const slug = f.replace(/\.md$/, "");
				const raw = readFileSync(path, "utf-8");
				const titleMatch = raw.match(/^#\s+(?:Plan:\s+)?(.+)$/m);
				const title = titleMatch ? titleMatch[1].trim() : slug;
				return { slug, title, path };
			});
	}

	// ── Tool: plan (orchestrated pipeline) ──────

	pi.registerTool({
		name: "plan",
		label: "Plan",
		description: "Run the full planning pipeline: scout for context → planner for research & questions → ask user questions → plan-draft → plan-reviewer. Saves result as a draft that can be elevated to a plan with /start-work.",
		parameters: Type.Object({
			task: Type.String({ description: "What to plan — the user's request" }),
			name: Type.String({ description: "Short name for this plan (used as filename slug)" }),
		}),
		async execute(_id, params, _signal, onUpdate, context) {
			const { task, name } = params as { task: string; name: string };
			const slug = slugify(name);

			// Step 1: Scout
			const scoutDef = allAgents.get("scout");
			if (!scoutDef) return { content: [{ type: "text", text: "Scout agent not found" }] };
			if (onUpdate) onUpdate({ content: [{ type: "text", text: `[1/4] Scouting codebase for context...` }] });
			const scoutEntry = addTask("scout", `recon: ${name}`);
			const scoutResult = await spawnAgent(scoutDef, `Explore the codebase thoroughly for context related to: ${task}\n\nFind all relevant files, patterns, dependencies, and conventions. Report structured findings.`, context);
			finishTask(scoutEntry, scoutResult.exitCode === 0 ? "done" : "error");
			if (scoutResult.exitCode !== 0) return { content: [{ type: "text", text: `Scout failed: ${scoutResult.output}` }] };

			// Step 2: Planner (research + questions)
			const plannerDef2 = allAgents.get("planner");
			if (!plannerDef2) return { content: [{ type: "text", text: "Planner agent not found" }] };
			if (onUpdate) onUpdate({ content: [{ type: "text", text: `[2/4] Researching and analyzing gaps...` }] });
			const plannerEntry = addTask("planner", `research: ${name}`);

			// Check memory for relevant context
			const memoryPath = join(homedir(), "pi-memories", "hivemind", "memories.jsonl");
			let memoryContext = "";
			if (existsSync(memoryPath)) {
				try {
					const lines = readFileSync(memoryPath, "utf-8").split("\n").filter(l => l.trim());
					const relevant = lines.filter(l => {
						const lower = l.toLowerCase();
						return task.toLowerCase().split(/\s+/).some(word => word.length > 3 && lower.includes(word));
					}).slice(-10);
					if (relevant.length > 0) memoryContext = `\n\nRelevant memory entries:\n${relevant.join("\n")}`;
				} catch {}
			}

			const plannerPrompt = `Research and analyze this request using the codebase findings below. Surface questions and gaps — do NOT write a plan.\n\nOriginal request: ${task}\n\nScout findings:\n${scoutResult.output}${memoryContext}`;
			const plannerResult = await spawnAgent(plannerDef2, plannerPrompt, context);
			finishTask(plannerEntry, plannerResult.exitCode === 0 ? "done" : "error");
			if (plannerResult.exitCode !== 0) return { content: [{ type: "text", text: `Planner failed: ${plannerResult.output}` }] };

			// Step 2.5: Extract questions and ask user
			const researchOutput = plannerResult.output;
			const questionLines = researchOutput.split("\n").filter(l =>
				/^\d+\.\s*\[?(CRITICAL|IMPORTANT|NICE.TO.KNOW)\]?/i.test(l.trim())
			);

			let userAnswers = "";
			if (questionLines.length > 0) {
				if (onUpdate) onUpdate({ content: [{ type: "text", text: `[2.5/4] Questions for you — please answer to improve plan quality` }] });

				// Present each question for user input
				const answers: string[] = [];
				for (const q of questionLines) {
					// Clean the question text
					const cleaned = q.replace(/^\d+\.\s*\[?(CRITICAL|IMPORTANT|NICE.TO.KNOW)\]?\s*/i, "").trim();
					if (!cleaned) continue;

					const options = [
						"Answer this question",
						"Skip — not relevant",
						"Skip — use your best judgment",
					];
					const choice = await context.ui.select(`📋 ${cleaned}`, options);

					if (choice === options[0]) {
						const answer = await context.ui.input(`Answer: ${cleaned}`);
						if (answer) answers.push(`Q: ${cleaned}\nA: ${answer}`);
					} else if (choice === options[2]) {
						answers.push(`Q: ${cleaned}\nA: [Use best judgment based on codebase patterns]`);
					}
					// Skip — not relevant: just don't add it
				}
				if (answers.length > 0) userAnswers = `\n\nUser answers to clarifying questions:\n${answers.join("\n\n")}`;
			}

			// Step 3: Plan Draft
			const draftDef = allAgents.get("plan-draft");
			if (!draftDef) return { content: [{ type: "text", text: "Plan-draft agent not found" }] };
			if (onUpdate) onUpdate({ content: [{ type: "text", text: `[3/4] Drafting plan...` }] });
			const draftEntry = addTask("plan-draft", `draft: ${name}`);

			const draftPrompt = `Draft a structured implementation plan using all gathered context.\n\nOriginal request: ${task}\n\nResearch context and gap analysis:\n${researchOutput}${userAnswers}`;
			const draftResult = await spawnAgent(draftDef, draftPrompt, context);
			finishTask(draftEntry, draftResult.exitCode === 0 ? "done" : "error");
			if (draftResult.exitCode !== 0) return { content: [{ type: "text", text: `Plan draft failed: ${draftResult.output}` }] };

			// Step 4: Plan Review
			const reviewDef = allAgents.get("plan-reviewer");
			if (!reviewDef) return { content: [{ type: "text", text: "Plan-reviewer agent not found" }] };
			if (onUpdate) onUpdate({ content: [{ type: "text", text: `[4/4] Reviewing plan for gaps...` }] });
			const reviewEntry = addTask("plan-reviewer", `review: ${name}`);

			const reviewPrompt = `Review this plan for gaps, ambiguities, and missing acceptance criteria:\n\n${draftResult.output}\n\nOriginal request: ${task}`;
			const reviewResult = await spawnAgent(reviewDef, reviewPrompt, context);
			finishTask(reviewEntry, reviewResult.exitCode === 0 ? "done" : "error");

			// If reviewer says NEEDS REVISION, feed back to draft agent
			let finalPlan = draftResult.output;
			if (reviewResult.exitCode === 0 && /NEEDS REVISION/i.test(reviewResult.output)) {
				if (onUpdate) onUpdate({ content: [{ type: "text", text: `[4b/4] Revising plan based on review...` }] });
				const reviseEntry = addTask("plan-draft", `revise: ${name}`);
				const revisePrompt = `Revise this implementation plan to address all issues found in the review.\n\nOriginal request: ${task}\n\nCurrent plan:\n${draftResult.output}\n\nReview feedback:\n${reviewResult.output}${userAnswers}`;
				const reviseResult = await spawnAgent(draftDef, revisePrompt, context);
				finishTask(reviseEntry, reviseResult.exitCode === 0 ? "done" : "error");
				if (reviseResult.exitCode === 0) finalPlan = reviseResult.output;
			}

			// Save as draft
			const draftPath = saveDraft(name, finalPlan);

			const summary = [
				`Draft saved: \`${draftPath}\``,
				"",
				reviewResult.exitCode === 0 ? reviewResult.output : "(review unavailable)",
				"",
				`Use \`/plans approve ${slug}\` to elevate to a plan, then \`/start-work ${slug}\` to execute.`,
				`Use \`/drafts\` to list all drafts.`,
			].join("\n");

			return {
				content: [{ type: "text", text: `[plan:${slug}] draft complete\n\n${summary}` }],
				details: { name: slug, draftPath, status: "draft", plan: finalPlan, review: reviewResult.output },
			};
		},
		renderCall(args, theme) {
			const n = (args as any).name || "?";
			const t = (args as any).task || "";
			return new Text(
				theme.fg("toolTitle", theme.bold("plan ")) +
				theme.fg("accent", n) + theme.fg("dim", " — ") +
				theme.fg("muted", t.length > 60 ? t.slice(0, 57) + "..." : t), 0, 0);
		},
		renderResult(result, options, theme) {
			const d = result.details as any;
			if (!d) return new Text(result.content[0]?.type === "text" ? (result.content[0] as any).text : "", 0, 0);
			if (options.isPartial) return new Text(theme.fg("accent", `● plan:${d.name}`) + theme.fg("dim", " pipeline running..."), 0, 0);
			const icon = d.status === "draft" ? "📋" : "✓";
			return new Text(theme.fg("success", `${icon} plan:${d.name}`) + theme.fg("dim", ` → ${d.draftPath}`), 0, 0);
		},
	});

	// ── Command: /drafts ─────────────────────────

	pi.registerCommand("drafts", {
		description: "List drafts: /drafts — or /drafts view <name> — or /drafts delete <name>",
		handler: async (args, context) => {
			ctx = context;
			const parts = args.trim().split(/\s+/);
			const action = parts[0]?.toLowerCase();
			const target = parts.slice(1).join(" ");

			if (action === "view" && target) {
				const slug = slugify(target);
				const path = join(draftsDir, `${slug}.md`);
				if (!existsSync(path)) { context.ui.notify(`Draft "${slug}" not found`, "error"); return; }
				const content = readFileSync(path, "utf-8");
				context.ui.notify(`Draft: ${slug}\n\n${content.slice(0, 2000)}${content.length > 2000 ? "\n... [truncated]" : ""}`, "info");
				return;
			}

			if (action === "delete" && target) {
				const slug = slugify(target);
				const path = join(draftsDir, `${slug}.md`);
				if (!existsSync(path)) { context.ui.notify(`Draft "${slug}" not found`, "error"); return; }
				unlinkSync(path);
				context.ui.notify(`Deleted draft: ${slug}`, "info");
				return;
			}

			const drafts = listFiles(draftsDir);
			if (drafts.length === 0) {
				context.ui.notify("No drafts. Use the plan tool in orchestrator mode to create one.", "info");
				return;
			}
			const lines = drafts.map(d => `  📋 ${d.slug} — ${d.title}`);
			context.ui.notify(`Drafts (${drafts.length}):\n${lines.join("\n")}\n\nUse /plans approve <name> to elevate, or /drafts view <name> to read.`, "info");
		},
	});

	// ── Command: /plans ──────────────────────────

	pi.registerCommand("plans", {
		description: "List plans: /plans — or /plans approve <draft> — or /plans view <name> — or /plans delete <name>",
		handler: async (args, context) => {
			ctx = context;
			const parts = args.trim().split(/\s+/);
			const action = parts[0]?.toLowerCase();
			const target = parts.slice(1).join(" ");

			if (action === "approve" && target) {
				const slug = slugify(target);
				const result = elevateDraft(slug);
				if (!result) { context.ui.notify(`Draft "${slug}" not found`, "error"); return; }
				context.ui.notify(`Elevated to plan: ${result}\nUse /start-work ${slug} to execute.`, "success");
				return;
			}

			if (action === "view" && target) {
				const slug = slugify(target);
				const path = join(plansDir, `${slug}.md`);
				if (!existsSync(path)) { context.ui.notify(`Plan "${slug}" not found`, "error"); return; }
				const content = readFileSync(path, "utf-8");
				context.ui.notify(`Plan: ${slug}\n\n${content.slice(0, 2000)}${content.length > 2000 ? "\n... [truncated]" : ""}`, "info");
				return;
			}

			if (action === "delete" && target) {
				const slug = slugify(target);
				const path = join(plansDir, `${slug}.md`);
				if (!existsSync(path)) { context.ui.notify(`Plan "${slug}" not found`, "error"); return; }
				unlinkSync(path);
				context.ui.notify(`Deleted plan: ${slug}`, "info");
				return;
			}

			const plans = listFiles(plansDir);
			if (plans.length === 0) {
				context.ui.notify("No approved plans. Use /plans approve <draft-name> to elevate a draft.", "info");
				return;
			}
			const lines = plans.map(p => `  ✅ ${p.slug} — ${p.title}`);
			context.ui.notify(`Plans (${plans.length}):\n${lines.join("\n")}\n\nUse /start-work <name> to execute.`, "info");
		},
	});

	// ── Command: /start-work ─────────────────────

	pi.registerCommand("start-work", {
		description: "Execute an approved plan: /start-work <plan-name>",
		handler: async (args, context) => {
			ctx = context;
			const arg = args.trim();

			if (!arg) {
				// Show plan picker
				const plans = listFiles(plansDir);
				const drafts = listFiles(draftsDir);

				if (plans.length === 0 && drafts.length === 0) {
					context.ui.notify("No plans or drafts found. Use the plan tool to create one.", "info");
					return;
				}

				const options: string[] = [];
				const planOptions = plans.map(p => `✅ [plan] ${p.slug} — ${p.title}`);
				const draftOptions = drafts.map(d => `📋 [draft] ${d.slug} — ${d.title}`);
				options.push(...planOptions, ...draftOptions);

				const choice = await context.ui.select("Select a plan to execute", options);
				if (!choice) return;

				const isFromDraft = choice.startsWith("📋");
				const slugMatch = choice.match(/\]\s+(\S+)\s+—/);
				if (!slugMatch) return;
				const selectedSlug = slugMatch[1];

				if (isFromDraft) {
					const approve = await context.ui.select(
						`"${selectedSlug}" is still a draft. Approve and start?`,
						["Yes — approve and start", "No — cancel"],
					);
					if (approve !== "Yes — approve and start") return;
					elevateDraft(selectedSlug);
					context.ui.notify(`Approved: ${selectedSlug}`, "success");
				}

				return await executeStartWork(selectedSlug, context);
			}

			const slug = slugify(arg);

			// Check plans first, then drafts
			const planPath = join(plansDir, `${slug}.md`);
			const draftPath = join(draftsDir, `${slug}.md`);

			if (existsSync(planPath)) {
				return await executeStartWork(slug, context);
			}

			if (existsSync(draftPath)) {
				const approve = await context.ui.select(
					`"${slug}" is still a draft. Approve and start?`,
					["Yes — approve and start", "No — cancel"],
				);
				if (approve !== "Yes — approve and start") return;
				elevateDraft(slug);
				context.ui.notify(`Approved: ${slug}`, "success");
				return await executeStartWork(slug, context);
			}

			context.ui.notify(`Plan "${slug}" not found. Use /plans to list available plans.`, "error");
		},
	});

	async function executeStartWork(slug: string, context: ExtensionContext) {
		const planPath = join(plansDir, `${slug}.md`);
		if (!existsSync(planPath)) {
			context.ui.notify(`Plan file not found: ${planPath}`, "error");
			return;
		}
		const planContent = readFileSync(planPath, "utf-8");

		// Switch to orchestrator mode for execution
		if (currentMode !== "orchestrator") {
			currentMode = "orchestrator";
			applyMode(context);
			context.ui.notify("Switched to orchestrator mode for execution", "info");
		}

		// Dispatch to atlas if available, otherwise builder
		const executor = allAgents.get("atlas") || allAgents.get("builder");
		if (!executor) {
			context.ui.notify("No executor agent (atlas or builder) found", "error");
			return;
		}

		context.ui.notify(`Starting work: ${slug}\nExecutor: ${executor.name}\n\nThe orchestrator will execute the plan.`, "info");

		// Inject the plan into the conversation as a system message
		const entry = addTask(executor.name, `execute: ${slug}`);
		const result = await spawnAgent(
			executor,
			`Execute this implementation plan. Follow the wave structure — complete Wave 1 before starting Wave 2. Mark tasks complete as you go.\n\n${planContent}`,
			context,
		);
		finishTask(entry, result.exitCode === 0 ? "done" : "error");

		const truncated = result.output.length > 4000 ? result.output.slice(0, 4000) + "\n... [truncated]" : result.output;
		context.ui.notify(`[${executor.name}] ${result.exitCode === 0 ? "done" : "error"}\n\n${truncated}`, result.exitCode === 0 ? "success" : "error");
	}

	// ── Footer ───────────────────────────────────

	function updateFooter(context: ExtensionContext) {
		context.ui.setFooter((_tui, theme, _footerData) => ({
			dispose: () => {},
			invalidate() {},
			render(width: number): string[] {
				const modeIcon = currentMode === "planner" ? "P" : "O";
				const modeColor = currentMode === "planner" ? "accent" : "warning";
				const modeStr = theme.fg(modeColor, theme.bold(` [${modeIcon}]`)) +
					theme.fg("muted", ` ${currentMode}`);
				const modeVisible = 4 + 1 + currentMode.length;

				const modelId = context.model?.id || "no-model";
				const shortModel = modelId.length > 30 ? modelId.slice(0, 27) + "..." : modelId;
				const modelStr = theme.fg("dim", shortModel);
				const modelVisible = shortModel.length;

				const usage = context.getContextUsage();
				const pct = (usage && usage.percent !== null) ? usage.percent : 0;
				const filled = Math.round(pct / 10);
				const barColor = pct > 80 ? "error" : pct > 60 ? "warning" : "dim";
				const bar = "#".repeat(filled) + "-".repeat(10 - filled);
				const ctxStr = theme.fg(barColor, `[${bar}]`) + theme.fg("dim", ` ${Math.round(pct)}%`);
				const ctxVisible = 12 + 1 + `${Math.round(pct)}%`.length;

				const hints = theme.fg("dim", "F1 mode  ^L model ");
				const hintsVisible = 18;

				const leftStr = modeStr + theme.fg("dim", "  ") + modelStr;
				const leftVisible = modeVisible + 2 + modelVisible;
				const rightStr = ctxStr + theme.fg("dim", "  ") + hints;
				const rightVisible = ctxVisible + 2 + hintsVisible;

				const pad = " ".repeat(Math.max(1, width - leftVisible - rightVisible));
				return [truncateToWidth(leftStr + pad + rightStr, width)];
			},
		}));
	}

	// ── System prompt injection ──────────────────

	pi.on("before_agent_start", async (event, _ctx) => {
		const def = getActiveDef();
		if (!def) return;

		if (currentMode === "orchestrator") {
			// Build catalog of available agents, teams, and chains for the orchestrator
			const agentCatalog = Array.from(allAgents.values())
				.map(a => `- **${a.name}**: ${a.description} [tools: ${a.tools}]`)
				.join("\n");

			const teamCatalog = Object.entries(teams)
				.map(([name, members]) => `- **${name}**: ${members.map(displayName).join(", ")}`)
				.join("\n");

			const chainCatalog = chains
				.map(c => {
					const flow = c.steps.map(s => displayName(s.agent)).join(" → ");
					return `- **${c.name}**: ${c.description} (${flow})`;
				})
				.join("\n");

			return {
				systemPrompt: `${def.systemPrompt}

## Available Tools

You have three dispatch tools. Choose the right one for the job:

### dispatch_agent
Send a task to a **single specialist agent**. Use when you need one agent's expertise.

### run_chain
Execute a **sequential pipeline** from agent-chain.yaml. Each step's output feeds into the next. Use for structured multi-step workflows.

### run_team
Run **every agent in a team** sequentially, each getting the task plus accumulated context. Use when you need multiple perspectives on the same problem.

## Available Agents
${agentCatalog}

## Available Teams
${teamCatalog}

## Available Chains
${chainCatalog}

## Guidelines
- Break complex tasks into dispatch_agent calls to individual specialists
- Use run_chain for well-defined workflows (plan → build → review)
- Use run_team when you need a team's combined expertise
- Chain agents: scout first to explore, then builder to implement
- Review all results before reporting back to the user

${event.systemPrompt}`,
			};
		}

		// Planner mode: prepend agent prompt
		return {
			systemPrompt: def.systemPrompt + "\n\n" + event.systemPrompt,
		};
	});

	// ── Shortcuts ────────────────────────────────

	pi.registerShortcut("f1", {
		description: "Toggle Planner / Orchestrator",
		handler: async (context) => { ctx = context; toggleMode(context); },
	});

	// Model switching: use Pi's built-in Ctrl+L (select) or Ctrl+P (cycle)
	// Custom setModel breaks OAuth — Pi must manage its own model/auth state

	// ── Commands ─────────────────────────────────

	pi.registerCommand("mode", {
		description: "Toggle or set mode: /mode [planner|orchestrator]",
		handler: async (args, context) => {
			ctx = context;
			const arg = args.trim().toLowerCase();
			if (arg === "planner" || arg === "orchestrator") { currentMode = arg; applyMode(context); }
			else toggleMode(context);
		},
	});

	pi.registerCommand("switch-model", {
		description: "Switch model: /switch-model or /switch-model <model-id>",
		handler: async (args, context) => {
			ctx = context;
			const arg = args.trim();
			if (arg) {
				try {
					pi.setModel(arg);
					updateFooter(context);
					context.ui.notify(`Model: ${arg}`, "success");
				} catch (err: any) { context.ui.notify(`Failed: ${err?.message || err}`, "error"); }
				return;
			}
			const options = MODEL_PRESETS.map(m => {
				const active = (context.model?.id === m.id) ? " (active)" : "";
				return `${m.label}${active} — ${m.id}`;
			});
			const choice = await context.ui.select("Select Model", options);
			if (choice === undefined) return;
			const idx = options.indexOf(choice);
			const preset = MODEL_PRESETS[idx];
			try {
				pi.setModel(preset.id);
				updateFooter(context);
				context.ui.notify(`Model: ${preset.label}`, "success");
			} catch (err: any) { context.ui.notify(`Failed: ${err?.message || err}`, "error"); }
		},
	});

	pi.registerCommand("tasks", {
		description: "Task tracker: /tasks [clear]",
		handler: async (args, context) => {
			ctx = context;
			const arg = args.trim().toLowerCase();
			if (arg === "clear") {
				// Stop all timers
				for (const t of taskList) { if (t.timer) clearInterval(t.timer); }
				taskList.length = 0;
				nextTaskId = 1;
				context.ui.setWidget("task-tracker", undefined);
				context.ui.notify("Task list cleared", "info");
				return;
			}
			if (taskList.length === 0) {
				context.ui.notify("No tasks tracked yet. Switch to orchestrator mode and dispatch agents.", "info");
				return;
			}
			const done = taskList.filter(t => t.status === "done").length;
			const running = taskList.filter(t => t.status === "running").length;
			const pending = taskList.filter(t => t.status === "pending").length;
			const errors = taskList.filter(t => t.status === "error").length;
			const lines = [
				`Tasks: ${taskList.length} total — ${done} done, ${running} running, ${pending} pending, ${errors} errors`,
				"",
				...taskList.map(t => {
					const icon = t.status === "pending" ? "○" : t.status === "running" ? "●" : t.status === "done" ? "✓" : "✗";
					const time = t.elapsed > 0 ? ` (${Math.round(t.elapsed / 1000)}s)` : "";
					return `  ${icon} ${t.label} — ${t.task}${time}`;
				}),
			];
			context.ui.notify(lines.join("\n"), "info");
		},
	});

	// ── Session start ────────────────────────────

	pi.on("session_start", async (_event, context) => {
		ctx = context;
		applyExtensionDefaults(import.meta.url, context);

		// Session dir for agent subprocess sessions
		sessionDir = join(context.cwd, ".pi", "agent-sessions");
		if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });

		// Wipe old sessions so subagents start fresh
		if (existsSync(sessionDir)) {
			for (const f of readdirSync(sessionDir)) {
				if (f.endsWith(".json")) { try { unlinkSync(join(sessionDir, f)); } catch {} }
			}
		}

		// Load all agents, teams, chains
		allAgents = scanAgentDirs(context.cwd);
		plannerDef = allAgents.get("planner") || null;
		orchestratorDef = allAgents.get("orchestrator") || null;

		const localTeamsPath = join(context.cwd, ".pi", "agents", "teams.yaml");
		const globalTeamsPath = join(homedir(), ".pi", "agent", "agents", "teams.yaml");
		const teamsPath = existsSync(localTeamsPath) ? localTeamsPath : globalTeamsPath;
		if (existsSync(teamsPath)) {
			try { teams = parseTeamsYaml(readFileSync(teamsPath, "utf-8")); } catch { teams = {}; }
		}

		const localChainPath = join(context.cwd, ".pi", "agents", "agent-chain.yaml");
		const globalChainPath = join(homedir(), ".pi", "agent", "agents", "agent-chain.yaml");
		const chainPath = existsSync(localChainPath) ? localChainPath : globalChainPath;
		if (existsSync(chainPath)) {
			try { chains = parseChainYaml(readFileSync(chainPath, "utf-8")); } catch { chains = []; }
		}

		// Init agent sessions map
		agentSessions.clear();
		for (const [key] of allAgents) agentSessions.set(key, null);

		// Capture default tools before restricting
		defaultTools = pi.getActiveTools();

		// Apply initial mode (planner)
		applyMode(context);

		const agentCount = allAgents.size;
		const teamCount = Object.keys(teams).length;
		const chainCount = chains.length;
		context.ui.notify(
			`Command Deck\n` +
			`  ${agentCount} agents  ${teamCount} teams  ${chainCount} chains\n` +
			`  F1  toggle mode   |  Ctrl+L  switch model (built-in)\n` +
			`  /mode   /tasks`,
			"info",
		);
	});
}
