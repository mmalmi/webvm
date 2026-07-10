#!/bin/sh
set -eu

runtime_dir=${WEBVM_RUNTIME_DIR:-/run/webvm}
pairing_uri_file=${NVPN_WEBVM_PAIRING_URI_FILE:-$runtime_dir/pairing-uri}
config=${NVPN_WEBVM_CONFIG:-/var/lib/nvpn/config.toml}
wait_for_uri=false

case ${1:-} in
    "") ;;
    --wait) wait_for_uri=true ;;
    *)
        printf 'usage: webvm-pair [--wait]\n' >&2
        exit 64
        ;;
esac

if $wait_for_uri; then
    while [ ! -s "$pairing_uri_file" ]; do
        sleep 1
    done
fi

if [ ! -s "$pairing_uri_file" ]; then
    printf 'Pairing request is not ready. Check: rc-service webvm-nvpn status\n' >&2
    exit 1
fi

printf '\n'
nvpn pairing-qr --config "$config"
printf '\n'
