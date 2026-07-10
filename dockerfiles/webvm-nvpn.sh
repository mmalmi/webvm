#!/bin/sh
set -eu

state_dir=${NVPN_WEBVM_STATE_DIR:-/var/lib/nvpn}
config=${NVPN_WEBVM_CONFIG:-$state_dir/config.toml}
runtime_dir=${WEBVM_RUNTIME_DIR:-/run/webvm}
pairing_uri_file=${NVPN_WEBVM_PAIRING_URI_FILE:-$runtime_dir/pairing-uri}
interface=${WEBVM_FIPS_INTERFACE:-eth0}
scope=${WEBVM_FIPS_DISCOVERY_SCOPE:-fips-overlay-v1}
pubsub_port=${NVPN_WEBVM_JOIN_PUBSUB_PORT:-7368}
tun_interface=${NVPN_WEBVM_TUN_INTERFACE:-nvpn0}

if [ "$pubsub_port" != "7368" ]; then
    printf 'webvm: refusing unexpected join pubsub service port %s\n' "$pubsub_port" >&2
    exit 64
fi

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
    --join-pubsub-port "$pubsub_port" \
    --pairing-uri-file "$pairing_uri_file" \
    --tun-interface "$tun_interface"
