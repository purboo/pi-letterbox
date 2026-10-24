// A local capture server that speaks the Anthropic Messages API as pi-ai consumes it, records every request and plays
// scripted responses. Adapted from pi-aside's test harness (same author, MIT).

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface Captured {
	seq: number;
	at: number;
	method: string;
	path: string;
	headers: Record<string, string>;
	raw: string;
	body: Record<string, unknown>;
	defaulted: boolean;
}

export interface ScriptedToolCall {
	id?: string;
	name: string;
	arguments: Record<string, unknown>;
}

export interface Scripted {
	text?: string;
	toolCalls?: ScriptedToolCall[];
	usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
	/** Number of text chunks and the delay between them. */
	chunks?: number;
	delayMs?: number;
	/** HTTP error status with a body. */
	status?: number;
	errorBody?: unknown;
	/** Send the 2xx headers, then hold the body until this resolves. */
	hold?: Promise<void>;
	/** Anthropic: a thinking block streamed before the text. */
	thinking?: string;
	/** Anthropic: hold between the thinking block and the text until this resolves. */
	holdText?: Promise<void>;
	/** Called when the request arrives, before the response. */
	onRequest?: (request: Captured) => void;
}

type Responder = (request: Captured) => Scripted | undefined;

export interface CaptureServer {
	url: string;
	requests: Captured[];
	/** Queue responses, used in order. */
	enqueue(...responses: Scripted[]): void;
	/** A function consulted before the queue. */
	respond(responder: Responder | undefined): void;
	waitForRequests(n: number, timeoutMs?: number): Promise<Captured[]>;
	close(): Promise<void>;
}

function sseEvent(res: ServerResponse, event: string | undefined, data: unknown): void {
	if (event) res.write(`event: ${event}\n`);
	res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function chunksOf(text: string, n: number): string[] {
	if (n <= 1 || text.length === 0) return [text];
	const size = Math.ceil(text.length / n);
	const out: string[] = [];
	for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
	return out;
}

async function anthropic(res: ServerResponse, s: Scripted, model: string): Promise<void> {
	const u = s.usage ?? {};
	sseEvent(res, "message_start", {
		type: "message_start",
		message: {
			id: "msg_test",
			type: "message",
			role: "assistant",
			content: [],
			model,
			stop_reason: null,
			stop_sequence: null,
			usage: {
				input_tokens: u.input ?? 10,
				output_tokens: 1,
				cache_read_input_tokens: u.cacheRead ?? 0,
				cache_creation_input_tokens: u.cacheWrite ?? 0,
			},
		},
	});
	let index = 0;
	if (s.thinking) {
		sseEvent(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } });
		for (const piece of chunksOf(s.thinking, s.chunks ?? 1)) {
			sseEvent(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: piece } });
			if (s.delayMs) await sleep(s.delayMs);
		}
		sseEvent(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature: "sig" } });
		sseEvent(res, "content_block_stop", { type: "content_block_stop", index });
		index++;
	}
	if (s.holdText) await s.holdText;
	if (s.text !== undefined && s.text !== "") {
		sseEvent(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
		for (const piece of chunksOf(s.text, s.chunks ?? 1)) {
			sseEvent(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: piece } });
			if (s.delayMs) await sleep(s.delayMs);
		}
		sseEvent(res, "content_block_stop", { type: "content_block_stop", index });
		index++;
	}
	for (const call of s.toolCalls ?? []) {
		sseEvent(res, "content_block_start", {
			type: "content_block_start",
			index,
			content_block: { type: "tool_use", id: call.id ?? `toolu_${index}`, name: call.name, input: {} },
		});
		sseEvent(res, "content_block_delta", {
			type: "content_block_delta",
			index,
			delta: { type: "input_json_delta", partial_json: JSON.stringify(call.arguments) },
		});
		sseEvent(res, "content_block_stop", { type: "content_block_stop", index });
		index++;
	}
	sseEvent(res, "message_delta", {
		type: "message_delta",
		delta: { stop_reason: s.toolCalls?.length ? "tool_use" : "end_turn", stop_sequence: null },
		usage: { output_tokens: u.output ?? 5 },
	});
	sseEvent(res, "message_stop", { type: "message_stop" });
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const parts: Buffer[] = [];
		req.on("data", (c: Buffer) => parts.push(c));
		req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
		req.on("error", reject);
	});
}

export async function startCaptureServer(): Promise<CaptureServer> {
	const requests: Captured[] = [];
	const queue: Scripted[] = [];
	let responder: Responder | undefined;
	const waiters: Array<() => void> = [];
	let seq = 0;

	const server = createServer(async (req, res) => {
		const raw = await readBody(req);
		let body: Record<string, unknown> = {};
		try {
			body = raw ? JSON.parse(raw) : {};
		} catch {
			body = {};
		}
		const headers: Record<string, string> = {};
		for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v ?? "");
		const record: Captured = {
			seq: ++seq,
			at: Date.now(),
			method: req.method ?? "",
			path: (req.url ?? "").split("?")[0]!,
			headers,
			raw,
			body,
			defaulted: false,
		};
		let script = responder?.(record);
		if (!script) script = queue.shift();
		if (!script) {
			record.defaulted = true;
			script = { text: "default reply" };
		}
		requests.push(record);
		for (const w of waiters.splice(0)) w();
		script.onRequest?.(record);
		const model = String(body.model ?? "test-model");
		try {
			if (script.status && script.status >= 400) {
				res.writeHead(script.status, { "content-type": "application/json" });
				res.end(JSON.stringify(script.errorBody ?? { error: { type: "error", message: "scripted error" } }));
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			res.flushHeaders?.();
			if (script.hold) await script.hold;
			await anthropic(res, script, model);
			res.end();
		} catch {
			res.destroy();
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;

	return {
		url: `http://127.0.0.1:${port}`,
		requests,
		enqueue: (...r) => queue.push(...r),
		respond: (r) => {
			responder = r;
		},
		async waitForRequests(n, timeoutMs = 15_000) {
			const deadline = Date.now() + timeoutMs;
			while (requests.length < n) {
				const left = deadline - Date.now();
				if (left <= 0) throw new Error(`timed out waiting for ${n} requests (have ${requests.length})`);
				await new Promise<void>((resolve) => {
					const t = setTimeout(resolve, Math.min(left, 200));
					waiters.push(() => {
						clearTimeout(t);
						resolve();
					});
				});
			}
			return requests.slice(0, n);
		},
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections?.();
				server.close(() => resolve());
			}),
	};
}
