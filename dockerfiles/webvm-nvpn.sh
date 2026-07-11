#!/bin/sh
set -eu

state_dir=${NVPN_WEBVM_STATE_DIR:-/var/lib/nvpn}
config=${NVPN_WEBVM_CONFIG:-$state_dir/config.toml}
runtime_dir=${WEBVM_RUNTIME_DIR:-/run/webvm}
interface=${WEBVM_FIPS_INTERFACE:-eth0}
scope=${WEBVM_FIPS_DISCOVERY_SCOPE:-fips-overlay-v1}
tun_interface=${NVPN_WEBVM_TUN_INTERFACE:-nvpn0}

install -d -m 0700 "$state_dir"
install -d -m 0755 "$runtime_dir"
/usr/local/sbin/webvm-network
/usr/local/sbin/webvm-tun

if ! nvpn webvm-guest --help >/dev/null 2>&1; then
    printf '%s\n' \
      'webvm: this nvpn build lacks the required Ethernet-only webvm-guest runtime' \
      'webvm: ordinary nvpn start/connect is intentionally disabled in this image' >&2
    exit 64
fi

exec nvpn webvm-guest \
    --config "$config" \
    --ethernet-interface "$interface" \
    --discovery-scope "$scope" \
    --tun-interface "$tun_interface"
