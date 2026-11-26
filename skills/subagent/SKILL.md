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

Resume an existing subagent session using the exact `session:` path printed by `run_subagent.sh` (scoped to the current run under `session/subagents/<run-scope>/`):
```bash
bash "$RF_SKILLS/subagent/run_subagent.sh" \
  --resume session/subagents/<run-scope>/20261126-103500-task-a1b2.jsonl \
  --prompt "Continue from where you left off."
```

Or resume with steering:
```bash
bash "$RF_SKILLS/subagent/run_subagent.sh" \
  --resume session/subagents/<run-scope>/20261126-103500-task-a1b2.jsonl \
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

- **Main agent owns the user-facing surface and external actions:** Subagents are drafting-only and do not hold the parent's user-approval context. Have the subagent write drafts/findings/artifacts to `working/` and return a concise status; the main agent performs any approved external actions, user-facing replies, or sign-offs.
- **Anchored to the instance workspace:** `run_subagent.sh` always anchors execution and transcript storage to the instance workspace (`/work`) and requires the RF policy prompt.
- **Transcripts:** All child transcripts live under `session/subagents/<run-scope>/` so you (and reviewers) can inspect them without cluttering the main trace.
