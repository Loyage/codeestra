#!/usr/bin/env bash
#
# real-provider-acceptance.sh — scaffolding for the real-provider acceptance runbook.
#
# Companion document: docs/notes/real-provider-acceptance-runbook.md
#
# Design rules (kept deliberately narrow):
#   * DEFAULT IS DRY-RUN. Nothing is created, no model is called and no Git ref is touched unless
#     the caller passes both `--yes` and an explicit `--step`.
#   * This script never calls a real provider on its own. The steps prepare the one-shot
#     environment and print/record the exact commands; the user drives every model request in
#     front of the human who is judging the run.
#   * No new dependencies: bash + the repository's own `bun`/`git` only.
#   * No credential is ever written, read back or echoed. No Web UI token is printed (the script
#     never runs `codeestra ui`).
#   * Every subprocess has an explicit timeout (this machine has no `timeout(1)`).
#   * Every temporary directory is fresh; retention/cleanup guidance is always printed.
#
set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

DRY_RUN=1
KEEP=1
declare -a STEPS=()
RUNTIME_HOME=""
PROJECT_REPO=""
EVIDENCE_DIR=""
TEMP_ROOT=""
PROJECT_ID=""
declare -a FAILURES=()
LAST_STATUS=0
LAST_OUTPUT=""
LAST_ERROR=""

readonly KNOWN_STEPS="concurrency pause-resume revision-delivery knowledge plugins-gate prose-question terminal-handoff promotion"

usage() {
  cat <<'EOF'
real-provider-acceptance.sh — prepare and drive the real-provider acceptance runbook.

Usage:
  scripts/real-provider-acceptance.sh [--help]
  scripts/real-provider-acceptance.sh [--dry-run] [--step <name>]…
  scripts/real-provider-acceptance.sh --yes --step <name> [--step <name>]… [--clean]

Default behaviour is DRY-RUN: it prints the commands and the paths it *would* use and does
nothing else. Real actions require BOTH `--yes` and at least one explicit `--step`.

Options:
  --help                 Print this text and exit 0.
  --dry-run              Explicit dry-run (this is already the default).
  --yes                  Allow real actions. Requires at least one `--step`.
  --step <name>          Select one acceptance item. Repeatable. Known steps:
                           concurrency         A1 two SAFE Tasks really running together
                           pause-resume        A2 pause -> resume -> cancel
                           revision-delivery   A3 revision delivery ledger rows
                           knowledge           A4 Project Knowledge handed to the provider
                           plugins-gate        A5 third-party plugin vs. the gate
                           prose-question      A6 prose question -> WAITING_FOR_USER
                           terminal-handoff    A7 native terminal takeover and release
                           promotion           A8 real GitHub promotion path (needs go-ahead)
  --clean                Remove the fresh temporary root on success. Failures always keep it.
  --repo <path>          Use this repository instead of a fresh temporary one.
  --home <path>          Use this CODEESTRA_HOME instead of a fresh temporary one.

Environment overrides for the steps that need identifiers produced by an earlier command
(the script prints how to read each one):
  TASK_ID, VERSION, SESSION_ID, DELIVERY_ID, BATCH_ID, DEV_COMMIT, MAIN_COMMIT

What it creates when it runs for real:
  <temp-root>/repo        a one-shot Git repository (main + dev, minimal .codeestra policies)
  <temp-root>/home        an isolated CODEESTRA_HOME for the Runtime under test
  <temp-root>/evidence    where the evidence bundle of the runbook is collected

What it never does:
  * run a model request by itself (the user drives every real call);
  * push, merge, fast-forward or otherwise move any ref (A8 is printed for the user to run);
  * touch ~/Documents/codeestra (the stable clone) or its Runtime;
  * print a Web UI token — `codeestra ui` is never executed here;
  * write a credential into the repository.
EOF
}

log()  { printf '%s\n' "$*"; }
note() { printf '# %s\n' "$*"; }
warn() { printf '!! %s\n' "$*" >&2; }

# ---- argument parsing -------------------------------------------------------

