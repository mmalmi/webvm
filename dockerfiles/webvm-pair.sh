#!/bin/sh
set -eu

config=${NVPN_WEBVM_CONFIG:-/var/lib/nvpn/config.toml}
invite=${1:-}

case $invite in
    nvpn://invite/*) ;;
    *)
        printf 'usage: webvm-pair nvpn://invite/...\n' >&2
        printf 'Copy a network invite from an admin device and pass it here.\n' >&2
        exit 64
        ;;
esac

nvpn import-invite "$invite" --config "$config" >/dev/null
rc-service webvm-nvpn stop >/dev/null 2>&1 || true
rc-service webvm-nvpn start >/dev/null

printf '%s\n' \
    'Network invite imported.' \
    'Join request is being sent to the admin over FIPS.' \
    'Approve this WebVM on the admin device; the signed roster returns over FIPS.'
