# Changelog

## 0.1.0

- A session reads a named letterbox (`pi --letterbox <name>`, `PI_LETTERBOX`, or `/letterbox open <name>`,
  remembered across `pi -c`). One reader per box; `--take` takes one over.
- Letters arrive as a labeled message at a safe point: a new turn when idle, queued behind the current work
  when busy (or steered in with `--steer`), held while pi compacts.
- Receipts: delivered, read, then done or declined from the agent's `letterbox_done` tool, or rejected with a
  reason. The tool is declared only while a box is open.
- `pi-letterbox` CLI: `send`, `status`, `wait`, `list`, locally or on another host over ssh (the far side needs
  only `/bin/sh`), with `--wait`, `--timeout`, idempotent `--id`, `--ttl`, `--no-ack` and `--json`.
