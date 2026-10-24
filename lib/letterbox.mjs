// The pi-letterbox protocol (v1): plain files in a directory, so anything that can write a file can send a letter,
// locally or over ssh with nothing but /bin/sh on the far side. Shared by the extension and the CLI; no dependencies.
//
//   <root>/<box>/tmp/            senders write a letter here first
//   <root>/<box>/new/<id>.json   letters waiting for the session (renamed from tmp/, so never seen half-written)
//   <root>/<box>/cur/<id>.json   letters the session has taken
//   <root>/<box>/receipts/<id>.json   the letter's latest receipt, replaced atomically
//   <root>/<box>/reader.json     the session reading this box, with a heartbeat
//
// Senders only write tmp/ and new/; the reading session only writes cur/, receipts/ and reader.json.

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
 *   reason?: string, delivery?: string }} Receipt
 * @typedef {{ v: 1, pid: number, host: string, session_id?: string, session_file?: string, cwd?: string,
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
		receipts: join(dir, "receipts"),
		reader: join(dir, "reader.json"),
	};
}

/** Create the box (and the root) private to this user. */
export function ensureBox(root, box) {
	const p = boxPaths(root, box);
	for (const d of [root, p.dir, p.tmp, p.new, p.cur, p.receipts]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
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

/** Whether a letter with this id was ever sent to the box (waiting, taken, or with a receipt). */
export function known(root, box, id) {
	const p = boxPaths(root, box);
	return [join(p.new, `${id}.json`), join(p.cur, `${id}.json`), join(p.receipts, `${id}.json`)].some((f) => fs.existsSync(f));
}

/**
 * Drop a letter into a local box. Idempotent by id: a letter already sent is not sent again.
 * @param {string} root @param {string} box @param {Letter} letter
 * @returns {"sent" | "exists"}
 */
export function dropLetter(root, box, letter) {
	const p = ensureBox(root, box);
	if (known(root, box, letter.id)) return "exists";
	const tmp = join(p.tmp, `${letter.id}.json`);
	fs.writeFileSync(tmp, `${JSON.stringify(letter)}\n`, { mode: 0o600 });
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
 * Advance a letter's receipt. A state never moves backwards; each state keeps the time it was first reached;
 * other fields are merged. "state" is written first so a /bin/sh reader can match `"state":"…"` on one line.
 * @param {string} root @param {string} box @param {string} id
 * @param {Partial<Receipt> & { state: keyof typeof RANK }} patch
 * @returns {Receipt}
 */
export function writeReceipt(root, box, id, patch, now = new Date()) {
	const p = ensureBox(root, box);
	const prev = readReceipt(root, box, id);
	const { state, ...fields } = patch;
	const prevRank = prev ? (RANK[prev.state] ?? 0) : 0;
	const advance = (RANK[state] ?? 0) >= prevRank;
	const at = { ...(prev?.at ?? {}) };
	if (advance && !at[state]) at[state] = now.toISOString();
	const { state: _old, ...rest } = prev ?? {};
	/** @type {Receipt} */
	const next = { state: advance || !prev ? state : prev.state, ...rest, ...(advance ? fields : {}), v: VERSION, id, box, at };
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
	if (raw === undefined) return { rejected: { id, reason: `letter file is larger than ${MAX_FILE_BYTES} bytes` } };
	let x;
	try {
		x = JSON.parse(raw);
	} catch {
		return { rejected: { id, reason: "not valid JSON" } };
	}
	const problem = checkLetter(x, stem);
	if (problem) return { rejected: { id, reason: problem } };
	if (x.expires_at && Date.parse(x.expires_at) < now) return { rejected: { id, reason: `expired at ${x.expires_at}` } };
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

/** Whether a reader is still there: same host, its process is alive; another host, its heartbeat is recent. */
export function readerLive(r, now = Date.now(), host = hostname()) {
	if (!r) return false;
	if (r.host === host) return pidAlive(r.pid);
	return now - Date.parse(r.beat) < STALE_MS;
}

/** @param {Reader} me */
export function sameReader(r, me) {
	return !!r && r.pid === me.pid && r.host === me.host && r.since === me.since;
}

export function writeReader(root, box, me) {
	writeAtomic(ensureBox(root, box).reader, `${JSON.stringify(me)}\n`);
}

/** Remove reader.json if it is still ours. */
export function releaseReader(root, box, me) {
	if (sameReader(readReader(root, box), me)) fs.rmSync(boxPaths(root, box).reader, { force: true });
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
		'mkdir -p "$d/tmp" "$d/new" "$d/cur" "$d/receipts"',
		`if [ -e "$d/new/${id}.json" ] || [ -e "$d/cur/${id}.json" ] || [ -e "$d/receipts/${id}.json" ]; then echo exists; else`,
		`cat > "$d/tmp/${id}.json" <<'${eof}'`,
		body,
		eof,
		`mv "$d/tmp/${id}.json" "$d/new/${id}.json"`,
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
