#!/usr/bin/env bash
#
# mtplx-postupgrade.sh — detect (and optionally repair) the two things an MTPLX
# upgrade silently breaks for this dashboard.
#
#   1. STALE RUNTIME VENV. MTPLX.app ships its own Python + an mtplx wheel and
#      pip-installs it into ~/Library/Application Support/MTPLX/runtime-venv.
#      Sparkle updates the .app but does NOT always re-provision that venv, so
#      the app and the code that actually serves requests drift apart. `mtplx
#      --version` reports the venv (the truth); the app's About box reports the
#      bundle. Nothing errors.
#
#   2. REVERTED TRANSCRIPT PATCH. patches/mtplx-full-transcript-capture.patch
#      edits the *installed* package, so any pip install reverts it. The failure
#      is asymmetric: MTPLX_DASHBOARD_CAPTURE_BODIES=1 lives in the launchd plist
#      and survives, while the code reading it is destroyed — so the server looks
#      healthy and the dashboard just quietly falls back to 180-char previews.
#
# Usage:
#   ./scripts/mtplx-postupgrade.sh            # check only
#   ./scripts/mtplx-postupgrade.sh --fix      # re-apply the patch if missing
#   ./scripts/mtplx-postupgrade.sh --venv /custom/path
#
# Exit codes: 0 = healthy, 1 = drift found (unrepaired), 2 = error.

set -uo pipefail

VENV="${MTPLX_VENV:-$HOME/Library/Application Support/MTPLX/runtime-venv}"
APP="${MTPLX_APP:-/Applications/MTPLX.app}"
FIX=0
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PATCH="$REPO_ROOT/patches/mtplx-full-transcript-capture.patch"

while [ $# -gt 0 ]; do
  case "$1" in
    --fix)   FIX=1; shift ;;
    --venv)  VENV="${2:?--venv needs a path}"; shift 2 ;;
    --patch) PATCH="${2:?--patch needs a path}"; shift 2 ;;
    -h|--help) sed -n '2,28p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

ok()   { printf '  \033[32mOK\033[0m    %s\n' "$1"; }
warn() { printf '  \033[33mDRIFT\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; }
info() { printf '        %s\n' "$1"; }

DRIFT=0

# --- locate the venv's site-packages -----------------------------------------
[ -x "$VENV/bin/python" ] || { bad "no python at $VENV/bin/python"; exit 2; }
SP="$("$VENV/bin/python" -c 'import sysconfig;print(sysconfig.get_paths()["purelib"])' 2>/dev/null)"
[ -n "$SP" ] && [ -d "$SP" ] || { bad "could not resolve site-packages under $VENV"; exit 2; }
TARGET="$SP/mtplx/server/openai.py"
[ -f "$TARGET" ] || { bad "mtplx not installed in the venv ($TARGET missing)"; exit 2; }

echo "MTPLX post-upgrade check"
info "venv:   $VENV"
info "target: $TARGET"
echo

# --- 1. stale venv ------------------------------------------------------------
VENV_VER="$("$VENV/bin/python" -c 'import importlib.metadata as m;print(m.version("mtplx"))' 2>/dev/null || echo unknown)"
if [ -d "$APP" ]; then
  APP_VER="$(defaults read "$APP/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo unknown)"
  WHEEL="$(ls "$APP/Contents/Resources/Runtime/"*.whl 2>/dev/null | head -1)"
  WHEEL_VER="$(basename "${WHEEL:-}" 2>/dev/null | sed -E 's/^mtplx-([^-]+)-.*/\1/')"
  if [ "$VENV_VER" = "$APP_VER" ]; then
    ok "runtime venv matches app bundle (mtplx $VENV_VER)"
  else
    DRIFT=1
    warn "STALE VENV: app is $APP_VER but the serving venv is mtplx $VENV_VER"
    if [ -n "${WHEEL:-}" ]; then
      info "the app already ships mtplx $WHEEL_VER — re-provision with:"
      info "  '$VENV/bin/python' -m pip install --upgrade '$WHEEL'"
      info "(stop the server first: mlx-metal is a native dylib)"
    fi
  fi
else
  info "app bundle not found at $APP — skipping venv/app comparison"
  ok "venv mtplx $VENV_VER"
fi