while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --dry-run) DRY_RUN=1 ;;
    --yes) DRY_RUN=0 ;;
    --clean) KEEP=0 ;;
    --step)
      [ $# -ge 2 ] || { warn "--step needs a value"; exit 2; }
      STEPS+=("$2"); shift ;;
    --repo)
      [ $# -ge 2 ] || { warn "--repo needs a value"; exit 2; }
      PROJECT_REPO="$2"; shift ;;
    --home)
      [ $# -ge 2 ] || { warn "--home needs a value"; exit 2; }
      RUNTIME_HOME="$2"; shift ;;
    *) warn "unknown argument: $1"; usage >&2; exit 2 ;;
  esac
  shift
done

step_known() {
  case " $KNOWN_STEPS " in
    *" $1 "*) return 0 ;;
    *) return 1 ;;
  esac
}

if [ "${#STEPS[@]}" -gt 0 ]; then
  for step in "${STEPS[@]}"; do
    step_known "$step" || { warn "unknown step: $step"; warn "known steps: $KNOWN_STEPS"; exit 2; }
  done
fi

if [ "$DRY_RUN" -eq 0 ] && [ "${#STEPS[@]}" -eq 0 ]; then
  warn "--yes requires at least one explicit --step."
  warn "This is deliberate: no step ever runs because someone only said yes."
  warn "known steps: $KNOWN_STEPS"
  exit 2
fi

wants_step() {
  [ "${#STEPS[@]}" -eq 0 ] && return 0
  for step in "${STEPS[@]}"; do
    if [ "$step" = "$1" ]; then return 0; fi
  done
  return 1
}

wants_any_setup_step() {
  for candidate in concurrency pause-resume revision-delivery knowledge \
                   plugins-gate prose-question terminal-handoff promotion; do
    if wants_step "$candidate"; then return 0; fi
  done
  return 1
}

# ---- subprocess helpers -----------------------------------------------------

# Runs one command with a hard timeout, capturing stdout/stderr. Always returns 0 and leaves the
# result in LAST_STATUS / LAST_OUTPUT / LAST_ERROR so `set -e` never aborts on an expected refusal.
run_impl() {
  local seconds="$1"; shift
  local out_file err_file pid watchdog status
  out_file="$(mktemp "${TMPDIR:-/tmp}/ce-m4-out.XXXXXX")"
  err_file="$(mktemp "${TMPDIR:-/tmp}/ce-m4-err.XXXXXX")"
  ( cd "$REPO_ROOT" && exec "$@" ) >"$out_file" 2>"$err_file" &
  pid=$!
  (
    sleep "$seconds"
    kill -TERM "$pid" 2>/dev/null || true
    sleep 2
    kill -KILL "$pid" 2>/dev/null || true
  ) &
  watchdog=$!
  set +e
  wait "$pid"
  status=$?
  set -e
  kill -TERM "$watchdog" 2>/dev/null || true
  set +e
  wait "$watchdog" 2>/dev/null
  set -e
  LAST_OUTPUT="$(cat "$out_file")"
  LAST_ERROR="$(cat "$err_file")"
  rm -f "$out_file" "$err_file"
  if [ "$status" -eq 143 ] || [ "$status" -eq 137 ]; then
    warn "timed out after ${seconds}s: $(printf '%q ' "$@")"
  fi
  if [ "$DRY_RUN" -eq 0 ] && [ -n "$EVIDENCE_DIR" ] && [ -d "$EVIDENCE_DIR" ]; then
    printf '%s\texit=%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$status" \
      "$(printf '%q ' "$@")" >>"$EVIDENCE_DIR/commands.log"
  fi
  LAST_STATUS=$status
  return 0
}

# `ce <seconds> <codeestra args…>` — one CLI call against the isolated Runtime.
ce() {
  local seconds="$1"; shift
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] %s bun run codeestra %s\n' \
      "CODEESTRA_HOME=${RUNTIME_HOME:-<temp-home>}" "$(printf '%q ' "$@")"
    LAST_STATUS=0; LAST_OUTPUT=""; LAST_ERROR=""
    return 0
  fi
  run_impl "$seconds" env "CODEESTRA_HOME=$RUNTIME_HOME" bun run codeestra "$@"
}

# `git_local <seconds> <git args…>` — Git commands run with the repository as cwd.
git_local() {
  local seconds="$1"; shift
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] git -C %s %s\n' "$PROJECT_REPO" "$(printf '%q ' "$@")"
    LAST_STATUS=0; LAST_OUTPUT=""; LAST_ERROR=""
    return 0
  fi
  run_impl "$seconds" git -C "$PROJECT_REPO" "$@"
}

