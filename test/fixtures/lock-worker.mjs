// Child process for the lock race tests (run with node). Usage: lock-worker.mjs <root> <mode> <role>
//   mode "lock":  withLock(reader); role "breaker" pauses right after it observed the stale owner.
//   mode "claim": claimReader; role "late" pauses after observing, role "first" pauses inside the lock.
//   mode "hold":  withLock(reader) and stay inside until <role>-release.
// Barriers are files in <root>. Overlap inside the critical section is recorded as <root>/overlap.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { hostname } from "node:os";
import * as lb from "../../lib/letterbox.mjs";

const [root, mode, role] = process.argv.slice(2);
const dir = `${root}/b/locks/reader`;
const sleep = new Int32Array(new SharedArrayBuffer(4));
const touch = (f) => fs.writeFileSync(`${root}/${f}`, "");
const wait = (f) => {
	const end = Date.now() + 8000;
	while (!fs.existsSync(`${root}/${f}`)) {
		if (Date.now() > end) throw new Error(`barrier timeout ${f}`);
		Atomics.wait(sleep, 0, 0, 5);
	}
};

if ((mode === "lock" && role === "breaker") || (mode === "claim" && role === "late")) {
	// "Observed the stale lock": the round-1 code stats the directory, this protocol reads the owner file.
	let once = true;
	const pause = () => {
		if (!once) return;
		once = false;
		touch(`${role}-observed`);
		wait(`${role}-go`);
	};
	const { statSync, readFileSync } = fs;
	fs.statSync = function (f, ...a) {
		const s = statSync(f, ...a);
		if (String(f) === dir) pause();
		return s;
	};
	fs.readFileSync = function (f, ...a) {
		const s = readFileSync(f, ...a);
		if (String(f).startsWith(`${dir}/`)) pause();
		return s;
	};
}
if (mode === "claim" && role === "first") {
	const { writeFileSync } = fs;
	let once = true;
	fs.writeFileSync = function (f, ...a) {
		if (once && String(f).includes("/.reader.json.")) {
			once = false;
			writeFileSync(`${root}/${role}-ready`, "");
			wait(`${role}-go`);
		}
		return writeFileSync(f, ...a);
	};
}
syncBuiltinESMExports();

const inside = (body) => {
	try {
		fs.writeFileSync(`${root}/inside`, role, { flag: "wx" });
	} catch {
		fs.writeFileSync(`${root}/overlap`, role);
	}
	touch(`${role}-inside`);
	try {
		return body();
	} finally {
		fs.rmSync(`${root}/inside`, { force: true });
	}
};

if (mode === "claim") {
	const now = new Date().toISOString();
	// pid = the test process, so the claimed reader stays live after this child exits.
	const me = { v: 1, token: role, pid: process.ppid, host: hostname(), since: now, beat: now };
	const prev = lb.claimReader(root, "b", me);
	console.log(`${role}:${prev ? "busy" : "claimed"}`);
} else {
	lb.withLock(root, "b", "reader", () => inside(() => wait(`${role}-release`)));
	console.log(`${role}:released`);
}
