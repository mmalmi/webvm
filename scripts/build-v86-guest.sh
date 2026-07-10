#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
NVPN_REPO=${NVPN_REPO_PATH:-$ROOT/../nostr-vpn}
HASHTREE_REPO=${HASHTREE_REPO_PATH:-$ROOT/../hashtree}
FIPS_REPO=${FIPS_REPO_PATH:-$ROOT/../fips}
V86_REPO=${V86_REPO_PATH:-$ROOT/../v86}
TARGET=i686-unknown-linux-musl
HTREE_TARGET_DIR=${HTREE_TARGET_DIR:-${CARGO_TARGET_DIR:-$HOME/.cache/cargo-target}}
OUTPUT_DIR=${V86_GUEST_OUTPUT_DIR:-$ROOT/custom-disk-images/v86-guest}
STAGE_DIR=$ROOT/custom-disk-images/.v86-guest-stage
IMAGE=iris-webvm-v86-guest:i686
CONTAINER=iris-webvm-v86-guest-$$
CONVERTER_PLATFORM=${V86_IMAGE_CONVERTER_PLATFORM:-$(docker version --format '{{.Server.Os}}/{{.Server.Arch}}')}

require_i386_elf() {
  local binary=$1
  local description
  description=$(file -b "$binary")
  if [[ $description != *"ELF 32-bit LSB"* || $description != *"Intel 80386"* ]]; then
    printf 'guest binary is not i386 ELF: %s (%s)\n' "$binary" "$description" >&2
    exit 1
  fi
}

for path in \
  "$V86_REPO/tools/fs2json.py" \
  "$V86_REPO/tools/copy-to-sha256.py"; do
  if [[ ! -f "$path" ]]; then
    printf 'missing v86 image tool: %s\n' "$path" >&2
    exit 1
  fi
done

if [[ -n ${NVPN_BINARY:-} ]]; then
  if [[ ! -x "$NVPN_BINARY" ]]; then
    printf 'NVPN_BINARY is not executable: %s\n' "$NVPN_BINARY" >&2
    exit 1
  fi
else
  (
    cd "$NVPN_REPO"
    NVPN_FIPS_REPO_PATH=${NVPN_FIPS_REPO_PATH:-$FIPS_REPO} \
      scripts/build-nvpn-linux-musl "$TARGET"
  )
  NVPN_BINARY=${NVPN_LINUX_MUSL_TARGET_DIR:-$NVPN_REPO/target}/$TARGET/release/nvpn
fi

if [[ -n ${HTREE_BINARY:-} ]]; then
  if [[ ! -x "$HTREE_BINARY" ]]; then
    printf 'HTREE_BINARY is not executable: %s\n' "$HTREE_BINARY" >&2
    exit 1
  fi
  GIT_REMOTE_HTREE_BINARY=${GIT_REMOTE_HTREE_BINARY:-$(dirname "$HTREE_BINARY")/git-remote-htree}
else
  CARGO_INCREMENTAL=0 CARGO_TARGET_DIR="$HTREE_TARGET_DIR" cargo zigbuild \
    --manifest-path "$HASHTREE_REPO/rust/Cargo.toml" \
    --locked \
    -p hashtree-cli \
    --bin htree \
    --bin git-remote-htree \
    --release \
    --target "$TARGET" \
    --no-default-features \
    --features git-remote-wrapper
  HTREE_BINARY=$HTREE_TARGET_DIR/$TARGET/release/htree
  GIT_REMOTE_HTREE_BINARY=${GIT_REMOTE_HTREE_BINARY:-$HTREE_TARGET_DIR/$TARGET/release/git-remote-htree}
fi

if [[ ! -x "$GIT_REMOTE_HTREE_BINARY" ]]; then
  printf 'GIT_REMOTE_HTREE_BINARY is not executable: %s\n' "$GIT_REMOTE_HTREE_BINARY" >&2
  exit 1
fi

require_i386_elf "$NVPN_BINARY"
require_i386_elf "$HTREE_BINARY"
require_i386_elf "$GIT_REMOTE_HTREE_BINARY"