assert_ok() {
  local label="$1"
  if [ "$LAST_STATUS" -ne 0 ]; then
    FAILURES+=("$label (exit $LAST_STATUS)")
    warn "FAILED: $label (exit $LAST_STATUS)"
    if [ -n "$LAST_ERROR" ]; then printf '%s\n' "$LAST_ERROR" | sed 's/^/   /' >&2; fi
    return 1
  fi
  return 0
}

# Prints the observed exit code, or says plainly that nothing was executed in dry-run mode.
note_exit() {
  local label="$1" interpretation="$2"
  if [ "$DRY_RUN" -eq 1 ]; then
    note "  $label: <dry-run: not executed> $interpretation"
  else
    note "  $label: exit=$LAST_STATUS $interpretation"
  fi
}

# Minimal JSON reader (bun is already a repository dependency; no jq is introduced).
json_get() {
  JSON_INPUT="${1:-}" JSON_PATH="${2:-}" bun -e '
    const text = (process.env.JSON_INPUT ?? "").trim();
    let cur = text.length === 0 ? null : JSON.parse(text);
    for (const key of (process.env.JSON_PATH ?? "").split(".")) {
      if (key === "") continue;
      cur = cur === null || cur === undefined ? undefined : cur[key];
    }
    process.stdout.write(typeof cur === "string" ? cur : JSON.stringify(cur ?? null));
  '
}

# Reads a value out of the last response, falling back to a readable placeholder.
maybe_id() {
  local placeholder="$3" value
  if [ "$DRY_RUN" -eq 1 ]; then printf '%s' "$placeholder"; return 0; fi
  value="$(json_get "${1:-}" "${2:-}")"
  if [ "$value" = "null" ] || [ -z "$value" ]; then printf '%s' "$placeholder"
  else printf '%s' "$value"; fi
}

# Writes runtime output into the evidence bundle.
record() {
  local name="$1"
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] write evidence: %s/%s\n' "${EVIDENCE_DIR:-<temp-evidence>}" "$name"
    return 0
  fi
  printf '%s\n' "$LAST_OUTPUT" >"$EVIDENCE_DIR/$name"
  if [ -n "$LAST_ERROR" ]; then
    printf '%s\n' "$LAST_ERROR" >>"$EVIDENCE_DIR/$name.stderr"
  fi
}

# ---- environment setup ------------------------------------------------------

setup_environment() {
  if [ "$DRY_RUN" -eq 1 ]; then
    # A dry run creates nothing at all — not even an empty directory.
    TEMP_ROOT="${TMPDIR:-/tmp}/ce-m4-dry-run"
    [ -n "$RUNTIME_HOME" ] || RUNTIME_HOME="$TEMP_ROOT/home"
    [ -n "$PROJECT_REPO" ] || PROJECT_REPO="$TEMP_ROOT/repo"
    EVIDENCE_DIR="$TEMP_ROOT/evidence"
  else
    TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ce-m4-XXXXXX")"
    TEMP_ROOT="$(cd -- "$TEMP_ROOT" && pwd -P)"
    [ -n "$RUNTIME_HOME" ] || RUNTIME_HOME="$TEMP_ROOT/home"
    [ -n "$PROJECT_REPO" ] || PROJECT_REPO="$TEMP_ROOT/repo"
    EVIDENCE_DIR="$TEMP_ROOT/evidence"
  fi
  note "temp root:      $TEMP_ROOT"
  note "CODEESTRA_HOME: $RUNTIME_HOME"
  note "project repo:   $PROJECT_REPO"
  note "evidence:       $EVIDENCE_DIR"
}

