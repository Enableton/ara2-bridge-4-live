#!/usr/bin/env bash
# Builds BridgeHost (Release, arm64) inside the SDK's CMake project and prints its path.
# Run tools/setup_sdk.sh first. BUILD_TAIL sets how many xcodebuild output lines are shown.
# ARABRIDGE_DEPLOYMENT_TARGET (for example 13.0) sets the oldest macOS the binary runs on and ARABRIDGE_BUILD_DIR the
# CMake build folder (default: <SDK>/ARA_Examples/build); tools/make_package.sh uses both. Without them the binary
# targets the macOS of the build machine.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TP="${ARABRIDGE_THIRD_PARTY:-$ROOT/third_party}"
EX="$TP/ARA_SDK/ARA_Examples"

die() { echo "build_host: $*" >&2; exit 1; }

[ -d "$EX" ] || die "SDK not set up; run tools/setup_sdk.sh first"
for tool in cmake xcodebuild; do
    command -v "$tool" >/dev/null 2>&1 || die "'$tool' not found in PATH"
done

# newest versioned macOS SDK of the active Xcode (falls back to xcrun's default)
SYSROOT=""
if XCODE_DEV="$(xcode-select -p 2>/dev/null)"; then
    SYSROOT="$(ls -d "$XCODE_DEV"/Platforms/MacOSX.platform/Developer/SDKs/MacOSX[0-9]*.[0-9]*.sdk 2>/dev/null | sort -V | tail -1 || true)"
fi
[ -n "$SYSROOT" ] || SYSROOT="$(xcrun --sdk macosx --show-sdk-path)"

BUILD="${ARABRIDGE_BUILD_DIR:-$EX/build}"
DEPLOY_ARGS=()
[ -z "${ARABRIDGE_DEPLOYMENT_TARGET:-}" ] || DEPLOY_ARGS=(-DCMAKE_OSX_DEPLOYMENT_TARGET="$ARABRIDGE_DEPLOYMENT_TARGET")

cmake -S "$EX" -B "$BUILD" -G Xcode \
    -DCMAKE_OSX_SYSROOT="$SYSROOT" -DCMAKE_OSX_ARCHITECTURES=arm64 -DSMTG_CREATE_PLUGIN_LINK=OFF \
    ${DEPLOY_ARGS[@]+"${DEPLOY_ARGS[@]}"} >/dev/null
xcodebuild -project "$BUILD/ARA_Examples.xcodeproj" -configuration Release -target BridgeHost \
    ARCHS=arm64 ONLY_ACTIVE_ARCH=NO CODE_SIGNING_ALLOWED=NO 2>&1 | tail -n "${BUILD_TAIL:-5}"

echo "$BUILD/bin/Release/BridgeHost"
