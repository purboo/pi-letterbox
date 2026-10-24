// Offline integration: real pi in RPC mode with pi-letterbox loaded, a capture server standing in for the model.
// The scripted model calls letterbox_done for any letter it sees, so receipts run end to end.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as lb from "../lib/letterbox.mjs";
import { type Captured, type CaptureServer, startCaptureServer } from "./harness/capture.ts";
import { type PiRpc, scratch, startPi } from "./harness/pi.ts";

const CLI = join(resolve(import.meta.dir, ".."), "bin/pi-letterbox.mjs");

let server: CaptureServer | undefined;
const pis: PiRpc[] = [];
const roots: string[] = [];

afterEach(async () => {
	for (const p of pis.splice(0)) await p.close();
	await server?.close();
	server = undefined;
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function newRoot(): string {
	const r = scratch("root");
	roots.push(r);
	return r;
}

async function pi(options: Parameters<typeof startPi>[0]): Promise<PiRpc> {
	const p = await startPi(options);
	pis.push(p);
	return p;
}

type Msg = { role: string; content: unknown };

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: string }).text) : "")).join("\n");
}

function messages(req: Captured): Msg[] {
	return (req.body.messages as Msg[] | undefined) ?? [];
}

function lastUser(req: Captured): Msg | undefined {
	return messages(req).filter((m) => m.role === "user").at(-1);
}

/** Tools offered to the model: the request's tool list plus tools added mid-conversation (a tool_addition block). */
function toolNames(req: Captured): string[] {
	const listed = ((req.body.tools as { name: string }[] | undefined) ?? []).map((t) => t.name);
	const added = messages(req).flatMap((m) =>
		Array.isArray(m.content)
			? (m.content as { type?: string; tool?: { definition?: { name?: string } } }[])
					.filter((b) => b.type === "tool_addition")
					.map((b) => b.tool?.definition?.name ?? "")
			: [],
	);
	return [...listed, ...added];
}

/** The model: acknowledge the newest letter it has not acknowledged yet; otherwise just reply. */
function acknowledging(note = "handled") {
	const acked = new Set<string>();
	return (req: Captured) => {
		const last = lastUser(req);
		const isToolResult = Array.isArray(last?.content) && (last!.content as { type?: string }[]).some((b) => b.type === "tool_result");
		if (isToolResult) return { text: "Receipt sent." };
		const ids = [...textOf(last?.content).matchAll(/Letter (\S+) in letterbox/g)].map((m) => m[1]!).filter((id) => !acked.has(id));
		if (!ids.length) return { text: "ok" };
		for (const id of ids) acked.add(id);
		return { toolCalls: ids.map((id, i) => ({ id: `toolu_${id}_${i}`, name: "letterbox_done", arguments: { id, note } })) };
	};
}

async function until<T>(probe: () => T | undefined | false, ms = 20_000, what = "condition"): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const v = probe();
		if (v !== undefined && v !== false) return v;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

