#!/usr/bin/env bash
# Builds and runs the standalone unit tests. Arguments are passed to the test binary.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cmake -S "$ROOT/host" -B "$ROOT/build/host-tests" -DCMAKE_BUILD_TYPE=Release >/dev/null
cmake --build "$ROOT/build/host-tests" -j 2>&1 | tail -3
"$ROOT/build/host-tests/bridge_tests" "$@"
