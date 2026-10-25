#!/usr/bin/env bash
# Builds the install package for another Mac: build/package/ARA2-Bridge-4-Live.zip (see dist/README.md).
#   tools/make_package.sh             # needs a clean git tree: the package contains the committed source
#   ALLOW_DIRTY=1 tools/make_package.sh
# Steps: BridgeHost for macOS 12+ (own build folder next to the normal one), the device for the fixed install path
# /Users/Shared/ARABridge/device, the source archive (git archive HEAD), the text files of dist/, then the ZIP.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TP="${ARABRIDGE_THIRD_PARTY:-$ROOT/third_party}"
OUT="$ROOT/build/package"
NAME="ARA2-Bridge-4-Live"
PKG="$OUT/$NAME"
INSTALL_ROOT="/Users/Shared/ARABridge/device"

die() { echo "make_package: $*" >&2; exit 1; }

cd "$ROOT"
if [ -z "${ALLOW_DIRTY:-}" ] && [ -n "$(git status --porcelain)" ]; then
    die "the git tree has uncommitted changes (commit them, or ALLOW_DIRTY=1)"
fi

echo "1/5 BridgeHost (macOS 12+, arm64)"
BUILD_DIR="$TP/ARA_SDK/ARA_Examples/build-dist"
HOST="$(ARABRIDGE_DEPLOYMENT_TARGET="${ARABRIDGE_DEPLOYMENT_TARGET:-12.0}" ARABRIDGE_BUILD_DIR="$BUILD_DIR" tools/build_host.sh | tail -1)"
[ -x "$HOST" ] || die "no BridgeHost at $HOST"
"$HOST" --version || die "BridgeHost does not run"
minos="$(otool -l "$HOST" | awk '/LC_BUILD_VERSION/{f=1} f&&/minos/{print $2; exit}')"
echo "    deployment target $minos"
non_system="$(otool -L "$HOST" | tail -n +2 | awk '{print $1}' | grep -v -e '^/System/' -e '^/usr/lib/' || true)"
[ -z "$non_system" ] || die "BridgeHost links non-system libraries: $non_system"

echo "2/5 device for $INSTALL_ROOT"
rm -rf "$OUT"
mkdir -p "$PKG/device" "$PKG/source"
python3 device/make_amxd.py --install-root "$INSTALL_ROOT" "$PKG/device/ARABridge.amxd" >/dev/null
cp device/build/bridge.js device/src/runner.js "$PKG/device/"
grep -aq "$INSTALL_ROOT/bridge.js" "$PKG/device/ARABridge.amxd" || die "the .amxd does not refer to $INSTALL_ROOT/bridge.js"
grep -aq "$INSTALL_ROOT/runner.js" "$PKG/device/ARABridge.amxd" || die "the .amxd does not refer to $INSTALL_ROOT/runner.js"
if grep -aq "$ROOT" "$PKG/device/ARABridge.amxd"; then die "the .amxd still contains the path of this checkout"; fi

echo "3/5 source archive"
# the audio captures of the host tests stay out (they are the author's recordings, not needed to build)
git archive --format=tar.gz --prefix=ARABridge-source/ -o "$PKG/source/arabridge-source.tar.gz" HEAD -- . ':(exclude)host/tests/fixtures/*.wav'
printf 'ARA Bridge source, git commit %s\nhost/tests/fixtures/*.wav (test recordings) are not included.\n' "$(git rev-parse HEAD)" > "$PKG/source/COMMIT.txt"

echo "4/5 files"
cp "$HOST" "$PKG/BridgeHost"
cp dist/README.md dist/README.en.md dist/LICENSES.md dist/install.sh dist/uninstall.sh "$PKG/"
chmod 755 "$PKG/BridgeHost" "$PKG/install.sh" "$PKG/uninstall.sh"

echo "5/5 zip"
( cd "$OUT" && rm -f "$NAME.zip" && ditto -c -k --keepParent "$NAME" "$NAME.zip" )
echo "$OUT/$NAME.zip"
shasum -a 256 "$OUT/$NAME.zip"
