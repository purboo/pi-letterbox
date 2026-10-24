# Changelog

## 0.1.0

- A session reads a named letterbox (`pi --letterbox <name>`, `PI_LETTERBOX`, or `/letterbox open <name>`,
  remembered across `pi -c`). One reader per box; `--take` takes one over.
- Letters arrive as a labeled message at a safe point: a new turn when idle, queued behind the current work
  when busy (or steered in with `--steer`). Between-turn idle compaction leaves letters in `new/`;
  automatic compaction inside a run may take and queue them, entering the model after compaction ends.
- Receipts: delivered, read, then done or declined from the agent's `letterbox_done` tool, or rejected with a
  reason. The tool is declared only while a box is open.
- `pi-letterbox` CLI: `send`, `status`, `wait`, `list`, locally or on another host over ssh (the far side needs
  only `/bin/sh`), with `--wait`, `--timeout`, idempotent `--id`, `--ttl`, `--no-ack` and `--json`.
- Backwards-compatible layout gains permanent `ids/<id>` claim files (created with `O_EXCL`, or the shell's
  noclobber `>`; not `mkdir`, which uutils coreutils 0.10 on Ubuntu 26.04 does not make exclusive), `seen/` archives,
  `leases/<token>.json` runtime heartbeats and short node `locks/` (an `owner-<nonce>` file installed by
  directory rename; stale owners are broken by renaming that exact file, so a breaker never moves a newer
  lock; a holder stalled over 10 seconds loses exclusion). Concurrent local and shell sends claim
  an id once; a sender crash between claim and rename uses the id without a letter (`status`: `sending`).
- At-least-once recovery for letters that never reached a conversation: `cur/` holds only unreached
  letters, recovered on open and every 10 seconds using token leases and saved JSONL sessions. Old read/final
  letters in `cur/` are archived automatically. `delivered` means handed to a session at least once and
  stays delivered after requeue (`requeued_at`); duplicates are possible. After three attempts, reject
  with `not delivered after 3 attempts`. In-flight letters are tracked per box and id.
- Exclusive token reader claims, beats and release under the reader lock. Runtime leases keep beating
  after takeover and are removed on shutdown/close; dead leases older than 24 hours are cleaned up.
- `letterbox_done` accepts optional `box`, searches all boxes otherwise (ambiguity requires `box`),
  and only confirms the current session's receipt, also after `pi -c`. Final states cannot change;
  repeating the same outcome may update only its note.
- Remote waits have a hard local deadline including SSH connection time and require the
  `pi-letterbox-wait` query marker. Connection failures exit 1 with diagnostics; queried timeouts exit 3.
