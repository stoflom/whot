#!/usr/bin/env bash
# run_tests.sh — run the WhoT test suites, summarize results, clean up.
#
# Mirrors .github/workflows/ci.yml:
#   frontend      npx tsc --noEmit && npm run lint && npm test      (vitest)
#   backend       npm run build && (cd src-tauri && cargo test)
#   python        python3 -m pytest test/ -q
#   python-heavy  same as python (decode/detector tests self-skip
#                 without cv2/PIL/tifffile — CI runs them nightly)
#   gui           npm run build && dump_snap.py && server.py :8123
#                 && gui_check.py  (test/gui-mock, WebKitGTK/Firefox)
#
# Usage:
#   ./run_tests.sh [SUITE...] [OPTIONS]
#
# Suites (default: all):
#   -f, --frontend     vitest suite (+ tsc, lint)
#   -b, --backend      Rust cargo test (needs dist/ -> runs npm run build)
#   -p, --python       pytest test/
#   -P, --python-heavy pytest including decode/detector tests
#   -g, --gui          GUI contract checks (test/gui-mock)
#   -a, --all          all of the above (default)
#
# Options:
#   -k, --kill-port    kill whatever process occupies the mock-server
#                      port before the GUI suite starts
#   -B, --kill-browsers sweep dangling MiniBrowser / WebKitWebDriver
#                      processes before (and after) the GUI suite
#       --port N       mock-server port (default 8123)
#   -n, --dry-run      print what would run, run nothing
#   -h, --help         this help
#
# Exit code: 0 every selected suite passed · 1 test failure ·
#             2 a suite could not run (config/environment — e.g. the
#             mock-server port busy; never counted as a test failure)

set -u
cd "$(dirname "$0")"

MOCK_PORT=8123
DO_FRONTEND=0; DO_BACKEND=0; DO_PYTHON=0; DO_HEAVY=0; DO_GUI=0
KILL_PORT=0; KILL_BROWSERS=0; DRY_RUN=0
WANT_ALL=1   # flipped to 0 as soon as one suite is named explicitly

die()  { echo "run_tests.sh: $*" >&2; exit 2; }
info() { echo "[run_tests] $*"; }

usage() { sed -n '2,33p' "$0"; }

while [ $# -gt 0 ]; do
  case "$1" in
    -f|--frontend)     DO_FRONTEND=1; WANT_ALL=0 ;;
    -b|--backend)      DO_BACKEND=1;  WANT_ALL=0 ;;
    -p|--python)       DO_PYTHON=1;   WANT_ALL=0 ;;
    -P|--python-heavy) DO_HEAVY=1;    WANT_ALL=0 ;;
    -g|--gui)          DO_GUI=1;      WANT_ALL=0 ;;
    -a|--all)          WANT_ALL=1 ;;
    -k|--kill-port)    KILL_PORT=1 ;;
    -B|--kill-browsers) KILL_BROWSERS=1 ;;
    --port)            shift; [ $# -gt 0 ] || die "--port needs a value"
                       MOCK_PORT=$1 ;;
    -n|--dry-run)      DRY_RUN=1 ;;
    -h|--help)         usage; exit 0 ;;
    *)                 die "unknown option: $1 (try --help)" ;;
  esac
  shift
done

if [ "$WANT_ALL" -eq 1 ]; then
  DO_FRONTEND=1; DO_BACKEND=1; DO_PYTHON=1; DO_HEAVY=1; DO_GUI=1
fi

# ---------------------------------------------------------------- helpers

SERVER_PID=""
RAN_GUI=0
PIDS_BEFORE_BROWSERS=""
RESULTS=()          # "suite|status|seconds"
START_TS=$(date +%s)

port_busy() { fuser -s "$MOCK_PORT/tcp" 2>/dev/null; }

kill_port_occupant() {
  if port_busy; then
    info "killing process on port $MOCK_PORT: $(fuser "$MOCK_PORT/tcp" 2>/dev/null | tr -s ' \t' ' ')"
    fuser -k "$MOCK_PORT/tcp" 2>/dev/null
    sleep 0.5
    port_busy && { sleep 1; port_busy && info "WARNING: port $MOCK_PORT still busy"; }
  fi
}

