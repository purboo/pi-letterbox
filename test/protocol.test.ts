import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import extension from "../src/index.ts";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import * as lb from "../lib/letterbox.mjs";

const runtimes: { close(): void }[] = [];
const dirs: string[] = [];
const root = () => {
	const d = mkdtempSync(join(tmpdir(), "pi-letterbox-unit-"));
	dirs.push(d);
	return d;
};
afterEach(() => {
	for (const run of runtimes.splice(0)) run.close();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("letters", () => {
	test("makeLetter fills the envelope and checkLetter accepts it", () => {
		const l = lb.makeLetter({ text: "hi", from: "ci\nbot", steer: true, ack: false, ttlSec: 60, now: new Date("2026-01-02T03:04:05Z") });
		expect(l.v).toBe(1);
		expect(l.id).toMatch(/^20260102-030405-[0-9a-f]{8}$/);
		expect(l.from).toBe("ci bot");
		expect(l.delivery).toBe("steer");
		expect(l.ack).toBe(false);
		expect(l.expires_at).toBe("2026-01-02T03:05:05.000Z");
		expect(lb.checkLetter(l, l.id)).toBeUndefined();
	});

	test("checkLetter names what is wrong", () => {
		const ok = lb.makeLetter({ text: "x", id: "a1" });
		expect(lb.checkLetter({ ...ok, v: 2 }, "a1")).toContain("version");
		expect(lb.checkLetter({ ...ok, id: "../x" })).toContain("id");
		expect(lb.checkLetter(ok, "other")).toContain("does not match");
		expect(lb.checkLetter({ ...ok, text: "  " }, "a1")).toContain("text");
		expect(lb.checkLetter({ ...ok, text: "x".repeat(lb.MAX_TEXT_BYTES + 1) }, "a1")).toContain("larger");
		expect(lb.checkLetter({ ...ok, delivery: "now" }, "a1")).toContain("delivery");
		expect(lb.checkLetter([], "a1")).toContain("object");
		expect(() => lb.makeLetter({ text: "" })).toThrow();
	});

	test("box names are validated and bin is reserved", () => {
		expect(() => lb.boxPaths("/r", "../etc")).toThrow();
		expect(() => lb.boxPaths("/r", "bin")).toThrow();
		expect(() => lb.boxPaths("/r", "")).toThrow();
		expect(lb.boxPaths("/r", "work").new).toBe("/r/work/new");
	});

	test("default root follows PI_LETTERBOX_DIR, then PI_CODING_AGENT_DIR", () => {
		expect(lb.defaultRoot({ PI_LETTERBOX_DIR: "/x" })).toBe("/x");
		expect(lb.defaultRoot({ PI_CODING_AGENT_DIR: "/a" })).toBe("/a/letterbox");
		expect(lb.defaultRoot({})).toMatch(/\/\.pi\/agent\/letterbox$/);
	});
});

describe("drop and take", () => {
	test("a dropped letter waits in new/, private, and is taken once", () => {
		const r = root();
		const l = lb.makeLetter({ text: "hello", id: "m1" });
		expect(lb.dropLetter(r, "b", l)).toBe("sent");
		expect(lb.dropLetter(r, "b", l)).toBe("exists");
		expect(lb.waiting(r, "b")).toEqual(["m1.json"]);
		expect(statSync(join(r, "b")).mode & 0o777).toBe(0o700);
		expect(statSync(join(r, "b/new/m1.json")).mode & 0o777).toBe(0o600);
		expect(readdirSync(join(r, "b/tmp"))).toEqual([]);
		const t = lb.takeLetter(r, "b", "m1.json");
		expect(t && "letter" in t && t.letter.text).toBe("hello");
		expect(lb.waiting(r, "b")).toEqual([]);
		expect(existsSync(join(r, "b/cur/m1.json"))).toBe(true);
		expect(lb.takeLetter(r, "b", "m1.json")).toBeUndefined();
		// Taken but not receipted is still known: the same id is not sent twice.
		expect(lb.dropLetter(r, "b", l)).toBe("exists");
		lb.untakeLetter(r, "b", "m1");
		expect(lb.waiting(r, "b")).toEqual(["m1.json"]);
	});

	test("invalid and expired letters are rejected with a reason", () => {
		const r = root();
		lb.ensureBox(r, "b");
		writeFileSync(join(r, "b/new/bad.json"), "{nope");
		writeFileSync(join(r, "b/new/odd name.json"), "{}");
		lb.dropLetter(r, "b", lb.makeLetter({ text: "late", id: "old", ttlSec: 1, now: new Date(Date.now() - 5000) }));
		const out = Object.fromEntries(lb.waiting(r, "b").map((n) => [n, lb.takeLetter(r, "b", n)]));
		expect(out["bad.json"]).toEqual({ rejected: { id: "bad", reason: "not valid JSON" } });
		expect(out["odd name.json"]).toMatchObject({ rejected: { id: undefined } });
		expect((out["old.json"] as { rejected: { reason: string } }).rejected.reason).toContain("expired");
		expect(existsSync(join(r, "b/seen/odd name.invalid"))).toBe(true);
	});

	test("waiting is oldest first", () => {
		const r = root();
		for (const id of ["c", "a", "b"]) {
			lb.dropLetter(r, "b", lb.makeLetter({ text: id, id }));
			Bun.sleepSync(15);
		}
		expect(lb.waiting(r, "b")).toEqual(["c.json", "a.json", "b.json"]);
	});
});

describe("receipts", () => {
	test("states only move forward, keep first times and merge fields", () => {
		const r = root();
		const a = lb.writeReceipt(r, "b", "x", { state: "delivered", from: "me" }, new Date("2026-01-01T00:00:00Z"));
		expect(Object.keys(a)[0]).toBe("state");
		lb.writeReceipt(r, "b", "x", { state: "read" }, new Date("2026-01-01T00:00:01Z"));
		lb.writeReceipt(r, "b", "x", { state: "delivered" }, new Date("2026-01-01T00:00:02Z"));
		const d = lb.writeReceipt(r, "b", "x", { state: "done", note: "ok" }, new Date("2026-01-01T00:00:03Z"));
		expect(d.state).toBe("done");
		expect(d.from).toBe("me");
		expect(d.note).toBe("ok");
		expect(d.at).toEqual({ delivered: "2026-01-01T00:00:00.000Z", read: "2026-01-01T00:00:01.000Z", done: "2026-01-01T00:00:03.000Z" });
		const back = lb.writeReceipt(r, "b", "x", { state: "read" });
		expect(back.state).toBe("done");
		expect(readFileSync(join(r, "b/receipts/x.json"), "utf8")).toStartWith('{"state":"done"');
		expect(readdirSync(join(r, "b/receipts")).filter((n) => n.startsWith("."))).toEqual([]);
	});

	test("reached orders the states", () => {
		expect(lb.reached("delivered", "delivered")).toBe(true);
		expect(lb.reached("delivered", "read")).toBe(false);
		expect(lb.reached("read", "done")).toBe(false);
		expect(lb.reached("rejected", "read")).toBe(true);
		expect(lb.reached("declined", "done")).toBe(true);
	});
});

describe("reader", () => {
	test("liveness: same host checks the pid, another host the heartbeat", () => {
		const now = Date.now();
		const base = { v: 1 as const, since: new Date(now).toISOString(), beat: new Date(now).toISOString() };
		expect(lb.readerLive({ ...base, pid: process.pid, host: hostname() })).toBe(true);
		expect(lb.readerLive({ ...base, pid: 2 ** 22 + 12345, host: hostname() })).toBe(false);
		expect(lb.readerLive({ ...base, pid: 1, host: "elsewhere" }, now)).toBe(true);
		expect(lb.readerLive({ ...base, pid: 1, host: "elsewhere" }, now + lb.STALE_MS + 1)).toBe(false);
	});

	test("release removes only our own reader file", () => {
		const r = root();
		const me = { v: 1 as const, token: "one", pid: process.pid, host: hostname(), since: "s1", beat: "b" };
		lb.writeReader(r, "b", me);
		lb.releaseReader(r, "b", { ...me, token: "two", since: "s2" });
		expect(lb.readReader(r, "b")?.since).toBe("s1");
		lb.releaseReader(r, "b", me);
		expect(lb.readReader(r, "b")).toBeUndefined();
	});
});

test("formatForModel carries the receipt instruction only when asked", () => {
	const l = lb.makeLetter({ text: "do X", id: "q1", from: "ci" });
	expect(lb.formatForModel(l, "b")).toBe(
		'Letter q1 in letterbox "b" from ci:\n\ndo X\n\n(The sender is waiting for a receipt: when you have handled this letter, call letterbox_done with id "q1"; use outcome "declined" with a note if you will not do it.)',
	);
	expect(lb.formatForModel({ ...l, ack: false }, "b")).toBe('Letter q1 in letterbox "b" from ci:\n\ndo X');
});


// A minimal extension runtime: no model/network, with real session lifecycle and disk protocol.
function runtime(r: string, session = "own") {
	const handlers = new Map<string, Function>();
	let tool: any;
	let active: string[] = [];
	const c: any = { cwd: r, mode: "rpc", hasUI: false, isIdle: () => true, hasPendingMessages: () => false,
		sessionManager: { getSessionId: () => session, getSessionFile: () => undefined, getBranch: () => [] } };
	const pi: any = { registerFlag() {}, getFlag: () => "b", getActiveTools: () => active,
		setActiveTools: (a: string[]) => { active = a; }, on: (name: string, fn: Function) => handlers.set(name, fn),
		registerTool: (t: any) => { tool = t; }, registerCommand() {}, registerMessageRenderer() {}, sendMessage() {} };
	extension(pi);
	const prev = process.env.PI_LETTERBOX_DIR;
	process.env.PI_LETTERBOX_DIR = r;
	handlers.get("session_start")!({}, c);
	if (prev === undefined) delete process.env.PI_LETTERBOX_DIR; else process.env.PI_LETTERBOX_DIR = prev;
	const run = { done: (params: any) => tool.execute("call", params, undefined, undefined, c),
		close: () => handlers.get("session_shutdown")!({}, c) };
	runtimes.push(run);
	return run;
}

test("F1 recovery: dead foreign leases consult JSONL, requeue missing messages and cap attempts", () => {
	const r = root();
	const p = lb.ensureBox(r, "b");
	const file = join(r, "session.jsonl");
	writeFileSync(file, '{broken\n' + JSON.stringify({ type: "custom_message", customType: "letterbox", details: { id: "seen", box: "b" } }) + '\n');
	for (const id of ["seen", "lost", "cap", "live", "orphan", "busy", "dropped", "pending", "saved"]) {
		lb.dropLetter(r, "b", lb.makeLetter({ id, text: id }));
		lb.takeLetter(r, "b", `${id}.json`);
		if (id !== "orphan") lb.writeReceipt(r, "b", id, { state: "delivered", token: ["busy", "dropped", "pending", "saved"].includes(id) ? "mine" : id === "live" ? "alive" : "dead", attempts: id === "cap" ? 3 : 1, session_file: file });
	}
	utimesSync(join(p.cur, "orphan.json"), new Date(0), new Date(0));
	// These additions use the public disk layout, not a private implementation hook.
	const leases = join(p.dir, "leases");
	mkdirSync(leases, { recursive: true });
	writeFileSync(join(leases, "alive.json"), JSON.stringify({ pid: process.pid, host: hostname(), beat: new Date().toISOString() }));
	writeFileSync(join(leases, "old.json"), JSON.stringify({ beat: new Date(0).toISOString() }));
	const inflight = new Map(["busy", "dropped", "pending", "saved"].map((id) => [id, { box: "b", deliveredAt: Date.now() - 20_000 }]));
	const recover = (idle: boolean, pending = false) => lb.recoverLetters(r, "b", { token: "mine", inflight, isIdle: () => idle, hasPendingMessages: () => pending, session_file: file });
	recover(false);
	expect(lb.readReceipt(r, "b", "seen")?.state).toBe("read");
	expect(existsSync(join(p.dir, "seen/seen.json"))).toBe(true);
	expect(lb.waiting(r, "b").sort()).toEqual(["lost.json", "orphan.json"]);
	expect(lb.readReceipt(r, "b", "lost")?.requeued_at).toBeString();
	expect(lb.readReceipt(r, "b", "cap")).toMatchObject({ state: "rejected", reason: "not delivered after 3 attempts" });
	expect(existsSync(join(p.cur, "busy.json"))).toBe(true);
	expect(existsSync(join(p.cur, "live.json"))).toBe(true);
	expect(existsSync(join(leases, "old.json"))).toBe(false);
	recover(true, true);
	expect(existsSync(join(p.cur, "pending.json"))).toBe(true);
	writeFileSync(file, JSON.stringify({ type: "message", message: { role: "custom", customType: "letterbox", details: { id: "saved", box: "b" } } }) + '\n');
	recover(true);
	expect(lb.waiting(r, "b")).toContain("dropped.json");
	expect(existsSync(join(p.cur, "saved.json"))).toBe(true);
});

test("F3 exclusive opens: fresh foreign same-pid reader is busy; stale owners cannot beat/release takeover", () => {
	const r = root();
	const a = runtime(r);
	const first = lb.readReader(r, "b")!;
	const b = runtime(r, "second"); // concurrent runtimes in one process must still be distinct readers
	expect(lb.readReader(r, "b")).toEqual(first);
	b.close();
	expect(lb.readReader(r, "b")).toEqual(first);
	a.close();
	const foreign = { ...first, token: "foreign", host: "another-host", beat: new Date().toISOString() };
	lb.writeReader(r, "b", foreign);
	const c = runtime(r);
	expect(lb.readReader(r, "b")).toEqual(foreign);
	c.close();
	const mine = { ...foreign, token: "mine", host: hostname() };
	lb.writeReader(r, "b", mine);
	expect(lb.beatReader(r, "b", foreign)).toBe(false);
	lb.releaseReader(r, "b", foreign);
	expect(lb.readReader(r, "b")?.token).toBe("mine");
	expect(lb.readerLive({ ...mine, beat: "bad" })).toBe(false);
	expect(lb.readerLive({ ...mine, beat: new Date(0).toISOString() })).toBe(false);
});

test("F4 done requires current session ownership, searches all boxes and requires box for ambiguity", async () => {
	const r = root();
	const run = runtime(r);
	try {
		lb.writeReceipt(r, "b", "foreign", { state: "delivered", session_id: "other" });
		await expect(run.done({ id: "foreign" })).rejects.toThrow("no letter foreign reached this session");
		lb.writeReceipt(r, "other", "own", { state: "read", session_id: "own" });
		expect((await run.done({ id: "own" })).details.state).toBe("done");
		lb.writeReceipt(r, "b", "duplicate", { state: "delivered", session_id: "own" });
		lb.writeReceipt(r, "other", "duplicate", { state: "delivered", session_id: "own" });
		await expect(run.done({ id: "duplicate" })).rejects.toThrow("box");
		expect((await run.done({ id: "duplicate", box: "other" })).details.box).toBe("other");
		await expect(run.done({ id: "duplicate", box: "other", outcome: "declined" })).rejects.toThrow("already done");
	} finally { run.close(); }
});

test("F5 final receipts cannot change outcome; repeated outcome updates only note", () => {
	const r = root();
	lb.writeReceipt(r, "b", "reject", { state: "rejected", reason: "expired" });
	expect(() => lb.writeReceipt(r, "b", "reject", { state: "done" })).toThrow("letter reject is already rejected");
	lb.writeReceipt(r, "b", "done", { state: "done", note: "one", session_id: "own" });
	expect(() => lb.writeReceipt(r, "b", "done", { state: "declined" })).toThrow("letter done is already done");
	const next = lb.writeReceipt(r, "b", "done", { state: "done", note: "two", session_id: "other", reason: "stale" });
	expect(next).toMatchObject({ state: "done", note: "two", session_id: "own" });
	expect(next.reason).toBeUndefined();
});

test("mkdir locks release on error and break stale owners", () => {
	const r = root();
	const dir = join(lb.ensureBox(r, "b").locks, "reader");
	expect(() => lb.withLock(r, "b", "reader", () => {
		const owner = JSON.parse(readFileSync(join(dir, "owner"), "utf8"));
		expect(owner).toMatchObject({ pid: process.pid, host: hostname() });
		expect(owner.time).toBeNumber();
		throw new Error("callback failed");
	})).toThrow("callback failed");
	expect(existsSync(dir)).toBe(false);
	mkdirSync(dir);
	utimesSync(dir, new Date(0), new Date(0));
	expect(lb.withLock(r, "b", "reader", () => "acquired")).toBe("acquired");
	expect(readdirSync(join(r, "b/locks"))).toEqual([]);
});

test("old read/final cur letters are archived without migration", () => {
	const r = root();
	const p = lb.ensureBox(r, "b");
	for (const state of ["read", "done"] as const) {
		lb.dropLetter(r, "b", lb.makeLetter({ id: state, text: state }));
		lb.takeLetter(r, "b", `${state}.json`);
		lb.writeReceipt(r, "b", state, { state });
	}
	lb.recoverLetters(r, "b", { token: "mine", inflight: new Map(), isIdle: () => true, hasPendingMessages: () => false });
	expect(readdirSync(p.cur)).toEqual([]);
	expect(readdirSync(p.seen).sort()).toEqual(["done.json", "read.json"]);
});

test("shq quotes for /bin/sh", () => {
	const out = Bun.spawnSync(["sh", "-c", `printf %s ${lb.shq("a'b $HOME \"c\"")}`]).stdout.toString();
	expect(out).toBe("a'b $HOME \"c\"");
});