rm -rf "$STAGE_DIR" "$OUTPUT_DIR"
mkdir -p "$STAGE_DIR" "$OUTPUT_DIR/rootfs"
cp "$NVPN_BINARY" "$STAGE_DIR/nvpn"
cp "$HTREE_BINARY" "$STAGE_DIR/htree"
cp "$GIT_REMOTE_HTREE_BINARY" "$STAGE_DIR/git-remote-htree"
cp "$ROOT/dockerfiles/webvm-profile.sh" "$STAGE_DIR/webvm-profile.sh"
cp "$ROOT/dockerfiles/webvm-network.sh" "$STAGE_DIR/webvm-network.sh"
cp "$ROOT/dockerfiles/webvm-tun.sh" "$STAGE_DIR/webvm-tun.sh"
cp "$ROOT/dockerfiles/webvm-nvpn.sh" "$STAGE_DIR/webvm-nvpn.sh"
cp "$ROOT/dockerfiles/webvm-pair.sh" "$STAGE_DIR/webvm-pair.sh"
cp "$ROOT/dockerfiles/webvm-underlay.openrc" "$STAGE_DIR/webvm-underlay.openrc"
cp "$ROOT/dockerfiles/webvm-hashtree.openrc" "$STAGE_DIR/webvm-hashtree.openrc"
cp "$ROOT/dockerfiles/webvm-nvpn.openrc" "$STAGE_DIR/webvm-nvpn.openrc"
cp "$ROOT/dockerfiles/webvm-hashtree.toml" "$STAGE_DIR/webvm-hashtree.toml"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$STAGE_DIR"
}
trap cleanup EXIT

docker build \
  --network host \
  --platform linux/386 \
  --tag "$IMAGE" \
  --file "$ROOT/dockerfiles/v86_guest" \
  "$STAGE_DIR"
docker create --platform linux/386 --name "$CONTAINER" "$IMAGE" >/dev/null
docker export "$CONTAINER" --output "$STAGE_DIR/rootfs.tar"

if [[ -n ${V86_IMAGE_CONVERTER_PYTHON:-} ]]; then
  "$V86_IMAGE_CONVERTER_PYTHON" "$V86_REPO/tools/fs2json.py" \
    --zstd --out "$OUTPUT_DIR/fs.json" "$STAGE_DIR/rootfs.tar" >/dev/null 2>&1
  "$V86_IMAGE_CONVERTER_PYTHON" "$V86_REPO/tools/copy-to-sha256.py" \
    --zstd "$STAGE_DIR/rootfs.tar" "$OUTPUT_DIR/rootfs" >/dev/null 2>&1
else
  docker run --rm --platform "$CONVERTER_PLATFORM" \
    -v "$V86_REPO/tools:/tools:ro" \
    -v "$STAGE_DIR:/input:ro" \
    -v "$OUTPUT_DIR:/output" \
    alpine:3.22 sh -ec '
      apk add --no-cache python3 py3-zstandard >/dev/null
      python3 /tools/fs2json.py --zstd --out /output/fs.json /input/rootfs.tar >/dev/null 2>&1
      python3 /tools/copy-to-sha256.py --zstd /input/rootfs.tar /output/rootfs >/dev/null 2>&1
    '
fi

cp "$V86_REPO/bios/seabios.bin" "$OUTPUT_DIR/seabios.bin"
cp "$V86_REPO/bios/vgabios.bin" "$OUTPUT_DIR/vgabios.bin"

node "$ROOT/scripts/write-v86-guest-manifest.mjs" \
  "$OUTPUT_DIR" \
  "$NVPN_BINARY" \
  "$HTREE_BINARY" \
  "$GIT_REMOTE_HTREE_BINARY" \
  "$IMAGE" \
  "$ROOT" \
  "$NVPN_REPO" \
  "$HASHTREE_REPO" \
  "$FIPS_REPO" \
  "$V86_REPO"

printf '%s\n' "$OUTPUT_DIR"
