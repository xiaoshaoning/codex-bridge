#!/usr/bin/env bash
#
# codex-regression.sh - Regression test for codex CLI + bridge integration
#
# Validates the full pipeline: OpenAI Responses API format -> DeepSeek Chat Completions -> back to Responses API
#
# Usage:
#   ./scripts/codex-regression.sh              # Run all tests
#   ./scripts/codex-regression.sh --setup       # Start bridge if not running, then run tests
#   ./scripts/codex-regression.sh --no-codex    # Test only bridge health (skip codex exec)
#   ./scripts/codex-regression.sh --setup --no-codex  # Start bridge, test health only
#
# Returns:
#   0 - All tests passed
#   1 - One or more tests failed
#

set -euo pipefail

# ----- Configuration ----------------------------------------------------------
BRIDGE_PORT=8098
BRIDGE_URL="http://localhost:${BRIDGE_PORT}"
HEALTH_URL="${BRIDGE_URL}/health"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BRIDGE_PID_FILE="${PROJECT_ROOT}/.bridge.pid"
BRIDGE_LOG_FILE="${PROJECT_ROOT}/log/bridge-regression.log"

# ----- Flags ------------------------------------------------------------------
MODE_SETUP=false
MODE_NO_CODEX=false

for arg in "$@"; do
  case "$arg" in
    --setup)
      MODE_SETUP=true
      ;;
    --no-codex)
      MODE_NO_CODEX=true
      ;;
    *)
      echo "Usage: $0 [--setup] [--no-codex]"
      exit 1
      ;;
  esac
  shift
done

# ----- Helper functions -------------------------------------------------------
pass() {
  echo "  PASS: $1"
}

fail() {
  echo "  FAIL: $1"
  FAILED=1
}

die() {
  echo "FATAL: $1" >&2
  exit 1
}

# ----- Setup: start bridge if needed ------------------------------------------
start_bridge() {
  if curl -sf "${HEALTH_URL}" > /dev/null 2>&1; then
    echo "[setup] Bridge is already running at ${BRIDGE_URL}"
    return 0
  fi

  echo "[setup] Starting bridge server..."
  mkdir -p "${PROJECT_ROOT}/log"
  cd "${PROJECT_ROOT}"

  # Start bridge in background, capture PID
  npm start >> "${BRIDGE_LOG_FILE}" 2>&1 &
  local pid=$!
  echo $pid > "${BRIDGE_PID_FILE}"

  # Wait for bridge to become healthy (up to 15 seconds)
  local waited=0
  while [ $waited -lt 15 ]; do
    if curl -sf "${HEALTH_URL}" > /dev/null 2>&1; then
      echo "[setup] Bridge is ready (PID $pid, ~${waited}s)"
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done

  echo "[setup] Bridge failed to start within 15 seconds. Check log: ${BRIDGE_LOG_FILE}" >&2
  return 1
}

# ----- Cleanup handler --------------------------------------------------------
cleanup() {
  local exit_code=$?
  if [ "${MODE_SETUP}" = true ] && [ -f "${BRIDGE_PID_FILE}" ]; then
    local pid
    pid=$(cat "${BRIDGE_PID_FILE}" 2>/dev/null || true)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      echo "[cleanup] Stopping bridge (PID $pid)..."
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
    rm -f "${BRIDGE_PID_FILE}"
  fi
  exit $exit_code
}
trap cleanup EXIT

# ----- Main -------------------------------------------------------------------
FAILED=0
echo ""
echo "========================================"
echo " Codex Bridge Regression Tests"
echo "========================================"
echo ""

# ----- Setup phase ------------------------------------------------------------
if [ "${MODE_SETUP}" = true ]; then
  echo "--- Setup ---"
  start_bridge || die "Could not start bridge server"
  echo ""
fi

# ----- Test 1: Health endpoint ------------------------------------------------
echo "--- Test 1: Bridge health endpoint ---"
HEALTH_RESPONSE=$(curl -sf "${HEALTH_URL}" 2>&1) || {
  fail "Bridge not running at ${HEALTH_URL}"
  echo ""
  echo "========================================"
  echo " Results: $([ "${FAILED}" = 0 ] && echo 'ALL PASSED' || echo 'SOME FAILED')"
  echo "========================================"
  exit 1
}

# Validate the response is valid JSON with status "ok"
HEALTH_STATUS=$(echo "$HEALTH_RESPONSE" | grep -o '"status"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*:"//;s/"//')
if [ "${HEALTH_STATUS}" = "ok" ]; then
  pass "Health endpoint returned status=ok"
else
  fail "Health endpoint did not return status=ok (got: ${HEALTH_STATUS})"
fi
echo ""

# ----- Test 2: Bridge API conversion (tests the actual pipeline) -----------------
if [ "${MODE_NO_CODEX}" = true ]; then
  echo "--- Test 2: Bridge API conversion ---"
  echo "  SKIP: --no-codex flag set, skipping API conversion test"
  echo ""
else
  echo "--- Test 2: Bridge API conversion (OpenAI Responses API -> DeepSeek -> Responses API) ---"
  echo "  POST ${BRIDGE_URL}/v1/responses { model: deepseek-chat, input: \"What is 2+2?\" }"

  API_RESPONSE=$(curl -sf -X POST "${BRIDGE_URL}/v1/responses" \
    -H "Content-Type: application/json" \
    -d '{"model":"deepseek-chat","input":"What is 2+2?"}' 2>&1) || {
    fail "Bridge API request failed"
  }

  # Verify it's valid JSON (bridge response format)
  if echo "${API_RESPONSE}" | grep -q '"id"' && echo "${API_RESPONSE}" | grep -q '"choices"'; then
    pass "Bridge returned valid response (id + choices fields)"
  else
    fail "Bridge response missing expected Responses API fields"
    echo "  Response preview: $(echo "${API_RESPONSE}" | head -c 200)"
  fi

  # Check the output contains "4" using grep
  if echo "${API_RESPONSE}" | grep -qi "4"; then
    pass "Output contains '4' - Full pipeline validated"
  else
    fail "Output does not contain '4' (expected answer to 'What is 2+2?')"
    echo "  Response preview: $(echo "${API_RESPONSE}" | head -c 500)"
  fi
  echo ""
fi

# Results summary
echo "========================================"
if [ "${FAILED}" = 0 ]; then
  echo " Results: ALL PASSED"
  exit 0
else
  echo " Results: SOME FAILED"
  exit 1
fi
echo "========================================"
