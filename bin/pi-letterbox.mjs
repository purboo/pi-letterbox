#!/usr/bin/env node
// pi-letterbox CLI: drop a letter into a pi session's letterbox, here or on another host over ssh, and wait for its
// receipt. The far side needs only /bin/sh; the session there reads the box with the pi-letterbox extension.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hostname, userInfo } from "node:os";
import * as lb from "../lib/letterbox.mjs";

const HELP = `pi-letterbox: send a letter to a pi session and get receipts

  pi-letterbox send <box> [text…]      text from the arguments, or stdin when there are none
  pi-letterbox status <box> <id>       the letter's receipt
  pi-letterbox wait <box> <id>         wait for a receipt (default --until done)
  pi-letterbox list                    boxes, their reader and waiting letters

Options
  --host <ssh-host>   the box is on another host (ssh with BatchMode; the far side needs only /bin/sh)
  --dir <path>        letterbox root (default: $PI_LETTERBOX_DIR, else <pi agent dir>/letterbox; on --host,
                      the same default evaluated there)
  --from <label>      who is writing (default: user@host)
  --id <id>           the letter id; sending the same id again does not send twice
  --steer             interrupt a busy session at its next step instead of queueing behind its work
  --no-ack            do not ask the agent for a "done" receipt
  --ttl <seconds>     reject the letter if no session takes it within this time
  --wait <state>      after sending, wait for delivered | read | done
  --until <state>     for wait: delivered | read | done (default done)
  --timeout <seconds> how long to wait (default 600)
  --json              print JSON

Receipts: delivered (handed to the session) → read (in its conversation) → done | declined (the agent says so).
A letter the session refuses (invalid, expired) gets rejected. Exit status: 0 the receipt was reached,
3 timed out, 4 rejected or declined, 2 usage error, 1 other error.
Environment: PI_LETTERBOX_DIR, PI_LETTERBOX_SSH (ssh command, default "ssh").`;

const EXIT = { ok: 0, error: 1, usage: 2, timeout: 3, refused: 4 };

class Usage extends Error {}

function parse(argv) {
	const o = { _: [], ack: true, json: false, steer: false };
	const valued = new Set(["host", "dir", "from", "id", "ttl", "wait", "until", "timeout"]);
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--") {
			o._.push(...argv.slice(i + 1));
			break;
		}
		if (a === "-h" || a === "--help") o.help = true;
		else if (a === "--json") o.json = true;
		else if (a === "--steer") o.steer = true;
		else if (a === "--no-ack") o.ack = false;
		else if (a.startsWith("--")) {
			const [k, inline] = a.slice(2).split(/=(.*)/s, 2);
			if (!valued.has(k)) throw new Usage(`unknown option --${k}`);
			const v = inline ?? argv[++i];
			if (v === undefined) throw new Usage(`--${k} needs a value`);
			o[k] = v;
		} else o._.push(a);
	}
	return o;
}

function checkBox(box, what) {
	if (!box) throw new Usage(`${what} needs a box name`);
	if (!lb.BOX_RE.test(box)) throw new Usage(`invalid box name ${JSON.stringify(box)}: use letters, digits, ".", "_" and "-"`);
	return box;
}

function checkId(id, what) {
	if (!id) throw new Usage(`${what} needs a letter id`);
	if (!lb.ID_RE.test(id)) throw new Usage(`invalid letter id ${JSON.stringify(id)}`);
	return id;
}

function seconds(v, name, fallback) {
	if (v === undefined) return fallback;
	const n = Number(v);
	if (!Number.isFinite(n) || n < 0) throw new Usage(`--${name} must be a number of seconds`);
	return n;
}

function waitState(v, name) {
	if (!lb.WAIT_STATES.includes(v)) throw new Usage(`--${name} must be one of ${lb.WAIT_STATES.join(", ")}`);
	return v;
}

