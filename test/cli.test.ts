// The CLI as users run it (node bin/pi-letterbox.mjs), locally and over a stand-in ssh.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as lb from "../lib/letterbox.mjs";

const ROOT = resolve(import.meta.dir, "..");
const CLI = join(ROOT, "bin/pi-letterbox.mjs");
const FAKE_SSH = join(ROOT, "test/fixtures/fake-ssh");

const dirs: string[] = [];
const scratch = () => {
	const d = mkdtempSync(join(tmpdir(), "pi-letterbox-cli-"));
	dirs.push(d);
	return d;
};
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Run {
	code: number;
	out: string;
	err: string;
}

function env(extra: Record<string, string> = {}): Record<string, string> {
	const e: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("PI_")) e[k] = v;
	return { ...e, ...extra };
}

async function cli(args: string[], extra: Record<string, string> = {}, stdin?: string): Promise<Run> {
	const p = Bun.spawn(["node", CLI, ...args], { env: env(extra), stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	return { code, out, err };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("local", () => {
	test("send drops a letter, says nobody reads the box yet, and is idempotent by id", async () => {
		const root = scratch();
		const a = await cli(["send", "b", "--id", "m1", "--from", "tester", "hello", "there"], { PI_LETTERBOX_DIR: root });
		expect(a.code).toBe(0);
		expect(a.out.trim()).toBe("sent m1 to b");
		expect(a.err).toContain("no pi session is reading b");
		const letter = JSON.parse(readFileSync(join(root, "b/new/m1.json"), "utf8"));
		expect(letter).toMatchObject({ v: 1, id: "m1", text: "hello there", from: "tester" });
		const again = await cli(["send", "b", "--id", "m1", "x"], { PI_LETTERBOX_DIR: root });
		expect(again.out).toContain("already sent");
		expect(readdirSync(join(root, "b/new"))).toEqual(["m1.json"]);
	});

	test("text from stdin, options as --key=value, JSON output", async () => {
		const root = scratch();
		const r = await cli(["send", "b", "--json", "--id=s1", "--steer", "--no-ack", "--ttl=60"], { PI_LETTERBOX_DIR: root }, "line 1\nline 2\n\n");
		expect(r.code).toBe(0);
		expect(JSON.parse(r.out)).toMatchObject({ id: "s1", box: "b", outcome: "sent", reader_live: false });
		const letter = JSON.parse(readFileSync(join(root, "b/new/s1.json"), "utf8"));
		expect(letter).toMatchObject({ text: "line 1\nline 2", delivery: "steer", ack: false });
		expect(Date.parse(letter.expires_at) - Date.parse(letter.created_at)).toBe(60_000);
	});

	test("send --wait follows the receipt to done", async () => {
		const root = scratch();
		const run = cli(["send", "b", "--id", "w1", "--wait", "done", "--timeout", "20", "do it"], { PI_LETTERBOX_DIR: root });
		while (!existsSync(join(root, "b/new/w1.json"))) await sleep(20);
		lb.writeReceipt(root, "b", "w1", { state: "delivered" });
		await sleep(700);
		lb.writeReceipt(root, "b", "w1", { state: "read" });
		await sleep(700);
		lb.writeReceipt(root, "b", "w1", { state: "done", note: "all good" });
		const r = await run;
		expect(r.code).toBe(0);
		expect(r.out).toContain("w1: done — all good");
	});

	test("exit status: 3 on timeout, 4 when declined or rejected, 0 when the state is reached", async () => {
		const root = scratch();
		const e = { PI_LETTERBOX_DIR: root };
		lb.dropLetter(root, "b", lb.makeLetter({ text: "x", id: "t1" }));
		expect((await cli(["wait", "b", "t1", "--timeout", "1"], e)).code).toBe(3);
		lb.writeReceipt(root, "b", "t1", { state: "read" });
		expect((await cli(["wait", "b", "t1", "--until", "read", "--timeout", "1"], e)).code).toBe(0);
		lb.writeReceipt(root, "b", "t1", { state: "declined", note: "not mine" });
		const d = await cli(["wait", "b", "t1", "--timeout", "1"], e);
		expect(d.code).toBe(4);
		expect(d.out).toContain("declined — not mine");
		expect((await cli(["wait", "b", "t1", "--until", "read", "--timeout", "1"], e)).code).toBe(0);
		lb.writeReceipt(root, "b", "t2", { state: "rejected", reason: "expired" });
		expect((await cli(["wait", "b", "t2", "--until", "delivered", "--timeout", "1"], e)).code).toBe(4);
	});

	test("status says waiting, taken, the receipt, or unknown", async () => {
		const root = scratch();
		const e = { PI_LETTERBOX_DIR: root };
		lb.dropLetter(root, "b", lb.makeLetter({ text: "x", id: "s1" }));
		expect((await cli(["status", "b", "s1"], e)).out).toContain("waiting");
		lb.takeLetter(root, "b", "s1.json");
		expect((await cli(["status", "b", "s1"], e)).out).toContain("taken");
		lb.writeReceipt(root, "b", "s1", { state: "delivered" });
		expect((await cli(["status", "b", "s1", "--json"], e)).out).toContain('"state":"delivered"');
		expect((await cli(["status", "b", "nope"], e)).code).toBe(1);
	});

	test("list shows boxes and waiting letters", async () => {
		const root = scratch();
		lb.dropLetter(root, "alpha", lb.makeLetter({ text: "x", id: "1" }));
		lb.ensureBox(root, "beta");
		const r = await cli(["list"], { PI_LETTERBOX_DIR: root });
		expect(r.out).toBe("alpha\t1 waiting\tno reader\nbeta\t0 waiting\tno reader\n");
	});

	test("usage errors exit 2", async () => {
		expect((await cli(["send", "../x", "hi"])).code).toBe(2);
		expect((await cli(["send", "b"], {}, "")).code).toBe(2);
		expect((await cli(["send", "b", "--bogus", "hi"])).code).toBe(2);
		expect((await cli(["wait", "b", "x", "--until", "soon"])).code).toBe(2);
		expect((await cli(["frobnicate"])).code).toBe(2);
		expect((await cli([])).code).toBe(2);
		expect((await cli(["--help"])).code).toBe(0);
	});
});

describe("over ssh (a stand-in that runs the remote shell here)", () => {
	const remote = () => {
		const home = scratch();
		return { home, root: join(home, ".pi/agent/letterbox"), env: { PI_LETTERBOX_SSH: FAKE_SSH, FAKE_SSH_HOME: home } };
	};

	test("send writes into the far side's default root and reports its reader", async () => {
		const far = remote();
		lb.writeReader(far.root, "b", { v: 1, pid: 1, host: "far", since: "s", beat: new Date().toISOString(), cwd: "/w" });
		const r = await cli(["send", "--host", "far", "b", "--id", "r1", "hi from afar"], far.env);
		expect(r.code).toBe(0);
		expect(r.out.trim()).toBe("sent r1 to far:b");
		expect(r.err).toBe("");
		expect(JSON.parse(readFileSync(join(far.root, "b/new/r1.json"), "utf8")).text).toBe("hi from afar");
		expect(existsSync(join(far.root, "b/tmp/r1.json"))).toBe(false);
		const again = await cli(["send", "--host", "far", "b", "--id", "r1", "hi"], far.env);
		expect(again.out).toContain("already sent");
	});

	test("letters with quotes, $ and here-doc look-alikes arrive intact", async () => {
		const far = remote();
		const text = `it's "quoted" $HOME \`date\` \\ back\nPI_LETTERBOX_EOF_x\nEOF`;
		const r = await cli(["send", "--host", "far", "b", "--id", "q1"], far.env, text);
		expect(r.code).toBe(0);
		expect(JSON.parse(readFileSync(join(far.root, "b/new/q1.json"), "utf8")).text).toBe(text);
	});

	test("--dir names the far root", async () => {
		const far = remote();
		const r = await cli(["send", "--host", "far", "--dir", join(far.home, "boxes"), "b", "--id", "d1", "x"], far.env);
		expect(r.code).toBe(0);
		expect(existsSync(join(far.home, "boxes/b/new/d1.json"))).toBe(true);
	});

	test("wait and status over one connection each", async () => {
		const far = remote();
		const run = cli(["send", "--host", "far", "b", "--id", "w1", "--wait", "done", "--timeout", "30", "x"], far.env);
		while (!existsSync(join(far.root, "b/new/w1.json"))) await sleep(20);
		lb.writeReceipt(far.root, "b", "w1", { state: "read" });
		await sleep(2500);
		lb.writeReceipt(far.root, "b", "w1", { state: "done", note: "remote ok" });
		const r = await run;
		expect(r.code).toBe(0);
		expect(r.out).toContain("w1: done — remote ok");
		expect((await cli(["status", "--host", "far", "b", "w1"], far.env)).out).toContain("w1: done");
		expect((await cli(["status", "--host", "far", "b", "zz"], far.env)).code).toBe(1);
		const t = await cli(["wait", "--host", "far", "b", "w1", "--until", "done", "--timeout", "1"], far.env);
		expect(t.code).toBe(0);
	});

	test("a remote wait times out with exit 3", async () => {
		const far = remote();
		lb.dropLetter(far.root, "b", lb.makeLetter({ text: "x", id: "t1" }));
		const t0 = Date.now();
		const r = await cli(["wait", "--host", "far", "b", "t1", "--timeout", "2"], far.env);
		expect(r.code).toBe(3);
		expect(Date.now() - t0).toBeLessThan(10_000);
	});

	test("list over ssh", async () => {
		const far = remote();
		lb.dropLetter(far.root, "x", lb.makeLetter({ text: "x", id: "1" }));
		lb.dropLetter(far.root, "x", lb.makeLetter({ text: "x", id: "2" }));
		const r = await cli(["list", "--host", "far", "--json"], far.env);
		expect(JSON.parse(r.out)).toEqual([{ box: "x", waiting: 2, live: false }]);
	});

	test("an unreachable host is an error, not a silent success", async () => {
		const far = remote();
		const r = await cli(["send", "--host", "down", "b", "x"], far.env);
		expect(r.code).toBe(1);
		expect(r.err).toContain("Connection refused");
	});
});
