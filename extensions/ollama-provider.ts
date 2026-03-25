/**
 * Ollama Provider — Local model management for Pi agent
 *
 * Auto-detects Ollama on session start and provides /ollama commands
 * for managing local models.
 *
 * Commands:
 *   /ollama status     — Check Ollama connectivity and running models
 *   /ollama models     — List locally available models
 *   /ollama pull <m>   — Pull a new model
 *   /ollama use <m>    — Switch Pi to an Ollama model
 *
 * Usage: pi -e extensions/ollama-provider.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL || "http://localhost:11434";

interface OllamaModel {
	name: string;
	size: number;
	modified_at: string;
	digest: string;
}

interface OllamaRunningModel {
	name: string;
	size: number;
	size_vram: number;
}

async function ollamaFetch<T>(path: string, options?: RequestInit): Promise<T | null> {
	try {
		const res = await fetch(`${OLLAMA_BASE}${path}`, {
			...options,
			headers: { "Content-Type": "application/json", ...options?.headers },
		});
		if (!res.ok) return null;
		return (await res.json()) as T;
	} catch {
		return null;
	}
}

function formatSize(bytes: number): string {
	if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
	if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
	return `${bytes} B`;
}

async function listModels(): Promise<OllamaModel[]> {
	const data = await ollamaFetch<{ models: OllamaModel[] }>("/api/tags");
	return data?.models || [];
}

async function listRunning(): Promise<OllamaRunningModel[]> {
	const data = await ollamaFetch<{ models: OllamaRunningModel[] }>("/api/ps");
	return data?.models || [];
}

async function isOllamaUp(): Promise<boolean> {
	try {
		const res = await fetch(`${OLLAMA_BASE}/api/tags`);
		return res.ok;
	} catch {
		return false;
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const up = await isOllamaUp();
		if (up && ctx.ui) {
			const models = await listModels();
			ctx.ui.notify(`Ollama: ${models.length} model${models.length !== 1 ? "s" : ""} available locally`);
		}
	});

	pi.registerCommand("ollama", {
		description:
			"Local models: /ollama status | models | pull <name> | use <name>",
		handler: async (args: string, ctx) => {
			const parts = args.trim().split(/\s+/);
			const sub = parts[0]?.toLowerCase();
			const rest = parts.slice(1).join(" ");

			if (!sub || sub === "help") {
				return [
					"Ollama Commands:",
					`  /ollama status       — Check connectivity (${OLLAMA_BASE})`,
					"  /ollama models       — List local models with sizes",
					"  /ollama pull <name>  — Pull a model (e.g., llama3.2:3b)",
					"  /ollama use <name>   — Switch Pi to use an Ollama model",
				].join("\n");
			}

			if (sub === "status") {
				const up = await isOllamaUp();
				if (!up) return `✗ Ollama not reachable at ${OLLAMA_BASE}`;

				const models = await listModels();
				const running = await listRunning();
				const lines = [
					`✓ Ollama running at ${OLLAMA_BASE}`,
					`  Models: ${models.length} available`,
				];
				if (running.length > 0) {
					lines.push(`  Loaded: ${running.map((m) => m.name).join(", ")}`);
				}
				return lines.join("\n");
			}

			if (sub === "models") {
				const models = await listModels();
				if (models.length === 0) return "No models pulled. Use /ollama pull <name> to get started.";
				const lines = models.map(
					(m) => `  ${m.name.padEnd(30)} ${formatSize(m.size).padStart(8)}`
				);
				return `Local Ollama models:\n${lines.join("\n")}`;
			}

			if (sub === "pull") {
				if (!rest) return "Usage: /ollama pull <model-name> (e.g., llama3.2:3b)";
				const up = await isOllamaUp();
				if (!up) return `✗ Ollama not reachable at ${OLLAMA_BASE}`;

				try {
					const res = await fetch(`${OLLAMA_BASE}/api/pull`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ name: rest, stream: false }),
					});
					if (!res.ok) {
						const text = await res.text();
						return `✗ Pull failed: ${text}`;
					}
					return `✓ Pulled ${rest}`;
				} catch (err) {
					return `✗ Pull failed: ${err}`;
				}
			}

			if (sub === "use") {
				if (!rest) return "Usage: /ollama use <model-name> (e.g., llama3.2:3b)";
				const models = await listModels();
				const match = models.find(
					(m) => m.name === rest || m.name.startsWith(rest + ":")
				);
				if (!match) {
					const available = models.map((m) => m.name).join(", ");
					return `✗ Model "${rest}" not found locally.\n  Available: ${available || "none — pull a model first"}`;
				}
				try {
					pi.setModel({ provider: "ollama", id: match.name });
					return `✓ Switched to ollama/${match.name}`;
				} catch (err) {
					return `✗ Failed to switch model: ${err}`;
				}
			}

			return `Unknown subcommand: ${sub}. Try /ollama help`;
		},
	});
}