# Precise matching only: pgrep -f on arbitrary substrings would match
# unrelated processes whose command line merely mentions the words
# (editors, greps, test harnesses...). WebKitWebDriver is matched by
# exact process name (-x); MiniBrowser by its full exec path.
MINIBROWSER_PATH=/usr/libexec/webkit2gtk-4.1/MiniBrowser

browser_pids() {
  { pgrep -x WebKitWebDriver 2>/dev/null
    pgrep -f "$MINIBROWSER_PATH" 2>/dev/null; } | sort -u || true
}

kill_dangling_browsers() {
  local pids; pids=$(browser_pids)
  if [ -n "$pids" ]; then
    info "sweeping dangling browser processes: $(echo "$pids" | tr '\n' ' ')"
    # TERM first, then KILL for survivors
    pkill -TERM -x WebKitWebDriver 2>/dev/null || true
    pkill -TERM -f "$MINIBROWSER_PATH" 2>/dev/null || true
    sleep 0.5
    pkill -KILL -x WebKitWebDriver 2>/dev/null || true
    pkill -KILL -f "$MINIBROWSER_PATH" 2>/dev/null || true
  else
    info "no dangling MiniBrowser/WebKitWebDriver processes"
  fi
}

cleanup() {
  local rc=$?
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    info "stopping mock server (pid $SERVER_PID)"
    kill "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
  fi
  # Browser processes spawned during this run: anything present now that
  # was not there before (only when the GUI suite actually ran, or when
  # --kill-browsers was given).
  if [ "$RAN_GUI" -eq 1 ] || [ "$KILL_BROWSERS" -eq 1 ]; then
    local new_pids
    new_pids=$(comm -13 \
      <(printf '%s\n' $PIDS_BEFORE_BROWSERS | sort -u) \
      <(browser_pids | sort -u) 2>/dev/null)
    if [ -n "$new_pids" ]; then
      info "killing browser processes left by this run: $(echo "$new_pids" | tr '\n' ' ')"
      kill $new_pids 2>/dev/null
      sleep 0.5
      kill -9 $new_pids 2>/dev/null
    fi
  fi
  # pycache from the pytest runs
  find test -type d -name '__pycache__' -exec rm -rf {} + 2>/dev/null
  if [ "$rc" -eq 0 ]; then
    info "all done — everything passed"
  elif [ "$rc" -eq 2 ]; then
    info "finished — a suite could not run (config), no test failures"
  else
    info "finished with test failures (exit $rc)"
  fi
  exit "$rc"
}
trap cleanup EXIT INT TERM

record() { # suite rc seconds
  local status; [ "$2" -eq 0 ] && status=PASS || status=FAIL
  RESULTS+=("$1|$status|$3")
  printf '\n[run_tests] %s: %s (%ss)\n\n' "$1" "$status" "$3"
}

run_suite() { # name cmd...
  local name=$1; shift
  if [ "$DRY_RUN" -eq 1 ]; then
    info "would run: $name  ->  $*"
    return 0
  fi
  local t0 t1 rc
  t0=$(date +%s)
  info "=== $name: $*"
  "$@"; rc=$?
  t1=$(date +%s)
  record "$name" "$rc" "$((t1 - t0))"
  return "$rc"
}

need() { command -v "$1" >/dev/null 2>&1 || die "missing dependency: $1"; }
need npm; need node

if [ ! -d node_modules ]; then
  die "node_modules missing — run 'npm ci' first"
fi

if [ "$DRY_RUN" -eq 0 ]; then
  PIDS_BEFORE_BROWSERS=$(browser_pids)
fi

if [ "$KILL_BROWSERS" -eq 1 ] && [ "$DRY_RUN" -eq 0 ]; then
  kill_dangling_browsers
  PIDS_BEFORE_BROWSERS=""   # post-sweep baseline
fi

# ---------------------------------------------------------------- build

BUILD_DONE=0
build_frontend() {
  if [ "$BUILD_DONE" -eq 1 ]; then return 0; fi
  if [ "$DO_BACKEND" -eq 1 ] || [ "$DO_GUI" -eq 1 ]; then
    if run_suite "build (vite)" npm run build; then
      BUILD_DONE=1; return 0
    fi
    return 1
  fi
}