prepare_repository() {
  if [ "$DRY_RUN" -eq 1 ]; then
    note "would create a one-shot repository at $PROJECT_REPO (main + dev + .codeestra policies)"
    return 0
  fi
  mkdir -p "$RUNTIME_HOME" "$EVIDENCE_DIR" "$PROJECT_REPO"
  case "$PROJECT_REPO" in
    "$REPO_ROOT"|"$REPO_ROOT"/*) warn "--repo must not point inside this checkout"; exit 2 ;;
  esac
  if [ ! -d "$PROJECT_REPO/.git" ]; then
    git_local 60 init -b main "$PROJECT_REPO"; assert_ok "git init" || return 1
    git_local 60 config user.name "Codeestra Acceptance"; assert_ok "git config user.name" || return 1
    git_local 60 config user.email "acceptance@example.invalid"
    assert_ok "git config user.email" || return 1
    mkdir -p "$PROJECT_REPO/.codeestra/policies" "$PROJECT_REPO/.codeestra/instructions"
    cat >"$PROJECT_REPO/.codeestra/policies/verification.json" <<'JSON'
{
  "version": 1,
  "commands": [
    { "id": "noop", "argv": ["true"], "cwd": ".", "timeoutSeconds": 60 }
  ]
}
JSON
    cat >"$PROJECT_REPO/.codeestra/impact.json" <<'JSON'
{
  "version": 1,
  "importantDirectories": ["lane-a", "lane-b"],
  "modules": [],
  "globalResources": []
}
JSON
    printf '# Acceptance fixture\n' >"$PROJECT_REPO/README.md"
    git_local 60 add --all; assert_ok "git add" || return 1
    git_local 60 commit -m "acceptance fixture"; assert_ok "git commit" || return 1
    git_local 60 branch dev; assert_ok "git branch dev" || return 1
  fi
  git_local 60 rev-parse HEAD
  note "repository ready: $PROJECT_REPO (main=${LAST_OUTPUT:-<unknown>}, branches: main, dev)"
}

open_runtime() {
  ce 120 status; assert_ok "runtime status" || return 1
  record "00-status.json"
  ce 120 project trust "$PROJECT_REPO" --yes; assert_ok "project trust" || return 1
  record "01-trust.json"
  ce 120 project list; assert_ok "project list" || return 1
  record "02-projects.json"
  PROJECT_ID="$(maybe_id "$LAST_OUTPUT" "0.id" "<project-id>")"
  note "PROJECT_ID=$PROJECT_ID"
}

# ---- acceptance steps -------------------------------------------------------

step_concurrency() {
  note "A1 — two SAFE Tasks really running together (the one Phase 2 item never proven)"
  ce 120 scheduler capacity get "$PROJECT_ID" --json; assert_ok "capacity get"
  record "a1-capacity-before.json"
  ce 120 task create "$PROJECT_ID" "Write lane-a/out.txt with the text lane-a."
  assert_ok "task create A"
  local task_a; task_a="$(maybe_id "$LAST_OUTPUT" id "<task-a>")"
  ce 120 task create "$PROJECT_ID" "Write lane-b/out.txt with the text lane-b."
  assert_ok "task create B"
  local task_b; task_b="$(maybe_id "$LAST_OUTPUT" id "<task-b>")"
  ce 120 task submit "$PROJECT_ID" "$task_a" 0; assert_ok "task submit A"
  local version_a; version_a="$(maybe_id "$LAST_OUTPUT" version "0")"
  ce 120 task submit "$PROJECT_ID" "$task_b" 0; assert_ok "task submit B"
  local version_b; version_b="$(maybe_id "$LAST_OUTPUT" version "0")"
  note "before running: verify both are SAFE, not UNKNOWN:"
  ce 60 project impact explain "$PROJECT_ID" "$task_a" --json
  note_exit "impact explain A" "(0 = SAFE_TO_PARALLELIZE)"
  ce 60 project impact explain "$PROJECT_ID" "$task_b" --json
  note_exit "impact explain B" "(0 = SAFE_TO_PARALLELIZE)"
  note "task A=$task_a (v$version_a)  task B=$task_b (v$version_b)"
  note "--- REAL MODEL REQUESTS BELOW (this is where the user spends provider credit) ---"
  ce 600 task run "$PROJECT_ID" "$task_a" "$version_a" --adapter pi --json
  note_exit "task run A" "(0 = STARTED; 3 = WAIT; 1 = REFUSED)"
  record "a1-run-a.json"
  ce 600 task run "$PROJECT_ID" "$task_b" "$version_b" --adapter pi --json
  note_exit "task run B" "(0 = STARTED; 3 = WAIT; 1 = REFUSED)"
  record "a1-run-b.json"
  note "--- the decisive observation: BOTH must be RUNNING while both are also still alive ---"
  ce 60 scheduler capacity get "$PROJECT_ID" --json
  note "  expect globalUsed=2 and two occupants"
  record "a1-capacity-running.json"
  ce 60 task status "$PROJECT_ID" "$task_a" --json; record "a1-task-a.json"
  ce 60 task status "$PROJECT_ID" "$task_b" --json; record "a1-task-b.json"
  note "  expect executions[0].state=RUNNING for both, distinct worktrees, distinct sessions"
  note "process check (the fact a status row cannot give):"
  note "  ps -Ao pid=,command= | grep -i ' pi ' | grep -v grep"
  ce 60 events list --project "$PROJECT_ID" --since 0 --limit 500 --json
  record "a1-events.json"
}

step_pause_resume() {
  note "A2 — pause -> resume -> cancel (ADR-0016) and the RECOVERY_REQUIRED observation"
  if [ -z "${TASK_ID:-}" ] || [ -z "${VERSION:-}" ]; then
    note "set TASK_ID=<uuid> and VERSION=<n> from 'task status --json' before running for real"
    return 0
  fi
  ce 120 task pause "$PROJECT_ID" "$TASK_ID" "$VERSION"; assert_ok "task pause"
  note "  expect stop=RELEASED, state=PAUSED; stop=UNCERTAIN means RECOVERY_REQUIRED (exit 1)"
  record "a2-pause.json"
  note "provider-process check: the pid from the Execution's session.processIdentity must be gone:"
  note "  ps -o pid=,command= -p <pid>    # expected: no rows"
  ce 120 task resume "$PROJECT_ID" "$TASK_ID" "$VERSION" --adapter pi --allow-unknown
  assert_ok "task resume"
  note "  exit 0 = a new Execution started in the SAME workspace on the SAME conversation"
  record "a2-resume.json"
  ce 60 task status "$PROJECT_ID" "$TASK_ID" --json
  note "  expect executions[0].resumeFromExecutionId == the paused Execution and the same"
  note "  session.providerSessionId as the predecessor"
  record "a2-status.json"
  ce 120 task cancel "$PROJECT_ID" "$TASK_ID" "$VERSION"; assert_ok "task cancel"
  record "a2-cancel.json"
  note ""
  note "A2-extra — observing RECOVERY_REQUIRED (read §2.A2 of the runbook before doing this)"
  note "  with a real Pi provider the pause path reaches UNCERTAIN only when the adapter cannot"
  note "  confirm the exit; the reachable real observation is the startup reconcile after a Runtime"
  note "  restart. The runbook gives the exact commands and the expected ledger rows."
}

step_revision_delivery() {
  note "A3 — revision delivery ledger (ADR-0028 / ADR-0051)"
  if [ -z "${TASK_ID:-}" ] || [ -z "${VERSION:-}" ]; then
    note "set TASK_ID=<uuid> and VERSION=<n> before running for real"
    return 0
  fi
  ce 120 task revision create "$PROJECT_ID" "$TASK_ID" "$VERSION" \
    --specification "Revised: also write lane-b/extra.txt." --reason "acceptance A3"
  assert_ok "task revision create"
  record "a3-revision-create.json"
  local delivery_id; delivery_id="$(maybe_id "$LAST_OUTPUT" "delivery.id" "<delivery-id>")"
  note "delivery=$delivery_id"
  ce 60 task revision delivery list "$PROJECT_ID" "$TASK_ID" --json
  note "  expect state=CHANNEL_UNSUPPORTED, evidence=capability:UNSUPPORTED, satisfied=false"
  record "a3-deliveries.json"
  note "--- the only honest disposition for Pi (this stops the Execution and starts a new one) ---"
  ce 300 task revision delivery resolve "$PROJECT_ID" "$TASK_ID" "$delivery_id" "$VERSION" \
    --action stop-and-restart --json
  note_exit "delivery resolve stop-and-restart" "(0 only when the delivery ends satisfied)"
  record "a3-resolve.json"
  ce 60 task revision delivery get "$PROJECT_ID" "$delivery_id" --json
  record "a3-delivery-get.json"
}

step_knowledge() {
  note "A4 — Project Knowledge handed to the provider (ADR-0041 / ADR-0051)"
  note "prerequisite: .codeestra/instructions/<name>.md on the project main ref with a unique token"
  if [ -z "${TASK_ID:-}" ]; then
    note "set TASK_ID=<uuid> before running for real"
    return 0
  fi
  ce 60 project knowledge validate "$PROJECT_ID" --json; assert_ok "knowledge validate"
  record "a4-validate.json"
  ce 60 project knowledge resolve "$PROJECT_ID" "$TASK_ID" --json
  note "  expect entryCount>0, appliesToTask=true for the instruction, state=RESOLVED"
  record "a4-resolve.json"
  ce 60 project knowledge show "$PROJECT_ID" --json
  note "  after the run: this is the authoritative record of which snapshot the Execution used"
  record "a4-show.json"
  note "after the model turn, the decisive check is in the transcript:"
  note "  CODEESTRA_HOME=$RUNTIME_HOME bun run codeestra task transcript $PROJECT_ID $TASK_ID --json"
}

step_plugins_gate() {
  note "A5 — third-party extension vs. the Codeestra gate (ADR-0044; controlled and revocable)"
  ce 60 agent plugins list --project "$PROJECT_ID" --adapter pi --json
  note "  exit 1 means the adapter cannot apply a selection; 0 with candidates listed means it can"
  record "a5-plugins-list.json"
  note "--- the controlled observation: see §2.A5 of the runbook for the probe extension ---"
  note "  FULL  : a third-party tool is ALLOWed with NO Attention (classifyPiTool returns ALLOW)"
  note "  STRICT: the same tool is rejected with 'Codeestra rejected unknown tool: <name>'"
  note "  either way: a side effect performed directly by extension code never reaches tool_call"
  ce 60 events list --project "$PROJECT_ID" --since 0 --limit 500 --json
  record "a5-events.json"
}

step_prose_question() {
  note "A6 — prose question: WAITING_FOR_USER + Execution RUNNING + Session EXITED (ADR-0043)"
  ce 60 settings prose-question-attention; record "a6-setting.json"
  note "prompt the model so it asks its question in ordinary prose and ends the turn without a tool"
  ce 60 attention list "$PROJECT_ID"
  note "  expect one kind=QUESTION / responseType=VALUE row with prompt.kind=codeestra.prose-question"
  record "a6-attention.json"
  note "then, with the attention id:"
  note "  attention answer ... value <text>   -> must be refused, PROSE_QUESTION_RESOLUTION_REQUIRED"
  note "  attention resolve ... --answer|--dismiss  -> exit 0, Task back to RUNNING"
}

step_terminal_handoff() {
  note "A7 — native terminal takeover, typed input, and release back to automation (ADR-0026)"
  if [ -z "${SESSION_ID:-}" ]; then
    note "set SESSION_ID=<uuid> (from task status -> executions[].session.sessionId) first"
    return 0
  fi
  ce 60 session handoff status "$PROJECT_ID" "$SESSION_ID" --json
  note "  read the capabilities block: ptyTransport/successorProcessStart/nativeTerminalAttach/…"
  record "a7-status-pre.json"
  ce 60 session handoff request "$PROJECT_ID" "$SESSION_ID" takeover
  assert_ok "request takeover"
  record "a7-request.json"
  local attempt=1
  while [ "$attempt" -le 6 ]; do
    ce 60 session handoff status "$PROJECT_ID" "$SESSION_ID" --json
    record "a7-status-$attempt.json"
    note "  attempt $attempt: waiting for the safe point before admit"
    attempt=$((attempt + 1))
  done
  note "when the safe point is reached:"
  note "  session handoff admit \"$PROJECT_ID\" \"$SESSION_ID\""
  note "  session handoff terminal read \"$PROJECT_ID\" \"$SESSION_ID\""
  note "  session handoff terminal write \"$PROJECT_ID\" \"$SESSION_ID\" --text 'probe line'"
  note "  session handoff release \"$PROJECT_ID\" \"$SESSION_ID\""
  note "  exit 0 on release means the provider exited, ownership was re-checked and the successor"
  note "  continued the SAME session file; the exit code itself is audit data only"
}

step_promotion() {
  note "A8 — the real GitHub promotion path (ADR-0047 / ADR-0052)"
  note "THIS STEP MOVES REMOTE REFS. It needs the user's explicit go-ahead for a real push."
  note "The script never pushes by itself; it prints and records the calls for the user to run."
  if [ -z "${BATCH_ID:-}" ] || [ -z "${DEV_COMMIT:-}" ] || [ -z "${MAIN_COMMIT:-}" ]; then
    note "set BATCH_ID / DEV_COMMIT (full sha) / MAIN_COMMIT (full sha) before running for real"
    return 0
  fi
  ce 1800 promotion full-suite run "$PROJECT_ID" --dev-commit "$DEV_COMMIT" --json
  note "  exit 0 only when state=PASSED; that evidence binds candidate SHA + policy digest + lockfile"
  assert_ok "promotion full-suite run"
  record "a8-full-suite.json"
  ce 120 promotion prepare "$PROJECT_ID" "$BATCH_ID" "$DEV_COMMIT" "$MAIN_COMMIT"
  assert_ok "promotion prepare"
  record "a8-prepare.json"
  local promotion_id; promotion_id="$(maybe_id "$LAST_OUTPUT" promotionId "<promotion-id>")"
  ce 600 promotion promote "$PROJECT_ID" "$promotion_id" --json
  note_exit "promotion promote (push step)" "(3 = pushed, awaiting pull — not a failure)"
  record "a8-promote-push.json"
  note "in the main checkout (the user runs this, not the script):"
  note "  cd <main-clone> && git fetch origin && git merge --ff-only origin/dev"
  note "then call promote again from the main checkout so it closes out, restarts and pushes origin/main:"
  ce 900 promotion promote "$PROJECT_ID" "$promotion_id" --json
  note_exit "promotion promote (close-out)" "(0 only when phase=COMPLETE)"
  record "a8-promote-complete.json"
}

# ---- retention / cleanup ----------------------------------------------------

print_guidance() {
  if [ "$DRY_RUN" -eq 1 ]; then
    note "dry-run: nothing was created, no model was called, no ref was moved, no token was printed"
    return 0
  fi
  log ""
  log "Evidence bundle: $EVIDENCE_DIR"
  log "Runtime home:    $RUNTIME_HOME   (keep it: SQLite DB, worktrees, provider session files)"
  log "Project repo:    $PROJECT_REPO"
  log ""
  log "Retention (read docs/notes/real-provider-acceptance-runbook.md §4 before cleaning up):"
  log "  * If any step failed, keep everything and copy the evidence out first."
  log "  * Stop the isolated Runtime only:"
  log "      CODEESTRA_HOME=$RUNTIME_HOME bun run codeestra stop"
  log "  * Never delete a worktree before checking it:"
  log "      CODEESTRA_HOME=$RUNTIME_HOME bun run codeestra reclaim plan --all-projects"
  log "  * Then, and only then: rm -rf $TEMP_ROOT"
}

cleanup_on_success() {
  [ "$KEEP" -eq 0 ] || return 0
  [ "${#FAILURES[@]}" -eq 0 ] || { warn "not cleaning up: failures were recorded"; return 0; }
  if [ -n "$TEMP_ROOT" ] && [ -d "$TEMP_ROOT" ]; then
    rm -rf "$TEMP_ROOT"
    log "removed $TEMP_ROOT (--clean)"
  fi
}

# ---- main -------------------------------------------------------------------

main() {
  note "repository under test: $REPO_ROOT"
  if [ "$DRY_RUN" -eq 1 ]; then
    note "MODE: dry-run (default). No command is executed."
  else
    note "MODE: real. The user drives every model request."
  fi
  note "this script never runs 'codeestra ui'; no Web UI token can appear in this output"
  setup_environment
  if wants_any_setup_step; then
    prepare_repository
  fi
  open_runtime

  if wants_step concurrency; then step_concurrency; fi
  if wants_step pause-resume; then step_pause_resume; fi
  if wants_step revision-delivery; then step_revision_delivery; fi
  if wants_step knowledge; then step_knowledge; fi
  if wants_step plugins-gate; then step_plugins_gate; fi
  if wants_step prose-question; then step_prose_question; fi
  if wants_step terminal-handoff; then step_terminal_handoff; fi
  if wants_step promotion; then step_promotion; fi

  print_guidance
  if [ "${#FAILURES[@]}" -gt 0 ]; then
    warn "recorded failures:"
    for failure in "${FAILURES[@]}"; do warn "  - $failure"; done
    exit 1
  fi
  cleanup_on_success
  log "done."
}

trap 'warn "aborted; the temporary root was kept: ${TEMP_ROOT:-<none>}"' ERR
main "$@"
