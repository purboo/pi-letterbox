// Real pi in RPC mode against the capture server, isolated from the user's agent directory.
// Adapted from pi-aside's test harness (same author, MIT).

import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
export const EXTENSION = join(ROOT, "src/index.ts");

export function piPackageDir(): string {
	return realpathSync(process.env.PI_LETTERBOX_PI_DIR ?? join(ROOT, "node_modules/@earendil-works/pi-coding-agent"));
}

const PROVIDER = { provider: "cap-anthropic", api: "anthropic-messages", model: "claude-test", key: "test-key" };

function modelsJson(baseUrl: string): unknown {
	return {
		providers: {
			[PROVIDER.provider]: {
				baseUrl,
				api: PROVIDER.api,
				apiKey: PROVIDER.key,
				models: [
					{
						id: PROVIDER.model,
						name: PROVIDER.model,
						reasoning: false,
						input: ["text"],
						contextWindow: 200000,
						maxTokens: 16000,
						cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
						compat: { supportsMidConvoToolChanges: true, supportsMidConvoSystemMessages: true },
					},
				],
			},
		},
	};
}

export interface PiOptions {
	baseUrl: string;
	extensions?: string[];
	env?: Record<string, string>;
	args?: string[];
	settings?: Record<string, unknown>;
	/** Reuse these directories (to resume a session); otherwise fresh ones are made and removed on close. */
	agentDir?: string;
	sessionDir?: string;
	cwd?: string;
}

export interface UiRequest {
	id: string;
	method: string;
	[key: string]: unknown;
}

export class PiRpc {
	readonly events: Record<string, unknown>[] = [];
	readonly ui: UiRequest[] = [];
	stderr = "";
	private buffer = "";
	private pending = new Map<string, (r: Record<string, unknown>) => void>();
	private waiters = new Set<() => void>();
	private nextId = 0;

	constructor(
		readonly child: ChildProcess,
		readonly agentDir: string,
		readonly sessionDir: string,
		readonly cwd: string,
		private readonly owned: boolean,
	) {
		child.stdout!.setEncoding("utf8");
		child.stdout!.on("data", (chunk: string) => this.onData(chunk));
		child.stderr!.setEncoding("utf8");
		child.stderr!.on("data", (chunk: string) => {
			this.stderr += chunk;
		});
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		let index = this.buffer.indexOf("\n");
		while (index >= 0) {
			const line = this.buffer.slice(0, index).replace(/\r$/, "");
			this.buffer = this.buffer.slice(index + 1);
			index = this.buffer.indexOf("\n");
			if (!line.trim()) continue;
			let record: Record<string, unknown>;
			try {
				record = JSON.parse(line);
			} catch {
				continue;
			}
			if (record.type === "response" && typeof record.id === "string" && this.pending.has(record.id)) {
				this.pending.get(record.id)!(record);
				this.pending.delete(record.id);
			} else if (record.type === "extension_ui_request") {
				this.ui.push(record as UiRequest);
			} else {
				this.events.push(record);
			}
			for (const w of [...this.waiters]) w();
		}
	}

	send(command: Record<string, unknown>, timeoutMs = 15_000): Promise<Record<string, unknown>> {
		const id = `c${++this.nextId}`;
		return new Promise((resolvePromise, reject) => {
			const t = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`RPC ${String(command.type)} timed out; stderr: ${this.stderr.slice(-2000)}`));
			}, timeoutMs);
			this.pending.set(id, (r) => {
				clearTimeout(t);
				resolvePromise(r);
			});
			this.child.stdin!.write(`${JSON.stringify({ ...command, id })}\n`);
		});
	}

	prompt(message: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		return this.send({ type: "prompt", message, ...extra });
	}

	async waitFor<T>(probe: () => T | undefined | false, timeoutMs = 20_000, what = "condition"): Promise<T> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const value = probe();
			if (value !== undefined && value !== false) return value;
			const left = deadline - Date.now();
			if (left <= 0) throw new Error(`timed out waiting for ${what}; stderr: ${this.stderr.slice(-3000)}`);
			await new Promise<void>((r) => {
				const t = setTimeout(done, Math.min(left, 100));
				this.waiters.add(done);
				function done() {
					clearTimeout(t);
					r();
				}
			});
			this.waiters.clear();
		}
	}

	agentEnds(): number {
		return this.events.filter((e) => e.type === "agent_end").length;
	}

	waitForAgentEnd(count = 1, timeoutMs = 20_000): Promise<true> {
		return this.waitFor(() => this.agentEnds() >= count || undefined, timeoutMs, `agent_end #${count}`);
	}

	notifications(): string[] {
		return this.ui.filter((u) => u.method === "notify").map((u) => String(u.message));
	}

	sessionFile(): string | undefined {
		const walk = (dir: string): string[] =>
			readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
				d.isDirectory() ? walk(join(dir, d.name)) : d.name.endsWith(".jsonl") ? [join(dir, d.name)] : [],
			);
		return walk(this.sessionDir)[0];
	}

	sessionEntries(): Record<string, unknown>[] {
		const file = this.sessionFile();
		if (!file) return [];
		return readFileSync(file, "utf8")
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l));
	}

	async stop(): Promise<void> {
		if (this.child.exitCode === null && this.child.signalCode === null) {
			this.child.stdin!.end();
			this.child.kill("SIGTERM");
			await new Promise<void>((r) => {
				const t = setTimeout(() => {
					this.child.kill("SIGKILL");
					r();
				}, 3000);
				this.child.once("exit", () => {
					clearTimeout(t);
					r();
				});
			});
		}
	}

	async close(): Promise<void> {
		await this.stop();
		if (this.owned) {
			rmSync(this.agentDir, { recursive: true, force: true });
			rmSync(this.sessionDir, { recursive: true, force: true });
			rmSync(this.cwd, { recursive: true, force: true });
		}
	}
}

export function scratch(prefix: string): string {
	return mkdtempSync(join(tmpdir(), `pi-letterbox-${prefix}-`));
}

export async function startPi(options: PiOptions): Promise<PiRpc> {
	const owned = options.agentDir === undefined;
	const agentDir = options.agentDir ?? scratch("agent");
	const sessionDir = options.sessionDir ?? scratch("sessions");
	const cwd = options.cwd ?? scratch("cwd");
	mkdirSync(cwd, { recursive: true });
	writeFileSync(join(agentDir, "models.json"), JSON.stringify(modelsJson(options.baseUrl), null, 2));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: "off", ...options.settings }, null, 2));
	const args = [
		join(piPackageDir(), "dist/bundle/cli.js"),
		"--mode",
		"rpc",
		"--session-dir",
		sessionDir,
		"--provider",
		PROVIDER.provider,
		"--model",
		PROVIDER.model,
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		...(options.extensions ?? [EXTENSION]).flatMap((e) => ["-e", e]),
		...(options.args ?? []),
	];
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("PI_")) env[k] = v;
	Object.assign(env, {
		PI_CODING_AGENT_DIR: agentDir,
		PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1",
		PI_TELEMETRY: "0",
		...options.env,
	});
	for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) delete env[k];
	const child = spawn("node", args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
	const pi = new PiRpc(child, agentDir, sessionDir, cwd, owned);
	await pi.send({ type: "get_state" }, 30_000);
	return pi;
}
