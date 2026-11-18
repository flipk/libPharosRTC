#!/usr/bin/env bash
set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "========================================================"
echo "libPharosRTC Phase 6 Impairment Test Runner"
echo "========================================================"

mkdir -p test-results

cleanup() {
    echo "Cleaning up background processes and impairment rules..."
    if [ -n "$VITE_PID" ] && kill -0 "$VITE_PID" 2>/dev/null; then
        kill -9 "$VITE_PID" 2>/dev/null || true
    fi
    if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
        kill -9 "$SERVER_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT

# 1. Build TypeScript and Vite bundle
echo "[1/4] Building TypeScript client and Vite assets..."
npm run build

# 2. Check for Linux tc netem module
if command -v tc &>/dev/null && [ "$(id -u)" -eq 0 ]; then
    echo "[2/4] Applying tc netem impairment rules..."
    tc qdisc add dev lo root netem delay 15ms 3ms loss 12% 2>/dev/null || \
    tc qdisc change dev lo root netem delay 15ms 3ms loss 12% 2>/dev/null || true
else
    echo "[2/4] Running without root tc netem (using transport-level impairment simulation)..."
fi

# 3. Execute E2E Playwright Test Suite
echo "[3/4] Running Playwright E2E Impairment Test Suite..."
npx playwright test

# 4. Generate Benchmark Report
echo "[4/4] Generating BENCHMARK_REPORT.md..."
venv/bin/python3 scripts/generate_report.py

# Reset tc qdisc if root
if command -v tc &>/dev/null && [ "$(id -u)" -eq 0 ]; then
    tc qdisc del dev lo root 2>/dev/null || true
fi

echo "========================================================"
echo "Phase 6 Impairment Verification Completed Successfully!"
echo "========================================================"
