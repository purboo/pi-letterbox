# pi-letterbox

**A letterbox for a running [pi](https://pi.dev) session, with receipts.**

A script, a cron job, CI, or a pi session on another machine drops a letter. The session reads it at a safe point (now if it is idle, after its current work if it is busy, never in the middle of a compaction), and the sender gets receipts back:

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
| `--timeout <s>` | How long to wait (default 600). |
| `--steer` | Interrupt a busy session at its next step instead of queueing behind its work. |
| `--no-ack` | A notice: don't ask the agent for a *done* receipt. |
| `--ttl <s>` | Reject the letter if no session takes it within this time. |
| `--id <id>` | Choose the id. Sending the same id again never sends twice, so retries are safe. |
| `--from <label>` | Who is writing (default `user@host`). |
| `--json` | Machine-readable output. |

`pi-letterbox status <box> <id>`, `pi-letterbox wait <box> <id> [--until read]` and `pi-letterbox list` work locally and with `--host`.

A letter sent while no session reads the box waits on disk; the sender is told so, and the letter is delivered when a session opens the box.

## Receipts

| Receipt | Means |
|---|---|
| `delivered` | The session took the letter: it started a turn, or queued it behind the current work, or steered it in. |
| `read` | The letter is in the conversation the model sees. |
| `done` / `declined` | The agent called `letterbox_done` with a note: what it did, or why not. |
| `rejected` | The session could not take it (invalid, too large, expired), with the reason. |

The agent learns to send receipts from the letter itself, which ends with a one-line instruction (omitted with `--no-ack`). The `letterbox_done` tool is declared to the model only while a box is open. Opening one in the middle of a session adds the tool once; on providers that cannot add tools mid-conversation that costs one cache rebuild.

## Trust

A letter becomes a message in the agent's conversation, so whoever can write the box can prompt your agent. Boxes live under `~/.pi/agent/letterbox` (mode 700, files 600): that is anyone who can act as your user on that machine, or log in as you over ssh, the same people who could type into your terminal. Letters are labeled with their sender and id and are not slash commands. Say in your `AGENTS.md` how much authority letters from a given sender carry.

## How it works

Plain files, so anything that can write a file can send, and nothing needs to run besides the session:

```text
~/.pi/agent/letterbox/<box>/
  tmp/<id>.json        the sender writes here first …
  new/<id>.json        … then renames here: a letter is never seen half-written
  cur/<id>.json        letters the session has taken
  receipts/<id>.json   the latest receipt, replaced atomically
  reader.json          the session reading the box, with a heartbeat
```

A letter is JSON: `{"v":1,"id":"…","text":"…","from":"…","created_at":"…"}`, with optional `"delivery":"steer"`, `"ack":false` and `"expires_at"`. Text is limited to 64 KiB; send a path for anything bigger. Remote sends and waits are one `ssh host sh -s` each, with the script on stdin. `PI_LETTERBOX_DIR` moves the root on either side; `PI_LETTERBOX_SSH` replaces the `ssh` command (for example `ssh -p 2222`).

pi-letterbox is not a chat between sessions: [pi-post](https://www.npmjs.com/package/pi-post) and [pi-session-mail](https://www.npmjs.com/package/pi-session-mail) do that on one machine. It is the one place where anything else, on any machine you can ssh to, hands a running session work and learns when it is done.

## Development

```sh
bun install
bun run check          # tsc + bun test: unit, the CLI (with a stand-in ssh), and real pi over RPC
pi -e ./src/index.ts --letterbox test
```