# ---------------------------------------------------------------- suites

if [ "$DO_FRONTEND" -eq 1 ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    info "would run: frontend (tsc --noEmit; npm run lint; npm test)"
    RESULTS+=("frontend|SKIP|0")
  else
    local_ok=1
    for step in "typecheck:npx tsc --noEmit" "lint:npm run lint" "vitest:npm test"; do
      label=${step%%:*}; cmd=${step#*:}
      t0=$(date +%s)
      info "=== frontend/$label: $cmd"
      if $cmd; then record "frontend/$label" 0 "$(( $(date +%s) - t0 ))"
      else record "frontend/$label" 1 "$(( $(date +%s) - t0 ))"; local_ok=0; break; fi
    done
    [ "$local_ok" -eq 1 ] || RESULTS+=("frontend|FAIL|-")
  fi
fi

if [ "$DO_BACKEND" -eq 1 ]; then
  build_frontend || true
  # no subshell: run_suite must record into this shell's RESULTS array
  if pushd src-tauri >/dev/null 2>&1; then
    run_suite "backend (cargo test)" cargo test || true
    popd >/dev/null
  else
    info "cannot enter src-tauri"
    RESULTS+=("backend|FAIL|-")
  fi
fi

if [ "$DO_PYTHON" -eq 1 ] || [ "$DO_HEAVY" -eq 1 ]; then
  run_suite "python (pytest)" python3 -m pytest test/ -q \
    || RESULTS+=("python|FAIL|-")
fi

if [ "$DO_GUI" -eq 1 ]; then
  RAN_GUI=1
  build_frontend || true
  if [ "$DRY_RUN" -eq 0 ]; then
    run_suite "gui (dump_snap)" python3 test/gui-mock/dump_snap.py || true

    [ "$KILL_PORT" -eq 1 ] && kill_port_occupant
    if port_busy; then
      info "port $MOCK_PORT busy — the GUI suite did NOT run; pass --kill-port to free it"
      # a busy port is a config problem, not a test failure — record as
      # skipped (exit code 2), never as FAIL
      RESULTS+=("gui|SKIP (port $MOCK_PORT busy — suite not run)|-")
    else
      info "starting mock server on :$MOCK_PORT"
      python3 test/gui-mock/server.py "$MOCK_PORT" &
      SERVER_PID=$!
      # give it a moment, then verify it is listening
      for _ in 1 2 3 4 5 6 7 8 9 10; do
        port_busy && break
        sleep 0.3
      done
      if ! port_busy; then
        info "mock server failed to start — the GUI suite did NOT run"
        RESULTS+=("gui|SKIP (mock server did not start)|-")
      else
        run_suite "gui (gui_check)" python3 test/gui-mock/gui_check.py "$MOCK_PORT" \
          || RESULTS+=("gui|FAIL|-")
      fi
    fi
  else
    info "would run: gui suite (dump_snap; server :$MOCK_PORT; gui_check)"
    RESULTS+=("gui|SKIP|0")
  fi
fi

# ---------------------------------------------------------------- summary

if [ "$DRY_RUN" -eq 1 ]; then
  info "dry run — nothing executed"
  exit 0
fi

TOTAL_ELAPSED=$(( $(date +%s) - START_TS ))
echo
echo "================= SUMMARY ================="
printf '%-28s %-6s %s\n' "SUITE" "STATUS" "TIME"
fail=0; skipped=0
for r in "${RESULTS[@]}"; do
  IFS='|' read -r name status secs <<<"$r"
  printf '%-28s %-6s %ss\n' "$name" "$status" "$secs"
  case "$status" in
    FAIL) fail=1 ;;
    SKIP*) skipped=$((skipped + 1)) ;;
  esac
done
echo "-------------------------------------------"
printf 'total: %ss\n' "$TOTAL_ELAPSED"
if [ "$fail" -eq 1 ]; then
  echo "RESULT: FAIL"
  exit 1
fi
if [ "$skipped" -gt 0 ]; then
  echo "RESULT: INCOMPLETE — $skipped suite(s) could not run (config/environment), no test failures"
  exit 2
fi
echo "RESULT: PASS"