async function cli(args: string[], env: Record<string, string>) {
	const e: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("PI_")) e[k] = v;
	const p = Bun.spawn(["node", CLI, ...args], { env: { ...e, ...env }, stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	return { out, err, code };
}

const receipt = (root: string, box: string, id: string) => lb.readReceipt(root, box, id);

describe("pi-letterbox in a real pi", () => {
	test("an idle session takes a letter, starts a turn, and the agent's receipt reaches the waiting sender", async () => {
		server = await startCaptureServer();
		server.respond(acknowledging("did X"));
		const root = newRoot();
		const p = await pi({ baseUrl: server.url, args: ["--letterbox", "demo"], env: { PI_LETTERBOX_DIR: root } });
		await until(() => lb.readReader(root, "demo"), 10_000, "reader.json");

		const r = await cli(["send", "demo", "--id", "L1", "--from", "ci", "--wait", "done", "--timeout", "30", "please do X"], { PI_LETTERBOX_DIR: root });
		expect(r.err).toBe("");
		expect(r.code).toBe(0);
		expect(r.out).toContain("L1: done — did X");

		const rc = receipt(root, "demo", "L1")!;
		expect(rc).toMatchObject({ state: "done", note: "did X", from: "ci", delivery: "started a turn", pid: p.child.pid });
		expect(Object.keys(rc.at)).toEqual(["delivered", "read", "done"]);
		expect(rc.session_file).toBe(p.sessionFile());

		const first = server.requests.find((q) => textOf(lastUser(q)?.content).includes("please do X"))!;
		expect(textOf(lastUser(first)?.content)).toContain('Letter L1 in letterbox "demo" from ci:\n\nplease do X\n\n(The sender is waiting for a receipt');
		expect(toolNames(first)).toContain("letterbox_done");
		expect(readdirSync(join(root, "demo/new"))).toEqual([]);
		// The letter is part of the saved conversation, as a custom message.
		expect(p.sessionEntries().some((e) => e.type === "custom_message" && e.customType === "letterbox")).toBe(true);
	}, 60_000);

	test("a busy session queues the letter behind its current work (followUp)", async () => {
		server = await startCaptureServer();
		const root = newRoot();
		let release!: () => void;
		const hold = new Promise<void>((r) => (release = r));
		const ack = acknowledging();
		let first = true;
		server.respond((req) => {
			if (first) {
				first = false;
				return { text: "working on the user's task", hold };
			}
			return ack(req);
		});
		const p = await pi({ baseUrl: server.url, args: ["--letterbox", "demo"], env: { PI_LETTERBOX_DIR: root } });
		await p.prompt("start the task");
		await server.waitForRequests(1);
		lb.dropLetter(root, "demo", lb.makeLetter({ text: "when you are free", id: "Q1" }));
		const delivered = await until(() => receipt(root, "demo", "Q1"), 10_000, "delivered receipt");
		expect(delivered.state).toBe("delivered");
		expect(delivered.delivery).toBe("queued");
		expect(server.requests.length).toBe(1); // nothing reached the model while it was busy
		release();
		await until(() => receipt(root, "demo", "Q1")?.state === "done", 20_000, "done receipt");
		const withLetter = server.requests.findIndex((q) => textOf(lastUser(q)?.content).includes("when you are free"));
		expect(withLetter).toBeGreaterThan(0);
		expect(textOf(lastUser(server.requests[0]!)?.content)).toContain("start the task");
	}, 60_000);

	test("--steer reaches a busy session within its current run", async () => {
		server = await startCaptureServer();
		const root = newRoot();
		let release!: () => void;
		const hold = new Promise<void>((r) => (release = r));
		const ack = acknowledging();
		let first = true;
		server.respond((req) => {
			if (first) {
				first = false;
				return { text: "working", hold };
			}
			return ack(req);
		});
		const p = await pi({ baseUrl: server.url, args: ["--letterbox", "demo"], env: { PI_LETTERBOX_DIR: root } });
		await p.prompt("start");
		await server.waitForRequests(1);
		lb.dropLetter(root, "demo", lb.makeLetter({ text: "stop and look", id: "S1", steer: true }));
		await until(() => receipt(root, "demo", "S1"), 10_000, "delivered");
		expect(receipt(root, "demo", "S1")!.delivery).toBe("steered");
		release();
		await until(() => receipt(root, "demo", "S1")?.state === "done", 20_000, "done");
		await p.waitForAgentEnd(1);
		// One run: the steered letter was taken inside it, not as a follow-up run.
		await new Promise((r) => setTimeout(r, 300));
		expect(p.agentEnds()).toBe(1);
	}, 60_000);

	test("a letter that arrives while pi is compacting waits for the compaction, then starts a turn", async () => {
		server = await startCaptureServer();
		const root = newRoot();
		let release!: () => void;
		const hold = new Promise<void>((r) => (release = r));
		const ack = acknowledging();
		let n = 0;
		server.respond((req) => {
			n++;
			if (n <= 2) return { text: "ok" };
			if (n === 3) return { text: "## Summary\nThe user said hi.", hold }; // the compaction summary
			return ack(req);
		});
		const p = await pi({
			baseUrl: server.url,
			args: ["--letterbox", "demo"],
			env: { PI_LETTERBOX_DIR: root },
			settings: { compaction: { keepRecentTokens: 10 } },
		});
		await p.prompt(`hi ${"x".repeat(4000)}`);
		await p.waitForAgentEnd(1);
		await p.prompt(`again ${"y".repeat(4000)}`);
		await p.waitForAgentEnd(2);
		const compacted = p.send({ type: "compact" }, 30_000);
		await server.waitForRequests(3);
		lb.dropLetter(root, "demo", lb.makeLetter({ text: "during compaction", id: "C1" }));
		await new Promise((r) => setTimeout(r, 3000)); // longer than the 2 s scan
		expect(receipt(root, "demo", "C1")).toBeUndefined();
		expect(lb.waiting(root, "demo")).toEqual(["C1.json"]);
		release();
		expect((await compacted).success).toBe(true);
		const done = await until(() => receipt(root, "demo", "C1")?.state === "done" && receipt(root, "demo", "C1"), 20_000, "C1 done");
		expect(done.delivery).toBe("started a turn");
	}, 60_000);

	test("without an open box the tool is not offered and letters wait; /letterbox open is remembered by pi -c", async () => {
		server = await startCaptureServer();
		server.respond(acknowledging());
		const root = newRoot();
		const agentDir = scratch("agent");
		const sessionDir = scratch("sessions");
		const cwd = scratch("cwd");
		roots.push(agentDir, sessionDir, cwd);
		const env = { PI_LETTERBOX_DIR: root };
		const a = await pi({ baseUrl: server.url, env, agentDir, sessionDir, cwd });
		lb.dropLetter(root, "demo", lb.makeLetter({ text: "first letter", id: "W1" }));
		await a.prompt("hi");
		await a.waitForAgentEnd(1);
		expect(toolNames(server.requests[0]!)).not.toContain("letterbox_done");
		expect(lb.waiting(root, "demo")).toEqual(["W1.json"]);

		await a.prompt("/letterbox open demo");
		await until(() => receipt(root, "demo", "W1")?.state === "done", 20_000, "W1 done");
		const withLetter = server.requests.find((q) => textOf(lastUser(q)?.content).includes("first letter"))!;
		expect(toolNames(withLetter)).toContain("letterbox_done");
		await a.stop();
		expect(lb.readReader(root, "demo")).toBeUndefined(); // released on exit

		const b = await pi({ baseUrl: server.url, env, agentDir, sessionDir, cwd, args: ["--continue"] });
		const rd = await until(() => lb.readReader(root, "demo"), 10_000, "reader after resume");
		expect(rd.pid).toBe(b.child.pid!);
		lb.dropLetter(root, "demo", lb.makeLetter({ text: "second letter", id: "W2" }));
		await until(() => receipt(root, "demo", "W2")?.state === "done", 20_000, "W2 done");
	}, 90_000);

	test("a second session leaves a box that is being read alone until it takes it over", async () => {
		server = await startCaptureServer();
		server.respond(acknowledging());
		const root = newRoot();
		const env = { PI_LETTERBOX_DIR: root };
		const a = await pi({ baseUrl: server.url, args: ["--letterbox", "demo"], env });
		await until(() => lb.readReader(root, "demo"), 10_000, "reader A");
		const b = await pi({ baseUrl: server.url, args: ["--letterbox", "demo"], env });
		await until(() => b.notifications().find((n) => n.includes("is read by pid")), 10_000, "busy notice");
		expect(lb.readReader(root, "demo")!.pid).toBe(a.child.pid!);

		lb.dropLetter(root, "demo", lb.makeLetter({ text: "to A", id: "A1" }));
		await until(() => receipt(root, "demo", "A1")?.state === "done", 20_000, "A1 done");
		expect(receipt(root, "demo", "A1")!.pid).toBe(a.child.pid!);

		await b.prompt("/letterbox open demo --take");
		await until(() => lb.readReader(root, "demo")?.pid === b.child.pid, 10_000, "B reads");
		lb.dropLetter(root, "demo", lb.makeLetter({ text: "to B", id: "B1" }));
		await until(() => receipt(root, "demo", "B1")?.state === "done", 20_000, "B1 done");
		expect(receipt(root, "demo", "B1")!.pid).toBe(b.child.pid!);
		await until(() => a.notifications().find((n) => n.includes("took over")), 10_000, "A notices");
		expect(lb.readReader(root, "demo")!.pid).toBe(b.child.pid!); // A did not write it back
	}, 90_000);

	test("an unreadable letter gets a rejected receipt; an expired one too", async () => {
		server = await startCaptureServer();
		server.respond(acknowledging());
		const root = newRoot();
		lb.ensureBox(root, "demo");
		writeFileSync(join(root, "demo/new/bad.json"), "{not json");
		lb.dropLetter(root, "demo", lb.makeLetter({ text: "too late", id: "late", ttlSec: 1, now: new Date(Date.now() - 10_000) }));
		await pi({ baseUrl: server.url, args: ["--letterbox", "demo"], env: { PI_LETTERBOX_DIR: root } });
		const bad = await until(() => receipt(root, "demo", "bad"), 10_000, "bad receipt");
		expect(bad).toMatchObject({ state: "rejected", reason: "not valid JSON" });
		expect((await until(() => receipt(root, "demo", "late"), 10_000, "late receipt")).reason).toContain("expired");
		await new Promise((r) => setTimeout(r, 500));
		expect(server.requests.length).toBe(0); // neither reached the model
		expect(existsSync(join(root, "demo/new/bad.json"))).toBe(false);
	}, 60_000);
});
