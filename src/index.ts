/**
 * pi-letterbox: a letterbox for a running pi session. Anything that can write a file (a script, cron, CI, another
 * machine over ssh) drops a letter; the session reads it at a safe point and receipts come back: delivered, read,
 * and done or declined when the agent says so.
 *
 * A session reads a box only when told to: `pi --letterbox <name>`, `PI_LETTERBOX=<name>`, or `/letterbox open
 * <name>` (remembered by the session, so `pi -c` reopens it). The file protocol lives in lib/letterbox.mjs.
 */
import { chmodSync, existsSync, type FSWatcher, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as lb from "../lib/letterbox.mjs";

const ENTRY = "pi-letterbox";
const MESSAGE = "letterbox";
const TOOL = "letterbox_done";
const STATUS = "letterbox";
const SCAN_MS = 2000;
const BEAT_MS = 15_000;
const CLI = fileURLToPath(new URL("../bin/pi-letterbox.mjs", import.meta.url));

interface LetterDetails {
	id: string;
	box: string;
	from?: string;
	ack?: boolean;
}

type Reader = { v: 1; pid: number; host: string; session_id?: string; session_file?: string; cwd?: string; since: string; beat: string };

export default function piLetterbox(pi: ExtensionAPI): void {
	pi.registerFlag("letterbox", { description: "Read this letterbox in this session (see /letterbox)", type: "string" });

	let ctx: ExtensionContext | undefined;
	let root = lb.defaultRoot();
	let box: string | undefined; // the box this session wants to read
	let me: Reader | undefined; // set while this session is the box's reader
	let watcher: FSWatcher | undefined;
	let scanTimer: ReturnType<typeof setInterval> | undefined;
	let beatTimer: ReturnType<typeof setInterval> | undefined;
	let kick: ReturnType<typeof setTimeout> | undefined;
	let draining = false;
	const opened = new Set<string>(); // boxes this runtime has read, for receipts after a switch

	const status = (text: string | undefined) => {
		if (ctx?.hasUI) ctx.ui.setStatus(STATUS, text);
	};
	const notify = (text: string, level: "info" | "warning" | "error" = "info") => {
		if (ctx?.hasUI) ctx.ui.notify(text, level);
	};

	const setToolActive = (on: boolean) => {
		const active = pi.getActiveTools();
		const has = active.includes(TOOL);
		if (on && !has) pi.setActiveTools([...active, TOOL]);
		else if (!on && has) pi.setActiveTools(active.filter((t) => t !== TOOL));
	};

	function stopReading(): void {
		watcher?.close();
		watcher = undefined;
		if (scanTimer) clearInterval(scanTimer);
		if (beatTimer) clearInterval(beatTimer);
		if (kick) clearTimeout(kick);
		scanTimer = beatTimer = kick = undefined;
		if (me && box) {
			try {
				lb.releaseReader(root, box, me);
			} catch {}
		}
		me = undefined;
	}

	/** Deliver now only when pi can take a message: idle (starts a turn) or mid-run (queues). Not while compacting. */
	const canDeliver = (c: ExtensionContext) => c.isIdle() || c.signal !== undefined;

	function drain(): void {
		const c = ctx;
		if (!c || !box || !me || draining) return;
		if (!stillMine()) return;
		draining = true;
		try {
			for (const name of lb.waiting(root, box)) {
				if (!canDeliver(c)) break; // try again on the next scan
				const taken = lb.takeLetter(root, box, name);
				if (!taken) continue;
				if ("rejected" in taken) {
					if (taken.rejected.id) lb.writeReceipt(root, box, taken.rejected.id, { state: "rejected", reason: taken.rejected.reason, ...whoAmI() });
					continue;
				}
				const letter = taken.letter;
				const idle = c.isIdle();
				const details: LetterDetails = { id: letter.id, box, from: letter.from, ack: letter.ack !== false };
				try {
					pi.sendMessage(
						{ customType: MESSAGE, content: lb.formatForModel(letter, box, TOOL), display: true, details },
						idle ? { triggerTurn: true } : { triggerTurn: true, deliverAs: letter.delivery === "steer" ? "steer" : "followUp" },
					);
				} catch (e) {
					lb.untakeLetter(root, box, letter.id);
					notify(`pi-letterbox: could not deliver ${letter.id}: ${(e as Error).message}`, "warning");
					break;
				}
				lb.writeReceipt(root, box, letter.id, {
					state: "delivered",
					from: letter.from,
					delivery: idle ? "started a turn" : letter.delivery === "steer" ? "steered" : "queued",
					...whoAmI(),
				});
			}
		} catch (e) {
			notify(`pi-letterbox: ${(e as Error).message}`, "warning");
		} finally {
			draining = false;
		}
	}

	const whoAmI = () => ({
		session_id: me?.session_id,
		session_file: me?.session_file,
		host: me?.host ?? hostname(),
		pid: process.pid,
	});

	/** Whether this session is still the box's reader; another session may have taken it over (`--take`). */
	function stillMine(): boolean {
		if (!box || !me) return false;
		const r = lb.readReader(root, box) as Reader | undefined;
		if (!r || lb.sameReader(r, me)) return true; // a missing file is rewritten on the next beat
		const lost = box;
		stopReading(); // the tool stays: letters already delivered here still need their receipts
		status(`✉ ${lost} (taken over)`);
		notify(`pi-letterbox: pid ${r.pid} (${r.cwd ?? "?"}) took over letterbox "${lost}"; this session stopped reading it.`, "warning");
		return false;
	}

	function beat(): void {
		if (!box || !me || !stillMine()) return;
		me.beat = new Date().toISOString();
		try {
			lb.writeReader(root, box, me);
		} catch {}
	}

	/** Become the reader of `name`. Returns why not, or undefined. */
	function open(name: string, c: ExtensionContext, take = false): string | undefined {
		if (!lb.BOX_RE.test(name)) return `invalid letterbox name "${name}": use letters, digits, ".", "_" and "-"`;
		if (box === name && me) return undefined;
		stopReading();
		box = name;
		const p = lb.ensureBox(root, name);
		const r = lb.readReader(root, name) as Reader | undefined;
		if (!take && r && r.pid !== process.pid && lb.readerLive(r)) {
			status(`✉ ${name} (busy)`);
			setToolActive(false);
			return `letterbox "${name}" is read by pid ${r.pid} on ${r.host} (${r.cwd ?? "?"}); use /letterbox open ${name} --take to take it over`;
		}
		const now = new Date().toISOString();
		me = {
			v: 1,
			pid: process.pid,
			host: hostname(),
			session_id: c.sessionManager.getSessionId(),
			session_file: c.sessionManager.getSessionFile(),
			cwd: c.cwd,
			since: now,
			beat: now,
		};
		lb.writeReader(root, name, me);
		opened.add(name);
		process.env.PI_LETTERBOX_BOX = name;
		try {
			watcher = watch(p.new, () => {
				if (kick) return;
				kick = setTimeout(() => {
					kick = undefined;
					drain();
				}, 50);
				kick.unref?.();
			});
			watcher.on("error", () => {
				watcher?.close();
				watcher = undefined;
			});
		} catch {
			watcher = undefined; // the interval scan still works (e.g. on network filesystems)
		}
		scanTimer = setInterval(drain, SCAN_MS);
		scanTimer.unref?.();
		beatTimer = setInterval(beat, BEAT_MS);
		beatTimer.unref?.();
		status(`✉ ${name}`);
		setToolActive(true);
		drain();
		return undefined;
	}

	function close(): void {
		stopReading();
		box = undefined;
		delete process.env.PI_LETTERBOX_BOX;
		status(undefined);
		setToolActive(false);
	}

	/** The box the session asked for last (`/letterbox open|close`), on the current branch. */
	function remembered(c: ExtensionContext): string | null | undefined {
		const branch = c.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const e = branch[i] as { type?: string; customType?: string; data?: { box?: string | null } };
			if (e.type === "custom" && e.customType === ENTRY && e.data && "box" in e.data) return e.data.box ?? null;
		}
		return undefined;
	}

	/** A small shell shim, so scripts and ssh can run the CLI without knowing where pi installed the package. */
	function installShim(): string | undefined {
		const shim = join(root, "bin", "pi-letterbox");
		const body = `#!/bin/sh\nexec ${lb.shq(process.execPath)} ${lb.shq(CLI)} "$@"\n`;
		try {
			if (!existsSync(shim) || readFileSync(shim, "utf8") !== body) {
				mkdirSync(join(root, "bin"), { recursive: true, mode: 0o700 }); // "bin" is reserved, never a box
				writeFileSync(shim, body, { mode: 0o755 });
				chmodSync(shim, 0o755);
			}
			process.env.PI_LETTERBOX_CLI = shim;
			return shim;
		} catch {
			return undefined;
		}
	}

	pi.on("session_start", (_e, c) => {
		stopReading();
		ctx = c;
		root = lb.defaultRoot();
		box = undefined;
		installShim();
		const flag = pi.getFlag("letterbox");
		const wanted = (typeof flag === "string" && flag) || process.env.PI_LETTERBOX || remembered(c) || undefined;
		if (!wanted || c.mode === "print" || c.mode === "json") {
			setToolActive(false);
			return;
		}
		const why = open(wanted, c);
		if (why) notify(`pi-letterbox: ${why}`, "warning");
	});

	pi.on("session_shutdown", () => {
		stopReading();
		ctx = undefined;
	});

	// The read receipt: the letter has entered the conversation.
	pi.on("message_end", (e) => {
		const m = e.message as { role?: string; customType?: string; details?: Partial<LetterDetails> };
		if (m?.role !== "custom" || m.customType !== MESSAGE) return;
		const id = m.details?.id;
		const b = m.details?.box;
		if (!id || !b || !lb.ID_RE.test(id) || !lb.BOX_RE.test(b)) return;
		try {
			const r = lb.readReceipt(root, b, id);
			if (r && lb.RANK[r.state] < lb.RANK.read) lb.writeReceipt(root, b, id, { state: "read" });
		} catch {}
	});

	pi.registerTool({
		name: TOOL,
		label: "Letterbox receipt",
		description:
			'Send the receipt for a letter that reached this session through pi-letterbox: outcome "done" once you have handled it, or "declined" with a note saying why you will not. The sender may be waiting for this receipt, so send it when the work the letter asks for is finished or refused, not when you start.',
		parameters: Type.Object({
			id: Type.String({ description: "The letter id, as given in the letter" }),
			outcome: Type.Optional(Type.Union([Type.Literal("done"), Type.Literal("declined")], { description: "done (default) or declined" })),
			note: Type.Optional(Type.String({ description: "One or two sentences for the sender: what was done, or why not" })),
		}),
		defaultActive: false,
		async execute(_callId, params) {
			const id = String(params.id ?? "").trim();
			if (!lb.ID_RE.test(id)) throw new Error(`"${id}" is not a letter id`);
			const candidates = [...new Set([box, ...opened].filter((b): b is string => !!b))];
			const b = candidates.find((x) => lb.readReceipt(root, x, id));
			if (!b) throw new Error(`no letter ${id} reached this session`);
			const prev = lb.readReceipt(root, b, id)!;
			if (prev.state === "rejected") throw new Error(`letter ${id} was rejected (${prev.reason ?? "invalid"}); it has no receipt to send`);
			const outcome = params.outcome === "declined" ? "declined" : "done";
			const note = params.note ? lb.cleanLabel(params.note, lb.MAX_NOTE_CHARS) : undefined;
			const r = lb.writeReceipt(root, b, id, { state: outcome, ...(note ? { note } : {}) });
			return {
				content: [{ type: "text", text: `Receipt sent: letter ${id} is ${r.state}.` }],
				details: { id, box: b, state: r.state },
			};
		},
	});

	pi.registerCommand("letterbox", {
		description: "Letterbox: show status, open <name> [--take], close",
		handler: async (args, c) => {
			ctx = c;
			const [sub, name, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			if (sub === "open") {
				if (!name) return c.ui.notify("Usage: /letterbox open <name> [--take]", "warning");
				if (c.mode === "print" || c.mode === "json") return;
				const why = open(name, c, rest.includes("--take"));
				pi.appendEntry(ENTRY, { box: name });
				if (why) return c.ui.notify(`pi-letterbox: ${why}`, "warning");
				return c.ui.notify(`Reading letterbox "${name}". Send with:\n  ${sendHint(name)}`, "info");
			}
			if (sub === "close") {
				const was = box;
				close();
				pi.appendEntry(ENTRY, { box: null });
				return c.ui.notify(was ? `Closed letterbox "${was}".` : "No letterbox was open.", "info");
			}
			if (sub && sub !== "status") return c.ui.notify("Usage: /letterbox [status | open <name> [--take] | close]", "warning");
			c.ui.notify(describe(), "info");
		},
	});

	function sendHint(name: string): string {
		const cli = process.env.PI_LETTERBOX_CLI ?? "pi-letterbox";
		return `${cli} send ${name} "…"   (from another host: pi-letterbox send --host ${hostname()} ${name} "…")`;
	}

	function describe(): string {
		const lines: string[] = [];
		if (!box) lines.push("No letterbox is open. /letterbox open <name> starts reading one.");
		else {
			const p = lb.boxPaths(root, box);
			lines.push(me ? `Reading letterbox "${box}" (${p.dir}).` : `Letterbox "${box}" is not read by this session (busy or taken over).`);
			lines.push(`${lb.waiting(root, box).length} waiting.`);
			const recent = lb.recentReceipts(root, box, 5);
			for (const r of recent) lines.push(`  ${r.id}  ${r.state}${r.from ? `  from ${r.from}` : ""}${r.note ? `  — ${r.note}` : ""}`);
			lines.push(`Send with: ${sendHint(box)}`);
		}
		const others = lb.listBoxes(root).filter((b) => b !== box);
		if (others.length) lines.push(`Other boxes: ${others.join(", ")}`);
		return lines.join("\n");
	}

	pi.registerMessageRenderer<LetterDetails>(MESSAGE, (message, options, theme) => {
		const d = message.details;
		const raw = typeof message.content === "string" ? message.content : "";
		// The model's text is "<head>\n\n<letter>[\n\n(<receipt footer>)]": show the letter itself.
		let body = raw.slice(raw.indexOf("\n\n") + 2);
		const foot = body.lastIndexOf("\n\n(The sender is waiting for a receipt");
		if (foot >= 0) body = body.slice(0, foot);
		const header = theme.fg("accent", `✉ ${theme.bold(d?.from ?? "letter")}`) + theme.fg("muted", `  ${d?.box ?? ""} · ${d?.id ?? ""}`);
		const lines = body.split("\n");
		const shown = options.expanded || lines.length <= 12 ? body : `${lines.slice(0, 12).join("\n")}\n${theme.fg("muted", `… ${lines.length - 12} more lines`)}`;
		return new Text(`${header}\n${shown}`, 0, 0);
	});
}
