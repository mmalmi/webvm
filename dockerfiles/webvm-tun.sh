#!/bin/sh
set -eu

runtime_dir=${WEBVM_RUNTIME_DIR:-/run/webvm}

modprobe tun
mkdir -p /dev/net "$runtime_dir"
if [ ! -c /dev/net/tun ]; then
    rm -f /dev/net/tun
    mknod /dev/net/tun c 10 200
    chmod 0600 /dev/net/tun
fi

if [ ! -c /dev/net/tun ]; then
    printf 'webvm: /dev/net/tun is unavailable\n' >&2
    exit 1
fi

touch "$runtime_dir/tun-ready"
