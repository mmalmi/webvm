#!/bin/sh
set -eu

state_dir=${NVPN_WEBVM_STATE_DIR:-/var/lib/nvpn}
config=${NVPN_WEBVM_CONFIG:-$state_dir/config.toml}
runtime_dir=${WEBVM_RUNTIME_DIR:-/run/webvm}
ethernet_interface=${WEBVM_FIPS_INTERFACE:-eth0}
discovery_scope=${WEBVM_FIPS_DISCOVERY_SCOPE:-fips-overlay-v1}
tun_interface=${NVPN_WEBVM_TUN_INTERFACE:-nvpn0}

install -d -m 0700 "$state_dir"
install -d -m 0755 "$runtime_dir"

exec nvpn daemon \
    --service \
    --config "$config" \
    --iface "$tun_interface" \
    --fips-ethernet-interface "$ethernet_interface" \
    --fips-ethernet-discovery-scope "$discovery_scope"
