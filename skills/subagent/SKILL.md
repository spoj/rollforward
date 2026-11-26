---
name: subagent
description: Delegate a bounded subtask to a synchronous Pi subagent (same sandbox, separate transcript under session/subagents/), with a 10-minute default checkpoint timeout and clean resume/steering support.
---

# Subagent

Use `run_subagent.sh` to offload a self-contained subtask to a child agent in the same workspace while keeping your main context clean.

## Usage

Start a new subagent:
```bash
bash "$RF_SKILLS/subagent/run_subagent.sh" \
  --model openai/gpt-6.2-sol \
  --thinking xhigh \
  --prompt "Extract all unpaid invoices from working/inbox/ and write working/extracted.json"
```

Resume an existing subagent session (for example, after a 15-minute checkpoint timeout, or to steer it):
```bash
bash "$RF_SKILLS/subagent/run_subagent.sh" \
  --resume session/subagents/20261126-103500-a1b2.jsonl \
  --prompt "Continue from where you left off."
```

Or resume with steering:
```bash
bash "$RF_SKILLS/subagent/run_subagent.sh" \
  --resume session/subagents/20261126-103500-a1b2.jsonl \
  --prompt "I see the portal pagination timed out on page 4; filter by date range instead and finish the remaining rows."
```

## Options

- `--prompt <text>` (or `--prompt-file <path>`): Task instructions or follow-up steering message.
- `--model <provider/model>`: Model ID (defaults to `$RF_SUBAGENT_MODEL` or `openai/gpt-6.2-sol`).
- `--thinking <level>`: Thinking level (`low`, `medium`, `high`, `xhigh`; defaults to `xhigh`).
- `--timeout <seconds>`: Wall-clock cap for this turn. **Defaults to `600` (10 minutes).**
- `--resume <session.jsonl>`: Continue a previous subagent session with full prior context.
- `--name <label>`: Optional short label included in the session filename.

## Why the 10-minute default timeout matters

Keep the default 10-minute (`600s`) timeout even when a task may take 30–60 minutes overall:
- **Checkpoint & steer:** Returning every 10 minutes lets you inspect progress, catch wrong turns early, and stay responsive to user messages.
- **Safe & cheap to continue:** When a subagent hits the 10-minute mark, its full transcript is preserved in `session/subagents/<id>.jsonl` and printed to stdout. Resuming with `--resume <path> --prompt "Continue"` picks up cleanly where it stopped — there is no need to set a long timeout.

## Boundaries

- **Main agent owns the user-facing surface:** Do not ask a subagent to post user-facing replies, sign-off cards, or final summaries. Have it write its findings/artifacts to `working/` and return a concise status to you.
- **Otherwise unrestricted:** Inside the workspace, the subagent has the same tools you do and can inspect files, run scripts, and verify its own outputs.
- **Transcripts:** All child transcripts live under `session/subagents/` so you (and reviewers) can inspect them without cluttering the main trace.