function readStdin() {
	try {
		return readFileSync(0, "utf8");
	} catch {
		return "";
	}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run a /bin/sh script on `host` (script on stdin). Resolves with stdout and the exit code. */
function ssh(host, script, { timeoutMs } = {}) {
	const cmd = (process.env.PI_LETTERBOX_SSH || "ssh").split(/\s+/).filter(Boolean);
	const args = [...cmd.slice(1), "-o", "BatchMode=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4",
		...(timeoutMs !== undefined ? ["-o", `ConnectTimeout=${Math.max(1, Math.min(30, Math.ceil(timeoutMs / 1000)))}`] : []), host, "sh -s"];
	return new Promise((resolve) => {
		const child = spawn(cmd[0], args, { stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
		let out = "";
		let err = "";
		let timedOut = false;
		child.stdout.setEncoding("utf8").on("data", (c) => (out += c));
		child.stderr.setEncoding("utf8").on("data", (c) => (err += c));
		const t = timeoutMs !== undefined ? setTimeout(() => {
			timedOut = true;
			try {
				if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch {}
		}, timeoutMs) : undefined;
		child.on("error", (e) => {
			if (t) clearTimeout(t);
			resolve({ code: 255, out, err: String(e), timedOut });
		});
		child.on("close", (code) => {
			if (t) clearTimeout(t);
			resolve({ code: code ?? 255, out, err, timedOut });
		});
		child.stdin.on("error", () => {}); // ssh that exits early (unreachable host) closes stdin; its exit code says why
		child.stdin.end(script);
	});
}

function parseReceipt(text) {
	const line = text.split("\n").find((l) => l.startsWith("{"));
	if (!line) return undefined;
	try {
		return JSON.parse(line);
	} catch {
		return undefined;
	}
}

function show(o, value, human) {
	if (o.json) console.log(JSON.stringify(value));
	else if (human) console.log(human);
}

function receiptLine(r) {
	const extra = r.note ? ` — ${r.note}` : r.reason ? ` — ${r.reason}` : "";
	return `${r.id}: ${r.state}${extra}`;
}

/** The exit status for a receipt we waited for. */
function verdict(r, until) {
	if (!r) return EXIT.timeout;
	if (r.state === "rejected") return EXIT.refused;
	if (r.state === "declined" && until === "done") return EXIT.refused;
	return lb.reached(r.state, until) ? EXIT.ok : EXIT.timeout;
}

async function waitFor(o, box, id, until, timeoutSec) {
	const deadline = Date.now() + timeoutSec * 1000;
	if (!o.host) {
		const root = o.dir ?? lb.defaultRoot();
		for (;;) {
			const r = lb.readReceipt(root, box, id);
			if (r && lb.reached(r.state, until)) return r;
			if (Date.now() >= deadline) return r;
			await sleep(Math.min(500, Math.max(0, deadline - Date.now())));
		}
	}
	// Even timeout 0 may perform one immediate query; a 50 ms scheduling allowance stays within the 1 s cap.
	const remaining = Math.max(50, deadline - Date.now());
	// Remote date has whole-second precision: keep its loop alive past the local hard deadline.
	const remoteSeconds = timeoutSec === 0 ? 0 : Math.ceil(remaining / 1000) + 1;
	const res = await ssh(o.host, lb.shWait(o.dir, box, id, until, remoteSeconds), { timeoutMs: remaining });
	const marker = res.out.split("\n").includes("pi-letterbox-wait");
	if (marker && (res.code === 0 || res.code === 3 || res.timedOut)) return parseReceipt(res.out);
	const detail = res.err.trim().split("\n").slice(-3).join(" ");
	throw new Error(`ssh ${o.host} failed (exit ${res.code}): ${detail || (marker ? "connection failed" : "missing pi-letterbox-wait marker")}`);
}

async function send(o) {
	const [rawBox, ...words] = o._;
	const box = checkBox(rawBox, "send");
	if (o.id !== undefined) checkId(o.id, "send");
	let text = words.length ? words.join(" ") : readStdin();
	if (!text.trim()) throw new Usage("nothing to send: give the text as arguments or on stdin");
	text = text.replace(/\s+$/, "");
	const from = o.from ?? `${userInfo().username}@${hostname()}`;
	const until = o.wait === undefined ? undefined : waitState(o.wait, "wait");
	const letter = lb.makeLetter({ text, id: o.id, from, steer: o.steer, ack: o.ack, ttlSec: o.ttl === undefined ? undefined : seconds(o.ttl, "ttl") });
	let outcome;
	let reader;
	if (o.host) {
		const res = await ssh(o.host, lb.shDrop(o.dir, box, letter), { timeoutMs: 60_000 });
		if (res.code !== 0) throw new Error(`ssh ${o.host} failed (exit ${res.code}): ${res.err.trim().split("\n").slice(-3).join(" ")}`);
		const lines = res.out.split("\n");
		outcome = lines.find((l) => l === "sent" || l === "exists");
		if (!outcome) throw new Error(`unexpected reply from ${o.host}: ${res.out.slice(0, 200)}`);
		const rl = lines.find((l) => l.startsWith("reader "));
		try {
			reader = rl ? JSON.parse(rl.slice(7)) : undefined;
		} catch {}
	} else {
		const root = o.dir ?? lb.defaultRoot();
		outcome = lb.dropLetter(root, box, letter);
		reader = lb.readReader(root, box);
	}
	const where = o.host ? `${o.host}:${box}` : box;
	// A remote reader's pid cannot be checked from here; its heartbeat says whether it is there.
	const live = reader ? (o.host ? Date.now() - Date.parse(reader.beat) < lb.STALE_MS : lb.readerLive(reader)) : false;
	if (!o.json) {
		console.log(outcome === "sent" ? `sent ${letter.id} to ${where}` : `${letter.id} was already sent to ${where}; not sent again`);
		if (!live) console.error(`note: no pi session is reading ${where} now; the letter waits until one opens it`);
	}
	if (!until) {
		show(o, { id: letter.id, box, host: o.host, outcome, reader_live: live });
		return EXIT.ok;
	}
	const r = await waitFor(o, box, letter.id, until, seconds(o.timeout, "timeout", 600));
	const code = verdict(r, until);
	show(o, { id: letter.id, box, host: o.host, outcome, reader_live: live, receipt: r ?? null, reached: code === EXIT.ok },
		r ? receiptLine(r) : `${letter.id}: no receipt yet`);
	return code;
}

async function status(o) {
	const box = checkBox(o._[0], "status");
	const id = checkId(o._[1], "status");
	let r;
	let where;
	if (o.host) {
		const res = await ssh(o.host, lb.shStatus(o.dir, box, id), { timeoutMs: 60_000 });
		if (res.code !== 0) throw new Error(`ssh ${o.host} failed (exit ${res.code}): ${res.err.trim()}`);
		r = parseReceipt(res.out);
		where = res.out.trim();
	} else {
		const root = o.dir ?? lb.defaultRoot();
		r = lb.readReceipt(root, box, id);
		const p = lb.boxPaths(root, box);
		where = existsSync(join(p.new, `${id}.json`)) ? "waiting" : existsSync(join(p.cur, `${id}.json`)) ? "taken" : existsSync(join(p.ids, id)) ? "sending" : "unknown";
	}
	if (r) {
		show(o, r, receiptLine(r));
		return EXIT.ok;
	}
	const state = ["taken", "waiting", "sending"].includes(where) ? where : "unknown";
	show(o, { id, state }, `${id}: ${state === "waiting" ? "waiting for a session to take it" : state}`);
	return state === "unknown" ? EXIT.error : EXIT.ok;
}

async function wait(o) {
	const box = checkBox(o._[0], "wait");
	const id = checkId(o._[1], "wait");
	const until = waitState(o.until ?? "done", "until");
	const r = await waitFor(o, box, id, until, seconds(o.timeout, "timeout", 600));
	const code = verdict(r, until);
	show(o, { receipt: r ?? null, reached: code === EXIT.ok }, r ? receiptLine(r) : `${id}: no receipt yet`);
	return code;
}

async function list(o) {
	let rows;
	if (o.host) {
		const res = await ssh(o.host, lb.shList(o.dir), { timeoutMs: 60_000 });
		if (res.code !== 0) throw new Error(`ssh ${o.host} failed (exit ${res.code}): ${res.err.trim()}`);
		rows = res.out
			.split("\n")
			.filter(Boolean)
			.map((l) => {
				const [box, n, rd] = l.split("\t");
				let reader;
				try {
					reader = rd ? JSON.parse(rd) : undefined;
				} catch {}
				return { box, waiting: Number(n) || 0, reader, live: reader ? Date.now() - Date.parse(reader.beat) < lb.STALE_MS : false };
			});
	} else {
		const root = o.dir ?? lb.defaultRoot();
		rows = lb.listBoxes(root).map((box) => {
			const reader = lb.readReader(root, box);
			return { box, waiting: lb.waiting(root, box).length, reader, live: lb.readerLive(reader) };
		});
	}
	if (o.json) console.log(JSON.stringify(rows));
	else if (!rows.length) console.log("no letterboxes");
	else
		for (const r of rows) {
			const who = r.live ? `read by pid ${r.reader.pid} in ${r.reader.cwd ?? "?"}` : "no reader";
			console.log(`${r.box}\t${r.waiting} waiting\t${who}`);
		}
	return EXIT.ok;
}

async function main(argv) {
	let o;
	try {
		o = parse(argv);
	} catch (e) {
		console.error(`pi-letterbox: ${e.message}\n\n${HELP}`);
		return EXIT.usage;
	}
	const cmd = o._.shift();
	if (o.help || !cmd || cmd === "help") {
		console.log(HELP);
		return cmd || o.help ? EXIT.ok : EXIT.usage;
	}
	const run = { send, status, wait, list }[cmd];
	if (!run) {
		console.error(`pi-letterbox: unknown command ${cmd}\n\n${HELP}`);
		return EXIT.usage;
	}
	try {
		return await run(o);
	} catch (e) {
		console.error(`pi-letterbox: ${e.message}`);
		return e instanceof Usage ? EXIT.usage : EXIT.error;
	}
}

process.exitCode = await main(process.argv.slice(2));