# --- 2. patch applied? --------------------------------------------------------
# NB: `grep -c` prints 0 AND exits non-zero on no-match, so `|| echo 0` would
# emit "0\n0" and break the numeric test. `|| true` keeps grep's own count.
MARKERS="$(grep -c '_dashboard_capture_bodies_enabled' "$TARGET" 2>/dev/null || true)"
MARKERS="${MARKERS:-0}"
if [ "$MARKERS" -gt 0 ]; then
  ok "transcript patch present"
else
  DRIFT=1
  warn "TRANSCRIPT PATCH MISSING — dashboard will show 180-char previews only"
  if [ "$FIX" = "1" ]; then
    [ -f "$PATCH" ] || { bad "patch file not found: $PATCH"; exit 2; }
    STAMP="$(date +%Y%m%d-%H%M%S)"
    cp -p "$TARGET" "$TARGET.stock-$STAMP" && info "backed up stock -> $TARGET.stock-$STAMP"
    if ( cd "$SP" && patch -p1 --forward < "$PATCH" >/dev/null 2>&1 ); then
      if "$VENV/bin/python" -m py_compile "$TARGET" 2>/dev/null; then
        ok "patch re-applied and compiles clean"
        MARKERS=1
        NEEDS_RESTART=1
      else
        bad "patch applied but the file does NOT compile — restoring stock"
        cp -p "$TARGET.stock-$STAMP" "$TARGET"
        exit 2
      fi
    else
      bad "patch failed to apply — re-target the anchors by hand (see patches/README.md)"
      exit 2
    fi
  else
    info "re-apply with: $0 --fix"
  fi
fi

# --- 3. completion-site coverage ---------------------------------------------
# Upstream adds a completion site per scheduler; 2.6.0 added _finalize_mtp_batch_generation
# and the then-current patch silently stopped capturing on that path.
if [ "$MARKERS" -gt 0 ]; then
  SITES="$(grep -c '_dashboard_record_completion(state, envelope=envelope, stats=stats)' "$TARGET" 2>/dev/null || true)"
  CAPS="$(grep -c '_dashboard_capture_response_text(state,' "$TARGET" 2>/dev/null || true)"
  SITES="${SITES:-0}"; CAPS="${CAPS:-0}"
  if [ "$SITES" -eq "$CAPS" ]; then
    ok "all $SITES completion sites covered"
  else
    DRIFT=1
    warn "COVERAGE GAP: $SITES completion sites but only $CAPS capture calls"
    info "upstream added a path this patch doesn't cover. Find it with:"
    info "  grep -n '_dashboard_record_completion(state, envelope=envelope, stats=stats)' '$TARGET'"
    info "add _dashboard_capture_response_text(state, generated.get(\"text\")) after it,"
    info "then regenerate patches/mtplx-full-transcript-capture.patch"
  fi
fi

# --- 4. is capture actually switched on? -------------------------------------
PID="$(pgrep -f 'mtplx.server.openai' 2>/dev/null | head -1)"
if [ -n "$PID" ]; then
  if ps -wwEo command= -p "$PID" 2>/dev/null | tr ' ' '\n' | grep -q 'MTPLX_DASHBOARD_CAPTURE_BODIES=\(1\|true\|yes\|on\)'; then
    ok "MTPLX_DASHBOARD_CAPTURE_BODIES enabled in the running server"
  else
    DRIFT=1
    warn "server is running WITHOUT MTPLX_DASHBOARD_CAPTURE_BODIES — capture is off"
    info "set it in the launchd plist's EnvironmentVariables, then reload the job"
  fi
else
  info "mtplx server not running — start it, then re-run this check"
fi

echo
if [ "${NEEDS_RESTART:-0}" = "1" ]; then
  echo "Patch re-applied. RESTART the server to load it:"
  echo "  launchctl kickstart -k gui/\$(id -u)/com.local.mtplx-server"
  echo "Then verify:"
  echo "  curl -s http://127.0.0.1:8000/metrics | python3 -c 'import sys,json; r=json.load(sys.stdin)[\"latest\"]; print(\"messages:\", len(r.get(\"request_messages_full\") or [])); print(\"response chars:\", len(r.get(\"response_text\") or \"\"))'"
  exit 0
fi

if [ "$DRIFT" = "0" ]; then
  echo "All good — nothing to repair."
  exit 0
fi
echo "Drift found. Re-run with --fix to repair what's automatable."
exit 1
