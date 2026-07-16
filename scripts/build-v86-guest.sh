#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)

require_input() {
  local name=$1
  if [[ -z ${!name:-} ]]; then
    printf '%s is required\n' "$name" >&2
    exit 1
  fi
}

for name in \
  NVPN_REPO_PATH \
  HASHTREE_REPO_PATH \
  FIPS_REPO_PATH \
  V86_REPO_PATH \
  NVPN_BINARY \
  HTREE_BINARY \
  GIT_REMOTE_HTREE_BINARY; do
  require_input "$name"
done

NVPN_REPO=$NVPN_REPO_PATH
HASHTREE_REPO=$HASHTREE_REPO_PATH
FIPS_REPO=$FIPS_REPO_PATH
V86_REPO=$V86_REPO_PATH
OUTPUT_DIR=${V86_GUEST_OUTPUT_DIR:-$ROOT/custom-disk-images/v86-guest}
STAGE_DIR=$(mktemp -d "$ROOT/custom-disk-images/.v86-guest-stage.XXXXXX")
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

for binary in "$NVPN_BINARY" "$HTREE_BINARY" "$GIT_REMOTE_HTREE_BINARY"; do
  if [[ ! -x "$binary" ]]; then
    printf 'guest binary is not executable: %s\n' "$binary" >&2
    exit 1
  fi
done

require_i386_elf "$NVPN_BINARY"
require_i386_elf "$HTREE_BINARY"
require_i386_elf "$GIT_REMOTE_HTREE_BINARY"

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR/rootfs" "$OUTPUT_DIR/state"
cp "$NVPN_BINARY" "$STAGE_DIR/nvpn"
cp "$HTREE_BINARY" "$STAGE_DIR/htree"
cp "$GIT_REMOTE_HTREE_BINARY" "$STAGE_DIR/git-remote-htree"
cp "$ROOT/dockerfiles/webvm-seed-rng.c" "$STAGE_DIR/webvm-seed-rng.c"
cp "$ROOT/dockerfiles/webvm-profile.sh" "$STAGE_DIR/webvm-profile.sh"
cp "$ROOT/dockerfiles/webvm-network.sh" "$STAGE_DIR/webvm-network.sh"
cp "$ROOT/dockerfiles/webvm-tun.sh" "$STAGE_DIR/webvm-tun.sh"
cp "$ROOT/dockerfiles/webvm-nvpn.sh" "$STAGE_DIR/webvm-nvpn.sh"
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
