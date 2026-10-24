// The pi-letterbox protocol (v1): plain files in a directory, so anything that can write a file can send a letter,
// locally or over ssh with nothing but /bin/sh on the far side. Shared by the extension and the CLI; no dependencies.
//
//   <root>/<box>/tmp/            senders write a letter here first
//   <root>/<box>/new/<id>.json   letters waiting for the session (renamed from tmp/, so never seen half-written)
//   <root>/<box>/cur/<id>.json   taken letters not yet in a conversation
//   <root>/<box>/seen/<id>.json  archived read or rejected letters
//   <root>/<box>/ids/<id>       permanent send claim, created exclusively (O_EXCL / sh noclobber)
//   <root>/<box>/leases/<token>.json runtime heartbeat, even after reader takeover
//   <root>/<box>/locks/<name>/  short node locks (one owner-<nonce> file, installed by directory rename)
//   <root>/<box>/receipts/<id>.json   the letter's latest receipt, replaced atomically
//   <root>/<box>/reader.json     the session reading this box, with a heartbeat
//
// Senders claim ids/ and write tmp/ and new/; readers manage delivery, archives, receipts and runtime ownership.

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join } from "node:path";

export const VERSION = 1;
/** Largest letter text, in UTF-8 bytes. A brief fits; send a path for anything bigger. */
export const MAX_TEXT_BYTES = 64 * 1024;
/** Largest letter file the reader will open. */
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_NOTE_CHARS = 4000;
export const MAX_FROM_CHARS = 120;
/** Box names; "bin" is reserved for the CLI shim. */
export const BOX_RE = /^(?!bin$)[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** A reader whose heartbeat is older than this is gone (used when its pid cannot be checked). */
export const STALE_MS = 90_000;

/** Receipt states in the order a letter moves through them. done, declined and rejected are final. */
export const RANK = Object.freeze({ delivered: 1, read: 2, done: 3, declined: 3, rejected: 3 });
/** What `--wait` accepts: the receipt to wait for. */
export const WAIT_STATES = Object.freeze(["delivered", "read", "done"]);

/**
 * @typedef {{ v: 1, id: string, text: string, from?: string, delivery?: "queue" | "steer", ack?: boolean,
 *   created_at: string, expires_at?: string }} Letter
 * @typedef {{ v: 1, state: keyof typeof RANK, id: string, box: string, at: Record<string, string>,
 *   from?: string, session_id?: string, session_file?: string, host?: string, pid?: number, note?: string,
 *   reason?: string, delivery?: string, token?: string, attempts?: number, requeued_at?: string }} Receipt
 * @typedef {{ v: 1, token: string, pid: number, host: string, session_id?: string, session_file?: string, cwd?: string,
 *   since: string, beat: string }} Reader
 */

/** The letterbox root: $PI_LETTERBOX_DIR, else <pi agent dir>/letterbox. */
export function defaultRoot(env = process.env) {
	if (env.PI_LETTERBOX_DIR) return env.PI_LETTERBOX_DIR;
	return join(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "letterbox");
}

/** The same default, as a /bin/sh expression evaluated on the far side of ssh. */
export const REMOTE_ROOT_EXPR = '${PI_LETTERBOX_DIR:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/letterbox}';

/** @param {string} root @param {string} box */
export function boxPaths(root, box) {
	if (!BOX_RE.test(box)) throw new Error(`invalid box name ${JSON.stringify(box)}: use letters, digits, ".", "_" and "-"`);
	const dir = join(root, box);
	return {
		dir,
		tmp: join(dir, "tmp"),
		new: join(dir, "new"),
		cur: join(dir, "cur"),
		seen: join(dir, "seen"),
		ids: join(dir, "ids"),
		leases: join(dir, "leases"),
		locks: join(dir, "locks"),
		receipts: join(dir, "receipts"),
		reader: join(dir, "reader.json"),
	};
}

/** Create the box (and the root) private to this user. */
export function ensureBox(root, box) {
	const p = boxPaths(root, box);
	for (const d of [root, p.dir, p.tmp, p.new, p.cur, p.seen, p.ids, p.leases, p.locks, p.receipts]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
	return p;
}

/** A sortable, unique id: UTC time plus randomness. */
export function newId(now = new Date()) {
	const t = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
	return `${t}-${randomBytes(4).toString("hex")}`;
}

export function utf8Bytes(s) {
	return Buffer.byteLength(s, "utf8");
}

/** One line, bounded: a label is for display, never for structure. */
export function cleanLabel(s, max = MAX_FROM_CHARS) {
	const one = String(s).replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
	return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/**
 * @param {{ text: string, id?: string, from?: string, steer?: boolean, ack?: boolean, ttlSec?: number, now?: Date }} o
 * @returns {Letter}
 */
export function makeLetter(o) {
	const now = o.now ?? new Date();
	const id = o.id ?? newId(now);
	/** @type {Letter} */
	const letter = { v: VERSION, id, text: o.text, created_at: now.toISOString() };
	if (o.from) letter.from = cleanLabel(o.from);
	if (o.steer) letter.delivery = "steer";
	if (o.ack === false) letter.ack = false;
	if (o.ttlSec !== undefined) letter.expires_at = new Date(now.getTime() + o.ttlSec * 1000).toISOString();
	const problem = checkLetter(letter, id);
	if (problem) throw new Error(problem);
	return letter;
}

/** Why a parsed letter is unusable, or undefined. `stem` is its file name without ".json". */
export function checkLetter(x, stem) {
	if (!x || typeof x !== "object" || Array.isArray(x)) return "not a JSON object";
	if (x.v !== VERSION) return `unsupported version ${JSON.stringify(x.v)} (this reader speaks v${VERSION})`;
	if (typeof x.id !== "string" || !ID_RE.test(x.id)) return "missing or invalid id";
	if (stem !== undefined && x.id !== stem) return `id ${x.id} does not match the file name ${stem}.json`;
	if (typeof x.text !== "string" || !x.text.trim()) return "missing text";
	if (utf8Bytes(x.text) > MAX_TEXT_BYTES) return `text is larger than ${MAX_TEXT_BYTES} bytes`;
	if (x.from !== undefined && typeof x.from !== "string") return "from must be a string";
	if (x.delivery !== undefined && x.delivery !== "queue" && x.delivery !== "steer") return "delivery must be queue or steer";
	if (x.ack !== undefined && typeof x.ack !== "boolean") return "ack must be a boolean";
	if (typeof x.created_at !== "string" || Number.isNaN(Date.parse(x.created_at))) return "missing or invalid created_at";
	if (x.expires_at !== undefined && (typeof x.expires_at !== "string" || Number.isNaN(Date.parse(x.expires_at))))
		return "invalid expires_at";
	return undefined;
}

/** Write a whole file or nothing: a temporary sibling, then rename. */
export function writeAtomic(file, data, mode = 0o600) {
	const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
	fs.writeFileSync(tmp, data, { mode, flag: "wx" });
	try {
		fs.renameSync(tmp, file);
	} catch (e) {
		fs.rmSync(tmp, { force: true });
		throw e;
	}
}

function readJson(file, maxBytes = MAX_FILE_BYTES) {
	let st;
	try {
		st = fs.statSync(file);
	} catch {
		return undefined;
	}
	if (!st.isFile() || st.size > maxBytes) return undefined;
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

/** A lock owner older than this may be broken, even if its process is alive. */
export const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5000;
const LOCK_SWEEP_MS = 60_000;
const lockSwept = new Map();
const lockSleep = new Int32Array(new SharedArrayBuffer(4));

/** Remove temp/dead lock leftovers of crashed processes, at most every 10 s per box. */
function sweepLocks(locks, now) {
	if (now - (lockSwept.get(locks) ?? 0) < 10_000) return;
	lockSwept.set(locks, now);
	let names;
	try { names = fs.readdirSync(locks); } catch { return; }
	for (const n of names) {
		if (!n.startsWith(".t-") && !n.startsWith(".dead-")) continue;
		const f = join(locks, n);
		try {
			// ctime: rename updates it, so a just-moved .dead file is not mistaken for an old one.
			if (now - fs.lstatSync(f).ctimeMs > LOCK_SWEEP_MS) fs.rmSync(f, { recursive: true, force: true });
		} catch {}
	}
}

/** Whether a lock owner file describes a dead or stale holder. */
function lockOwnerStale(file, now) {
	let o;
	try { o = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { if (e.code === "ENOENT") return false; }
	if (o && typeof o === "object" && Number.isFinite(o.time)) {
		if (o.host === hostname() && Number.isInteger(o.pid) && !pidAlive(o.pid)) return true;
		return now - o.time > LOCK_STALE_MS;
	}
	try { return now - fs.statSync(file).mtimeMs > LOCK_STALE_MS; } catch { return false; } // unreadable owner
}

/**
 * Short, synchronous cross-process lock at `locks/<name>/`, holding exactly one `owner-<nonce>` file.
 * Acquire: build `locks/.t-<nonce>/owner-<nonce>` and rename the directory onto `locks/<name>`; that succeeds
 * only when the target is absent or empty. Release: unlink our owner file, then rmdir (ignoring ENOTEMPTY).
 * Break (owner pid dead on this host, or owner time older than 10 s): rename that exact `owner-<nonce>` file
 * away; the nonce binds identity, so a breaker can never move a newer holder's lock. A holder stalled for
 * more than 10 s inside `fn` can be broken and then loses mutual exclusion; its release is then a no-op.
 */
export function withLock(root, box, name, fn) {
	if (name !== "reader" && !(name.startsWith("r.") && ID_RE.test(name.slice(2)))) throw new Error("invalid lock name");
	const locks = ensureBox(root, box).locks;
	const dir = join(locks, name);
	const end = Date.now() + LOCK_WAIT_MS;
	sweepLocks(locks, Date.now());
	let mine;
	for (;;) {
		const nonce = `${process.pid}-${randomBytes(8).toString("hex")}`;
		const tmp = join(locks, `.t-${nonce}`);
		fs.mkdirSync(tmp, { mode: 0o700 });
		try {
			fs.writeFileSync(join(tmp, `owner-${nonce}`), JSON.stringify({ pid: process.pid, host: hostname(), time: Date.now() }), { mode: 0o600, flag: "wx" });
			fs.renameSync(tmp, dir);
			mine = `owner-${nonce}`;
			break;
		} catch (e) {
			fs.rmSync(tmp, { recursive: true, force: true });
			if (e.code !== "EEXIST" && e.code !== "ENOTEMPTY") throw e;
		}
		if (breakStaleLock(locks, dir)) continue;
		if (Date.now() >= end) throw new Error(`timed out acquiring lock ${name}`);
		Atomics.wait(lockSleep, 0, 0, 5 + Math.floor(Math.random() * 16));
	}
	try {
		return fn();
	} finally {
		releaseLock(dir, mine);
	}

	function releaseLock(d, owner) {
		try {
			fs.unlinkSync(join(d, owner));
		} catch (e) {
			if (e.code === "ENOENT") return; // broken while held: never touch the new holder's directory
			throw e;
		}
		try { fs.rmdirSync(d); } catch (e) { if (e.code !== "ENOTEMPTY" && e.code !== "ENOENT" && e.code !== "EEXIST") throw e; }
	}
}

/** Break the observed owner of `dir` if it is dead or stale. Returns true when the caller should retry at once. */
function breakStaleLock(locks, dir) {
	let owners;
	// "owner" is the round-1 (mkdir lock) owner file of a crashed holder; this protocol never creates it.
	try { owners = fs.readdirSync(dir).filter((n) => n.startsWith("owner-") || n === "owner"); } catch (e) { return e.code === "ENOENT"; }
	const now = Date.now();
	for (const n of owners) {
		if (!lockOwnerStale(join(dir, n), now)) continue;
		const dead = join(locks, `.dead-${process.pid}-${randomBytes(8).toString("hex")}`);
		try {
			fs.renameSync(join(dir, n), dead);
		} catch (e) {
			if (e.code === "ENOENT") return true; // someone else broke or released it first
			throw e;
		}
		try { fs.rmdirSync(dir); } catch (e) { if (e.code !== "ENOTEMPTY" && e.code !== "ENOENT" && e.code !== "EEXIST") throw e; }
		fs.rmSync(dead, { force: true });
		return true;
	}
	return false;
}

/** Whether a letter with this id was ever sent to the box (waiting, taken, archived, or with a receipt). */
export function known(root, box, id) {
	const p = boxPaths(root, box);
	return [join(p.new, `${id}.json`), join(p.cur, `${id}.json`), join(p.seen, `${id}.json`), join(p.receipts, `${id}.json`)].some((f) => fs.existsSync(f));
}

/**
 * Drop a letter into a local box. Idempotent by id: a letter already sent is not sent again.
 * @param {string} root @param {string} box @param {Letter} letter
 * @returns {"sent" | "exists"}
 */
export function dropLetter(root, box, letter) {
	if (!ID_RE.test(letter.id)) throw new Error("invalid letter id");
	const p = ensureBox(root, box);
	// The claim is a file created with O_EXCL, like the shell's noclobber `>` in shDrop. Not a directory:
	// mkdir(1) is not exclusive everywhere (uutils coreutils 0.10, Ubuntu 26.04, lets two racing mkdirs succeed).
	// An ids/<id>/ directory left by an earlier build also fails with EEXIST.
	try {
		fs.closeSync(fs.openSync(join(p.ids, letter.id), "wx", 0o600));
	} catch (e) {
		if (e.code === "EEXIST") return "exists";
		throw e;
	}
	if (known(root, box, letter.id)) return "exists";
	const tmp = join(p.tmp, `${letter.id}.${process.pid}.${randomBytes(8).toString("hex")}.json`);
	fs.writeFileSync(tmp, `${JSON.stringify(letter)}\n`, { mode: 0o600, flag: "wx" });
	fs.renameSync(tmp, join(p.new, `${letter.id}.json`));
	return "sent";
}

/** @returns {Receipt | undefined} */
export function readReceipt(root, box, id) {
	if (!ID_RE.test(id)) return undefined;
	const r = readJson(join(boxPaths(root, box).receipts, `${id}.json`));
	return r && typeof r === "object" && typeof r.state === "string" ? r : undefined;
}

/**
 * Advance a letter's receipt under its lock. Lower rank is unchanged; final states cannot change outcome.
 * Same final state only updates note. Delivery attempts merge fields while keeping the first reached time.
 * "state" is written first so a /bin/sh reader can match `"state":"…"` on one line.
 * @param {string} root @param {string} box @param {string} id
 * @param {Partial<Receipt> & { state: keyof typeof RANK }} patch
 * @returns {Receipt}
 */
export function writeReceipt(root, box, id, patch, now = new Date()) {
	return withLock(root, box, `r.${id}`, () => writeReceiptUnlocked(root, box, id, patch, now));
}

function writeReceiptUnlocked(root, box, id, patch, now = new Date()) {
	const p = ensureBox(root, box);
	const prev = readReceipt(root, box, id);
	const { state, ...fields } = patch;
	const prevRank = prev ? (RANK[prev.state] ?? 0) : 0;
	if ((RANK[state] ?? 0) < prevRank) return prev;
	if (prevRank === 3) {
		if (state !== prev.state) throw new Error(`letter ${id} is already ${prev.state}`);
		const next = { ...prev, ...(fields.note !== undefined ? { note: fields.note } : {}) };
		writeAtomic(join(p.receipts, `${id}.json`), `${JSON.stringify(next)}\n`);
		return next;
	}
	const at = { ...(prev?.at ?? {}) };
	if (!at[state]) at[state] = now.toISOString();
	const { state: _old, ...rest } = prev ?? {};
	/** @type {Receipt} */
	const next = { state, ...rest, ...fields, v: VERSION, id, box, at };
	writeAtomic(join(p.receipts, `${id}.json`), `${JSON.stringify(next)}\n`);
	return next;
}

/** Whether `state` is at or past `until` (any final state counts as past everything). */
export function reached(state, until) {
	return (RANK[state] ?? 0) >= (RANK[until] ?? 99);
}

/** Letters waiting in new/, oldest first. Names only; nothing is read. */
export function waiting(root, box) {
	let names;
	try {
		names = fs.readdirSync(boxPaths(root, box).new);
	} catch {
		return [];
	}
	const p = boxPaths(root, box);
	return names
		.filter((n) => n.endsWith(".json") && !n.startsWith("."))
		.map((n) => {
			let t = 0;
			try {
				t = fs.statSync(join(p.new, n)).mtimeMs;
			} catch {}
			return { n, t };
		})
		.sort((a, b) => a.t - b.t || (a.n < b.n ? -1 : a.n > b.n ? 1 : 0))
		.map((x) => x.n);
}

/**
 * Take one waiting letter: read it, then move it to cur/ so no other reader takes it.
 * Returns the letter, a rejection to receipt, or undefined when it is gone (taken elsewhere).
 * @returns {{ letter: Letter } | { rejected: { id?: string, reason: string } } | undefined}
 */
export function takeLetter(root, box, name, now = Date.now()) {
	const p = boxPaths(root, box);
	const from = join(p.new, name);
	const stem = name.replace(/\.json$/, "");
	const dest = join(p.cur, ID_RE.test(stem) ? `${stem}.json` : `${stem}.invalid`);
	let raw;
	try {
		const st = fs.statSync(from);
		raw = st.size > MAX_FILE_BYTES ? undefined : fs.readFileSync(from, "utf8");
	} catch {
		return undefined;
	}
	try {
		fs.renameSync(from, dest);
	} catch {
		return undefined;
	}
	const id = ID_RE.test(stem) ? stem : undefined;
	const reject = (reason) => {
		fs.renameSync(dest, join(p.seen, basename(dest)));
		return { rejected: { id, reason } };
	};
	if (raw === undefined) return reject(`letter file is larger than ${MAX_FILE_BYTES} bytes`);
	let x;
	try {
		x = JSON.parse(raw);
	} catch {
		return reject("not valid JSON");
	}
	const problem = checkLetter(x, stem);
	if (problem) return reject(problem);
	if (x.expires_at && Date.parse(x.expires_at) < now) return reject(`expired at ${x.expires_at}`);
	return { letter: x };
}

/** Put a taken letter back (delivery could not happen now). */
export function untakeLetter(root, box, id) {
	const p = boxPaths(root, box);
	try {
		fs.renameSync(join(p.cur, `${id}.json`), join(p.new, `${id}.json`));
	} catch {}
}

/** @returns {Reader | undefined} */
export function readReader(root, box) {
	const r = readJson(boxPaths(root, box).reader, 64 * 1024);
	return r && typeof r === "object" && typeof r.pid === "number" ? r : undefined;
}

export function pidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return /** @type {NodeJS.ErrnoException} */ (e).code === "EPERM";
	}
}

/** Fresh beat AND live pid on this host; foreign pids are never probed locally. */
export function readerLive(r, now = Date.now(), host = hostname()) {
	if (!r || typeof r.beat !== "string" || !Number.isFinite(Date.parse(r.beat))) return false;
	return now - Date.parse(r.beat) < STALE_MS && (r.host !== host || pidAlive(r.pid));
}

/** @param {Reader} me */
export function sameReader(r, me) {
	return !!r && typeof me.token === "string" && r.token === me.token;
}

function writeReaderUnlocked(root, box, me) {
	writeAtomic(ensureBox(root, box).reader, `${JSON.stringify(me)}\n`);
}

export function writeReader(root, box, me) {
	return withLock(root, box, "reader", () => writeReaderUnlocked(root, box, me));
}

/** Claim a reader atomically; return the live owner when busy. */
export function claimReader(root, box, me, take = false) {
	return withLock(root, box, "reader", () => {
		const prev = readReader(root, box);
		if (!take && readerLive(prev) && !sameReader(prev, me)) return prev;
		writeReaderUnlocked(root, box, me);
		return undefined;
	});
}

export function beatReader(root, box, me) {
	return withLock(root, box, "reader", () => {
		const prev = readReader(root, box);
		if (prev && !sameReader(prev, me)) return false;
		writeReaderUnlocked(root, box, me);
		return true;
	});
}

/** Remove reader.json if it is still ours, without a check/delete race. */
export function releaseReader(root, box, me) {
	return withLock(root, box, "reader", () => {
		if (sameReader(readReader(root, box), me)) fs.rmSync(boxPaths(root, box).reader, { force: true });
	});
}

export function writeLease(root, box, me) {
	writeAtomic(join(ensureBox(root, box).leases, `${me.token}.json`), `${JSON.stringify(me)}\n`);
}

export function releaseLease(root, box, token) {
	fs.rmSync(join(boxPaths(root, box).leases, `${token}.json`), { force: true });
}

function archive(root, box, id) {
	const p = boxPaths(root, box);
	try { fs.renameSync(join(p.cur, `${id}.json`), join(p.seen, `${id}.json`)); }
	catch (e) { if (e.code !== "ENOENT") throw e; }
}

/** Pi stores custom_message entries; also accept an enveloped custom message. Ignore corrupt JSONL lines. */
export function sessionContains(file, box, id) {
	if (!file) return false;
	let text;
	try { text = fs.readFileSync(file, "utf8"); } catch { return false; }
	return text.split("\n").some((line) => {
		try {
			const entry = JSON.parse(line);
			const m = entry.type === "custom_message" ? entry : entry.message;
			return !!m && (entry.type === "custom_message" || m.role === "custom") && m.customType === "letterbox" && m.details?.id === id && m.details?.box === box;
		} catch { return false; }
	});
}

/** Read receipt and archive are one receipt-locked operation. */
export function markRead(root, box, id) {
	return withLock(root, box, `r.${id}`, () => {
		const r = readReceipt(root, box, id);
		if (r && (RANK[r.state] ?? 0) < RANK.read) writeReceiptUnlocked(root, box, id, { state: "read" });
		archive(root, box, id);
	});
}

/** Recover only cur/*.json; state never goes backwards when bytes are requeued. `runtime.inflight` is keyed `${box}/${id}`. */
export function recoverLetters(root, box, runtime, now = Date.now()) {
	const p = ensureBox(root, box);
	for (const name of fs.readdirSync(p.leases)) {
		if (!name.endsWith(".json")) continue;
		const file = join(p.leases, name);
		const lease = readJson(file);
		if (readerLive(lease, now)) continue;
		let beat = Date.parse(lease?.beat);
		if (!Number.isFinite(beat)) {
			try { beat = fs.statSync(file).mtimeMs; } catch { continue; }
		}
		if (now - beat > 24 * 60 * 60 * 1000) fs.rmSync(file, { force: true });
	}
	for (const name of fs.readdirSync(p.cur)) {
		if (!name.endsWith(".json")) continue;
		const id = name.slice(0, -5);
		if (!ID_RE.test(id)) continue;
		withLock(root, box, `r.${id}`, () => {
			const file = join(p.cur, name);
			if (!fs.existsSync(file)) return;
			const r = readReceipt(root, box, id);
			if (r && RANK[r.state] >= RANK.read) { archive(root, box, id); return; }
			if (!r) {
				if (now - fs.statSync(file).mtimeMs <= 30_000) return;
			} else if (r.state === "delivered") {
				if (r.token === runtime.token) {
					const flight = runtime.inflight.get(`${box}/${id}`);
					if (!flight || now - flight.deliveredAt <= 10_000 || !runtime.isIdle() || runtime.hasPendingMessages() || sessionContains(runtime.session_file, box, id)) return;
				} else {
					if (r.token && readerLive(readJson(join(p.leases, `${r.token}.json`)), now)) return;
					if (sessionContains(r.session_file, box, id)) {
						writeReceiptUnlocked(root, box, id, { state: "read" });
						archive(root, box, id);
						return;
					}
				}
			} else return;
			if ((r?.attempts ?? 0) >= 3) {
				writeReceiptUnlocked(root, box, id, { state: "rejected", reason: "not delivered after 3 attempts" });
				archive(root, box, id);
			} else {
				fs.renameSync(file, join(p.new, name));
				// A no-receipt orphan remains without a receipt until delivery; no backwards state is invented.
				if (r) writeReceiptUnlocked(root, box, id, { state: "delivered", requeued_at: new Date(now).toISOString() });
			}
			runtime.inflight.delete(`${box}/${id}`);
		});
	}
}

/** Session ownership is rechecked under the same lock that commits the final receipt. */
export function doneReceipt(root, box, id, sessionId, outcome, note) {
	return withLock(root, box, `r.${id}`, () => {
		const r = readReceipt(root, box, id);
		if (!r || r.session_id !== sessionId || !["delivered", "read", "done", "declined"].includes(r.state)) throw new Error(`no letter ${id} reached this session`);
		return writeReceiptUnlocked(root, box, id, { state: outcome, ...(note !== undefined ? { note } : {}) });
	});
}

/** The boxes under a root. */
export function listBoxes(root) {
	try {
		return fs
			.readdirSync(root, { withFileTypes: true })
			.filter((d) => d.isDirectory() && BOX_RE.test(d.name))
			.map((d) => d.name)
			.sort();
	} catch {
		return [];
	}
}

/** Recent receipts of a box, newest first. */
export function recentReceipts(root, box, limit = 10) {
	const dir = boxPaths(root, box).receipts;
	let names;
	try {
		names = fs.readdirSync(dir).filter((n) => n.endsWith(".json") && !n.startsWith("."));
	} catch {
		return [];
	}
	return names
		.map((n) => ({ n, t: fs.statSync(join(dir, n)).mtimeMs }))
		.sort((a, b) => b.t - a.t)
		.slice(0, limit)
		.map((x) => readJson(join(dir, x.n)))
		.filter(Boolean);
}

/** The text the model reads. The receipt footer appears only when the sender asked for one. */
export function formatForModel(letter, box, tool = "letterbox_done") {
	const from = letter.from ? ` from ${letter.from}` : "";
	const head = `Letter ${letter.id} in letterbox "${box}"${from}:`;
	const foot =
		letter.ack === false
			? ""
			: `\n\n(The sender is waiting for a receipt: when you have handled this letter, call ${tool} with id "${letter.id}"; use outcome "declined" with a note if you will not do it.)`;
	return `${head}\n\n${letter.text}${foot}`;
}

// ---------------------------------------------------------------------------------------------------------------
// The same operations as /bin/sh scripts, for a box on another host (`ssh host sh -s` reads the script on stdin).

/** Single-quote for /bin/sh. */
export function shq(s) {
	return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function rootLine(root) {
	return `r=${root === undefined ? `"${REMOTE_ROOT_EXPR}"` : shq(root)}`;
}

/** Drop a letter on the far side. Prints "sent" or "exists", then the reader line (if any). */
export function shDrop(root, box, letter) {
	if (!BOX_RE.test(box) || !ID_RE.test(letter.id)) throw new Error("invalid box or id");
	const body = JSON.stringify(letter);
	let eof = `PI_LETTERBOX_EOF_${randomBytes(6).toString("hex")}`;
	while (body.includes(eof)) eof = `PI_LETTERBOX_EOF_${randomBytes(6).toString("hex")}`;
	const id = letter.id;
	return [
		"set -e",
		"umask 077",
		rootLine(root),
		`d="$r/${box}"`,
		'mkdir -p "$d/tmp" "$d/new" "$d/cur" "$d/receipts" "$d/ids" "$d/seen" "$d/leases" "$d/locks"',
		// noclobber `>` opens with O_EXCL in dash, bash, zsh and BusyBox ash; mkdir(1) is not exclusive everywhere.
		`if ! (set -C; : > "$d/ids/${id}") 2>/dev/null; then echo exists;`,
		`elif [ -e "$d/new/${id}.json" ] || [ -e "$d/cur/${id}.json" ] || [ -e "$d/seen/${id}.json" ] || [ -e "$d/receipts/${id}.json" ]; then echo exists; else`,
		`t="$d/tmp/${id}.$$.${randomBytes(8).toString("hex")}.json"`,
		`cat > "$t" <<'${eof}'`,
		body,
		eof,
		`mv "$t" "$d/new/${id}.json"`,
		"echo sent",
		"fi",
		'if [ -f "$d/reader.json" ]; then printf "reader "; cat "$d/reader.json"; fi',
		"",
	].join("\n");
}

/** Print the receipt (or "waiting" / "unknown") of a letter on the far side. */
export function shStatus(root, box, id) {
	if (!BOX_RE.test(box) || !ID_RE.test(id)) throw new Error("invalid box or id");
	return [
		rootLine(root),
		`d="$r/${box}"`,
		`if [ -f "$d/receipts/${id}.json" ]; then cat "$d/receipts/${id}.json"`,
		`elif [ -f "$d/new/${id}.json" ]; then echo waiting`,
		`elif [ -f "$d/cur/${id}.json" ]; then echo taken`,
		`elif [ -e "$d/ids/${id}" ]; then echo sending`,
		"else echo unknown; fi",
		"",
	].join("\n");
}

/**
 * Wait on the far side until the receipt reaches `until`, then print it. Exit 0 when reached, 3 on timeout
 * (printing the latest receipt, if any). One connection for the whole wait.
 */
export function shWait(root, box, id, until, timeoutSec, intervalSec = 2) {
	if (!BOX_RE.test(box) || !ID_RE.test(id)) throw new Error("invalid box or id");
	const want = Object.keys(RANK).filter((s) => reached(s, until));
	return [
		"echo pi-letterbox-wait",
		rootLine(root),
		`f="$r/${box}/receipts/${id}.json"`,
		`end=$(( $(date +%s) + ${Math.max(0, Math.floor(timeoutSec))} ))`,
		"while :; do",
		'  if [ -f "$f" ]; then',
		`    s=$(sed -n 's/^{"state":"\\([a-z]*\\)".*/\\1/p' "$f" | head -n 1)`,
		`    case " ${want.join(" ")} " in *" $s "*) cat "$f"; exit 0;; esac`,
		"  fi",
		'  if [ "$(date +%s)" -ge "$end" ]; then [ -f "$f" ] && cat "$f"; exit 3; fi',
		`  sleep ${intervalSec}`,
		"done",
		"",
	].join("\n");
}

/** List boxes on the far side: one "box<TAB>waiting<TAB>reader-json" line each. */
export function shList(root) {
	return [
		rootLine(root),
		'[ -d "$r" ] || exit 0',
		'for d in "$r"/*/; do',
		'  [ -d "$d/new" ] || continue',
		'  b=$(basename "$d")',
		'  n=$(ls "$d/new" 2>/dev/null | grep -c "\\.json$" || true)',
		'  if [ -f "$d/reader.json" ]; then rd=$(tr -d "\\n" < "$d/reader.json"); else rd=""; fi',
		'  printf "%s\\t%s\\t%s\\n" "$b" "$n" "$rd"',
		"done",
		"",
	].join("\n");
}
