# pi-letterbox

**A letterbox for a running [pi](https://pi.dev) session, with receipts.**

A script, a cron job, CI, or a pi session on another machine drops a letter. The session reads it at a safe point (now if it is idle, after its current work if it is busy), and the sender gets receipts back. While pi compacts between turns (idle, no run), letters stay in `new/`. During automatic compaction inside a run a letter may be taken and queued; it enters the model after compaction ends:

```text
$ pi-letterbox send --host buildbox work --wait done "Nightly is red: see /logs/nightly.log and fix it."
sent 20261024-221501-9f3a1c2e to buildbox:work
20261024-221501-9f3a1c2e: done — fixed the flaky timeout in tests/net.test.ts; nightly is green again
```

On the receiving side the letter shows up in the conversation, and the agent answers with a receipt:

```text
✉ ci@laptop  work · 20261024-221501-9f3a1c2e
Nightly is red: see /logs/nightly.log and fix it.

 letterbox_done id="20261024-221501-9f3a1c2e" note="fixed the flaky timeout…"
```

No typing into a terminal, no lost Enter while pi is busy, and no guessing whether the message arrived.

## Install

```sh
pi install npm:pi-letterbox
```

For sending from scripts or other machines, the CLI is also on npm (`npm i -g pi-letterbox`, or `npx pi-letterbox`). A session that has the extension also writes a shim at `~/.pi/agent/letterbox/bin/pi-letterbox`.

## Open a letterbox

A session reads a box only when you say so, so parallel sessions never compete for letters:

| | |
|---|---|
| `pi --letterbox work` | Read the box `work` in this session. |
| `PI_LETTERBOX=work pi` | The same, from the environment. |
| `/letterbox open work` | Start reading now. Remembered by the session, so `pi -c` reopens it. |
| `/letterbox close` | Stop reading. |
| `/letterbox` | Status: the box, waiting letters, recent receipts, and how to send. |

While a box is open, `✉ work` shows in the status line. One session reads a box at a time; a second one leaves it alone and says who has it, until you run `/letterbox open work --take` there.

Print and JSON mode (`pi -p`) never read a box.

## Send a letter

```sh
pi-letterbox send work "Rebase on main, master moved."          # this machine
pi-letterbox send --host buildbox work "…"                       # another machine, over ssh
echo "long brief…" | pi-letterbox send work                     # text from stdin
pi-letterbox send work --wait done --timeout 1800 "Run the release checklist."
```

| Option | |
|---|---|
| `--host <ssh-host>` | The box is on another host. Uses `ssh -o BatchMode=yes`; the far side needs nothing but `/bin/sh`. |
| `--wait delivered\|read\|done` | Wait for that receipt. Exit 0 when it arrives, 3 on timeout, 4 when the letter is declined or rejected. |
| `--timeout <s>` | How long to wait (default 600). Remote waits have one local deadline, including SSH connection time; connection failures exit 1 with diagnostics, not timeout 3. |
| `--steer` | Interrupt a busy session at its next step instead of queueing behind its work. |
| `--no-ack` | A notice: don't ask the agent for a *done* receipt. |
| `--ttl <s>` | Reject the letter if no session takes it within this time. |
| `--id <id>` | Choose the id. Concurrent sends with the same id claim it exactly once (locally or over SSH). A crash after the claim but before writing the letter leaves the id used and `status` reports `sending`; resending it returns `exists`, so send a new id to retry that case. |
| `--from <label>` | Who is writing (default `user@host`). |
| `--json` | Machine-readable output. |

`pi-letterbox status <box> <id>`, `pi-letterbox wait <box> <id> [--until read]` and `pi-letterbox list` work locally and with `--host`.

A letter sent while no session reads the box waits on disk; the sender is told so, and the letter is delivered when a session opens the box.

## Receipts

| Receipt | Means |
|---|---|
| `delivered` | Handed to a session at least once: started a turn, queued, or steered. Not proof that it reached the conversation; a recovered/requeued letter keeps this state. |
| `read` | The letter is in the conversation the model sees. |
| `done` / `declined` | The agent called `letterbox_done` with a note: what it did, or why not. |
| `rejected` | The session could not take it (invalid, too large, expired), with the reason. |

Receipts never move backwards. Final outcomes cannot change; repeating the same outcome is an idempotent success and may only update `note`. `letterbox_done` accepts `id`, optional `box`, `outcome` (`done` by default, or `declined`), and `note`. It only confirms a letter owned by the current session id, including after `pi -c`; once redelivered to a different session, the former session cannot confirm it. Without `box` it searches every box; an id matching more than one box requires `box`.

Delivery is **at least once for letters that never reached a conversation**. The current reader scans `cur/` on open and every 10 seconds. Dead runtimes' queued letters are checked against their saved JSONL conversation, then marked read/archived or requeued. A live runtime's lease protects queued letters even after takeover. Its own missing delivery is retried only after 10 seconds, while idle with no pending messages and no copy in its session file. A taker that died before writing a receipt is recovered after 30 seconds. After three delivery attempts, an unreached letter is rejected with `not delivered after 3 attempts`. A requeued letter may appear twice, so recipients should handle work idempotently.

The agent learns to send receipts from the letter itself, which ends with a one-line instruction (omitted with `--no-ack`). The `letterbox_done` tool is declared to the model only while a box is open. Opening one in the middle of a session adds the tool once; on providers that cannot add tools mid-conversation that costs one cache rebuild.

## Trust

A letter becomes a message in the agent's conversation, so whoever can write the box can prompt your agent. Boxes live under `~/.pi/agent/letterbox` (mode 700, files 600): that is anyone who can act as your user on that machine, or log in as you over ssh, the same people who could type into your terminal. Letters are labeled with their sender and id and are not slash commands. Say in your `AGENTS.md` how much authority letters from a given sender carry.

## How it works

Plain files, so anything that can write a file can send, and nothing needs to run besides the session:

```text
~/.pi/agent/letterbox/<box>/
  tmp/<id>.<pid>.<random>.json  unique sender temporary file …
  new/<id>.json        … then atomically renamed here (never half-written)
  cur/<id>.json        taken, not yet in a conversation
  seen/<id>.json       archived read/final or rejected letters (.invalid names preserved)
  ids/<id>/            permanent atomic send claim, one per id ever sent
  receipts/<id>.json   latest monotonic receipt, atomically replaced
  reader.json         exclusive reader: token, pid, host, session_id/file, cwd, since, beat
  leases/<token>.json  runtime heartbeat, kept even after reader takeover
  locks/<name>/        short node locks (reader, r.<id>): one owner-<nonce> file
```

The layout is backwards compatible with 0.1.0 boxes: old read/final letters in `cur/` are archived by recovery, without a migration. Each open uses a random 16-byte hex token; ownership changes use the reader lock. Reader and lease beats update every 15 seconds, and liveness requires a beat younger than 90 seconds plus a live pid on this host (foreign hosts use the beat). Shutdown and `/letterbox close` remove runtime leases; recovery removes leases dead for over 24 hours. Delivered receipts include `token`, `attempts`, `session_id` and `session_file`; recovery records `requeued_at` without resetting the state.

Locks are node-only and synchronous. A process builds `locks/.t-<nonce>/owner-<nonce>` (pid, host, time) and renames that directory onto `locks/<name>`, which succeeds only while the target is absent or empty; release unlinks its own owner file and then removes the directory if it is empty. A lock whose owner pid is dead on this host, or whose owner time is older than 10 seconds, is broken by renaming that exact `owner-<nonce>` file away, so a breaker can never move a newer lock. A holder stalled for more than 10 seconds inside its critical section can therefore lose mutual exclusion (its release then leaves the new holder alone). Waiting gives up after 5 seconds; leftover `.t-*` and `.dead-*` entries older than 60 seconds are swept. Runtimes track in-flight letters per box and id, so the same id in two boxes is recovered independently.

A letter is JSON: `{"v":1,"id":"…","text":"…","from":"…","created_at":"…"}`, with optional `"delivery":"steer"`, `"ack":false` and `"expires_at"`. Text is limited to 64 KiB; send a path for anything bigger. Remote sends and waits are one `ssh host sh -s` each, with the script on stdin. `PI_LETTERBOX_DIR` moves the root on either side; `PI_LETTERBOX_SSH` replaces the `ssh` command (for example `ssh -p 2222`).

pi-letterbox is not a chat between sessions: [pi-post](https://www.npmjs.com/package/pi-post) and [pi-session-mail](https://www.npmjs.com/package/pi-session-mail) do that on one machine. It is the one place where anything else, on any machine you can ssh to, hands a running session work and learns when it is done.

## Development

```sh
bun install
bun run check          # tsc + bun test: unit, the CLI (with a stand-in ssh), and real pi over RPC
pi -e ./src/index.ts --letterbox test
```
