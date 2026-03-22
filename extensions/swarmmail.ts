/**
 * SwarmMail — Cross-agent message store for swarm coordination
 *
 * Provides a simple JSONL-backed message bus for swarm agents to communicate.
 * Messages are stored in ~/Documents/GitHub/pi-memories/swarmmail/
 *
 * Commands:
 *   /mail send <to> <message>    — Send a message to an agent/coordinator
 *   /mail inbox                  — Show unread messages
 *   /mail read <id>              — Read a specific message
 *   /mail ack <id>               — Mark message as acknowledged
 *   /mail clear                  — Clear all messages (after review)
 *
 * Usage: pi -e extensions/swarmmail.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	existsSync,
	readFileSync,
	writeFileSync,
	appendFileSync,
	mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const MAIL_DIR = join(homedir(), "Documents", "GitHub", "pi-memories", "swarmmail");
const MAIL_FILE = join(MAIL_DIR, "messages.jsonl");

interface MailMessage {
	id: number;
	from: string;
	to: string;
	subject: string;
	body: string;
	timestamp: string;
	acked: boolean;
}

function ensureDir(): void {
	if (!existsSync(MAIL_DIR)) {
		mkdirSync(MAIL_DIR, { recursive: true });
	}
	if (!existsSync(MAIL_FILE)) {
		writeFileSync(MAIL_FILE, "");
	}
}

function loadMessages(): MailMessage[] {
	ensureDir();
	const raw = readFileSync(MAIL_FILE, "utf8");
	const messages: MailMessage[] = [];
	for (const line of raw.split("\n").filter((l) => l.trim())) {
		try {
			messages.push(JSON.parse(line) as MailMessage);
		} catch {
			// skip malformed
		}
	}
	return messages;
}

function saveMessages(messages: MailMessage[]): void {
	ensureDir();
	writeFileSync(MAIL_FILE, messages.map((m) => JSON.stringify(m)).join("\n") + (messages.length > 0 ? "\n" : ""));
}

function nextId(messages: MailMessage[]): number {
	return messages.length > 0 ? Math.max(...messages.map((m) => m.id)) + 1 : 1;
}

function formatMessage(m: MailMessage): string {
	const ackBadge = m.acked ? "[acked]" : "[unread]";
	return `#${m.id} ${ackBadge} from:${m.from} → to:${m.to} (${m.timestamp})\n  ${m.body}`;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand({
		name: "mail",
		description: "SwarmMail: /mail inbox | send <to> <message> | read <id> | ack <id> | clear",
		handler: async (args: string, ctx) => {
			const parts = args.trim().split(/\s+/);
			const subcommand = parts[0]?.toLowerCase();
			const rest = parts.slice(1).join(" ");

			const agentName = ctx.cwd ? ctx.cwd.split(/[/\\]/).pop() || "agent" : "agent";

			if (!subcommand || subcommand === "help") {
				return [
					"SwarmMail Commands:",
					"  /mail inbox              — Show unread messages",
					"  /mail send <to> <msg>    — Send a message",
					"  /mail read <id>          — Read message by ID",
					"  /mail ack <id>           — Mark message as acknowledged",
					"  /mail clear              — Clear all acknowledged messages",
					"  /mail all                — Show all messages (including acked)",
				].join("\n");
			}

			if (subcommand === "inbox") {
				const messages = loadMessages();
				const unread = messages.filter((m) => !m.acked);
				if (unread.length === 0) return "✓ Inbox empty — no unread messages";
				return `${unread.length} unread message(s):\n\n${unread.map(formatMessage).join("\n\n")}`;
			}

			if (subcommand === "all") {
				const messages = loadMessages();
				if (messages.length === 0) return "No messages stored.";
				return `All messages (${messages.length}):\n\n${messages.map(formatMessage).join("\n\n")}`;
			}

			if (subcommand === "send") {
				// /mail send <to> <message>
				const sendParts = rest.split(/\s+/);
				const to = sendParts[0];
				const body = sendParts.slice(1).join(" ");
				if (!to || !body) return "Usage: /mail send <to> <message>";

				const messages = loadMessages();
				const msg: MailMessage = {
					id: nextId(messages),
					from: agentName,
					to,
					subject: body.slice(0, 50),
					body,
					timestamp: new Date().toISOString(),
					acked: false,
				};
				appendFileSync(MAIL_FILE, JSON.stringify(msg) + "\n");
				return `✓ Message #${msg.id} sent to ${to}`;
			}

			if (subcommand === "read") {
				const id = parseInt(rest, 10);
				if (isNaN(id)) return "Usage: /mail read <id>";
				const messages = loadMessages();
				const msg = messages.find((m) => m.id === id);
				if (!msg) return `Message #${id} not found`;
				return formatMessage(msg);
			}

			if (subcommand === "ack") {
				const id = parseInt(rest, 10);
				if (isNaN(id)) return "Usage: /mail ack <id>";
				const messages = loadMessages();
				const idx = messages.findIndex((m) => m.id === id);
				if (idx === -1) return `Message #${id} not found`;
				messages[idx].acked = true;
				saveMessages(messages);
				return `✓ Message #${id} acknowledged`;
			}

			if (subcommand === "clear") {
				const messages = loadMessages();
				const remaining = messages.filter((m) => !m.acked);
				const removed = messages.length - remaining.length;
				saveMessages(remaining);
				return `✓ Cleared ${removed} acknowledged message(s). ${remaining.length} unread remaining.`;
			}

			return `Unknown subcommand: ${subcommand}. Try /mail help`;
		},
	});
}
