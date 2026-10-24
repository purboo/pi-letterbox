// Round-2 regressions: cross-box inflight keys and the stale-lock ABA interleaving.
import { afterEach, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as lb from "../lib/letterbox.mjs";
import extension from "../src/index.ts";

const WORKER = join(resolve(import.meta.dir), "fixtures/lock-worker.mjs");
const dirs: string[] = [];
const children: ChildProcess[] = [];
const root = () => {
	const d = mkdtempSync(join(tmpdir(), "pi-letterbox-race-"));
	dirs.push(d);
	return d;
};
afterEach(() => {
	for (const c of children.splice(0)) if (c.exitCode === null) c.kill("SIGKILL");
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function worker(r: string, mode: string, role: string) {
	const p = spawn("node", [WORKER, r, mode, role], { stdio: ["ignore", "pipe", "pipe"] });
	children.push(p);
	let out = "";
	let err = "";
	p.stdout!.on("data", (s) => (out += s));
	p.stderr!.on("data", (s) => (err += s));
	const done = new Promise<{ code: number | null; out: string; err: string }>((ok) => p.on("close", (code) => ok({ code, out: out.trim(), err })));
	return { p, done };
}
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
async function until(file: string, ms = 8000) {
	const end = Date.now() + ms;
	while (!existsSync(file)) {
		if (Date.now() > end) throw new Error(`timeout waiting for ${file}`);
		await sleep(5);
	}
}
/** A stale lock L1 in both layouts: an old owner-<nonce> file and an old directory mtime. */
function staleLock(r: string) {
	const dir = join(lb.ensureBox(r, "b").locks, "reader");
	mkdirSync(dir);
	writeFileSync(join(dir, "owner-l1"), JSON.stringify({ pid: process.pid, host: hostname(), time: 0 }));
	utimesSync(dir, new Date(0), new Date(0));
	return dir;
}
const ownerPid = (dir: string) => {
	const files = readdirSync(dir);
	expect(files).toHaveLength(1);
	return JSON.parse(readFileSync(join(dir, files[0]!), "utf8")).pid;
};

test("A: message_end in box a does not erase box b's inflight record for the same id", async () => {
	const r = root();
	const prevDir = process.env.PI_LETTERBOX_DIR;
	const origSet = globalThis.setInterval, origClear = globalThis.clearInterval, origNow = Date.now;
	const handlers = new Map<string, Function>(), sent: any[] = [], intervals = new Map<number, Function>();
	let command: any, active: string[] = [], idle = false;
	const c: any = { cwd: r, mode: "rpc", hasUI: false, signal: new AbortController().signal, isIdle: () => idle, hasPendingMessages: () => !idle,
		sessionManager: { getSessionId: () => "same-session", getSessionFile: () => undefined, getBranch: () => [] }, ui: { notify() {} } };
	const pi: any = { registerFlag() {}, getFlag: () => "a", getActiveTools: () => active, setActiveTools: (a: string[]) => (active = a),
		on: (n: string, f: Function) => handlers.set(n, f), registerTool() {}, registerCommand: (_n: string, v: any) => (command = v),
		registerMessageRenderer() {}, appendEntry() {}, sendMessage: (m: any) => sent.push(m) };
	try {
		globalThis.setInterval = ((f: Function, ms: number) => { intervals.set(ms, f); return { unref() {} }; }) as any;
		globalThis.clearInterval = (() => {}) as any;
		process.env.PI_LETTERBOX_DIR = r;
		for (const b of ["a", "b"]) lb.dropLetter(r, b, lb.makeLetter({ id: "same", text: `work in ${b}` }));
		extension(pi);
		handlers.get("session_start")!({}, c); // reads box a, queues a/same
		await command.handler("open b", c); // switches to box b, queues b/same
		expect(sent.map((m) => m.details.box)).toEqual(["a", "b"]);
		handlers.get("message_end")!({ message: { role: "custom", ...sent[0] } }); // only a/same reached the model
		idle = true;
		Date.now = () => origNow() + 20_000;
		intervals.get(2000)!(); // the scan runs recovery: b/same was dropped from the queue
		expect(lb.readReceipt(r, "b", "same")).toMatchObject({ state: "delivered", attempts: 2 });
		expect(sent.map((m) => m.details.box)).toEqual(["a", "b", "b"]);
		expect(lb.readReceipt(r, "a", "same")?.state).toBe("read");
	} finally {
		handlers.get("session_shutdown")?.({}, c);
		globalThis.setInterval = origSet;
		globalThis.clearInterval = origClear;
		Date.now = origNow;
		if (prevDir === undefined) delete process.env.PI_LETTERBOX_DIR; else process.env.PI_LETTERBOX_DIR = prevDir;
	}
});

test("B: a breaker that observed stale L1 never moves L2; one holder at a time", async () => {
	const r = root();
	const dir = staleLock(r);
	const breaker = worker(r, "lock", "breaker");
	await until(join(r, "breaker-observed"));
	const holder = worker(r, "lock", "holder");
	await until(join(r, "holder-inside")); // the holder broke L1 and holds L2
	writeFileSync(join(r, "breaker-go"), "");
	await sleep(500);
	expect(existsSync(join(r, "breaker-inside"))).toBe(false);
	expect(ownerPid(dir)).toBe(holder.p.pid); // L2 is still in place
	writeFileSync(join(r, "holder-release"), "");
	expect((await holder.done).code).toBe(0);
	await until(join(r, "breaker-inside"));
	expect(ownerPid(dir)).toBe(breaker.p.pid); // the holder's release did not remove the breaker's lock
	writeFileSync(join(r, "breaker-release"), "");
	const b = await breaker.done;
	expect(b.code, b.err).toBe(0);
	expect(existsSync(join(r, "overlap"))).toBe(false);
	expect(existsSync(dir)).toBe(false);
}, 20_000);

test("B: the same interleaving through claimReader yields exactly one claimed", async () => {
	const r = root();
	staleLock(r);
	const late = worker(r, "claim", "late");
	await until(join(r, "late-observed"));
	const first = worker(r, "claim", "first");
	await until(join(r, "first-ready")); // first holds the lock and is about to write reader.json
	writeFileSync(join(r, "late-go"), "");
	await sleep(300);
	writeFileSync(join(r, "first-go"), "");
	const results = await Promise.all([late.done, first.done]);
	for (const x of results) expect(x.code, x.err).toBe(0);
	expect(results.map((x) => x.out).sort()).toEqual(["first:claimed", "late:busy"]);
	expect(lb.readReader(r, "b")?.token).toBe("first");
}, 20_000);

test("B: an empty lock directory is replaced at once", () => {
	const r = root();
	const dir = join(lb.ensureBox(r, "b").locks, "reader");
	mkdirSync(dir); // e.g. left by a holder that died between unlink and rmdir
	const t = Date.now();
	expect(lb.withLock(r, "b", "reader", () => readdirSync(dir).filter((n) => n.startsWith("owner-")).length)).toBe(1);
	expect(Date.now() - t).toBeLessThan(1000);
	expect(existsSync(dir)).toBe(false);
}, 10_000);

test("B: a holder whose lock was broken returns normally and leaves the new holder's lock", async () => {
	const r = root();
	const dir = join(lb.ensureBox(r, "b").locks, "reader");
	let child: ReturnType<typeof worker> | undefined;
	const result = lb.withLock(r, "b", "reader", () => {
		// Pretend this holder stalled > 10 s: age its owner record (and, for the old layout, the directory).
		for (const n of readdirSync(dir)) writeFileSync(join(dir, n), JSON.stringify({ pid: process.pid, host: hostname(), time: 0 }));
		utimesSync(dir, new Date(0), new Date(0));
		child = worker(r, "hold", "hold");
		const end = Date.now() + 8000;
		const wait = new Int32Array(new SharedArrayBuffer(4));
		while (!existsSync(join(r, "hold-inside"))) {
			if (Date.now() > end) throw new Error("the breaker never entered");
			Atomics.wait(wait, 0, 0, 5);
		}
		return "ok";
	});
	expect(result).toBe("ok");
	expect(ownerPid(dir)).toBe(child!.p.pid);
	writeFileSync(join(r, "hold-release"), "");
	const x = await child!.done;
	expect(x.code, x.err).toBe(0);
	expect(existsSync(dir)).toBe(false);
}, 20_000);

test("B: crashed temp and dead files are swept; a crashed round-1 owner file is broken when stale", () => {
	const r = root();
	const locks = lb.ensureBox(r, "b").locks;
	const dir = join(locks, "reader");
	mkdirSync(dir);
	writeFileSync(join(dir, "owner"), JSON.stringify({ pid: process.pid, host: hostname(), time: 0 }));
	mkdirSync(join(locks, ".t-old"));
	writeFileSync(join(locks, ".dead-old"), "{}");
	const real = Date.now;
	Date.now = () => real() + 120_000; // ctime cannot be set; move the clock instead
	try {
		expect(lb.withLock(r, "b", "r.x", () => "swept")).toBe("swept");
	} finally { Date.now = real; }
	expect(readdirSync(locks).sort()).toEqual(["reader"]);
	expect(lb.withLock(r, "b", "reader", () => "broken")).toBe("broken");
	expect(readdirSync(locks)).toEqual([]);
});
