#!/usr/bin/env bash
set -euo pipefail

MODEL="${RF_SUBAGENT_MODEL:-openai/gpt-6.2-sol}"
THINKING="${RF_SUBAGENT_THINKING:-xhigh}"
TIMEOUT_SEC=600
RESUME_PATH=""
NAME="task"
PROMPT=""
PROMPT_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)       MODEL="$2"; shift 2 ;;
    --thinking)    THINKING="$2"; shift 2 ;;
    --timeout)     TIMEOUT_SEC="$2"; shift 2 ;;
    --resume)      RESUME_PATH="$2"; shift 2 ;;
    --name)        NAME="$2"; shift 2 ;;
    --prompt)      PROMPT="$2"; shift 2 ;;
    --prompt-file) PROMPT_FILE="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -n "$PROMPT_FILE" ]]; then
  PROMPT="$(cat "$PROMPT_FILE")"
fi
if [[ -z "$PROMPT" ]]; then
  echo "Error: --prompt or --prompt-file is required." >&2
  exit 2
fi

SUBAGENT_DIR="session/subagents"
mkdir -p "$SUBAGENT_DIR"

if [[ -n "$RESUME_PATH" ]]; then
  SESSION_FILE="$RESUME_PATH"
  if [[ ! -f "$SESSION_FILE" ]]; then
    echo "Error: resume session not found: $SESSION_FILE" >&2
    exit 2
  fi
else
  SAFE_NAME="$(printf '%s' "$NAME" | tr -cd 'a-zA-Z0-9_-' | cut -c1-32)"
  STAMP="$(date -u +%Y%m%d-%H%M%S)"
  RAND="$(head -c 3 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  SESSION_FILE="${SUBAGENT_DIR}/${STAMP}-${SAFE_NAME:-task}-${RAND}.jsonl"
fi

SYSTEM_GUARD="You are a subagent invoked by the main agent. Complete the assigned subtask thoroughly in this workspace and return a concise factual report of what you did, files written, and any open issues. Do not modify user-facing replies or sign-off state — the main agent owns the user-facing interface."

set +e
timeout --signal=TERM --kill-after=15 "$TIMEOUT_SEC" \
  pi \
    --provider openrouter \
    --model "$MODEL" \
    --thinking "$THINKING" \
    --session "$SESSION_FILE" \
    --append-system-prompt "$SYSTEM_GUARD" \
    -p "$PROMPT"
RC=$?
set -e

echo ""
echo "--- subagent metadata ---"
echo "session: $SESSION_FILE"
echo "model: $MODEL (thinking=$THINKING)"
if [[ $RC -eq 124 ]]; then
  echo "status: checkpoint_timeout (${TIMEOUT_SEC}s)"
  echo "next: inspect progress and resume with: bash \"\$RF_SKILLS/subagent/run_subagent.sh\" --resume \"$SESSION_FILE\" --prompt \"Continue\""
  exit 0
elif [[ $RC -ne 0 ]]; then
  echo "status: failed (exit=$RC)"
  exit "$RC"
else
  echo "status: completed"
fi
