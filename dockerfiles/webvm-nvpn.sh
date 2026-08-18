#!/bin/sh
set -eu

state_dir=${NVPN_WEBVM_STATE_DIR:-/var/lib/nvpn}
config=${NVPN_WEBVM_CONFIG:-$state_dir/config.toml}
runtime_dir=${WEBVM_RUNTIME_DIR:-/run/webvm}
daemon_state=${NVPN_WEBVM_DAEMON_STATE:-$state_dir/daemon.state.json}
ethernet_interface=${WEBVM_FIPS_INTERFACE:-eth0}
discovery_scope=${WEBVM_FIPS_DISCOVERY_SCOPE:-fips-overlay-v1}
tun_interface=${NVPN_WEBVM_TUN_INTERFACE:-nvpn0}
NVPN_FIPS_NOSTR_DISCOVERY_POLICY=${NVPN_FIPS_NOSTR_DISCOVERY_POLICY:-open}
# v86's 32-bit guest TUN accepts vnet headers but does not reliably deliver
# coalesced TCP GRO frames. Keep native packets discrete at this boundary.
NVPN_FIPS_LINUX_TUN_GRO=${NVPN_FIPS_LINUX_TUN_GRO:-0}
# Leave enough headroom for native FIPS, browser FMP, and virtual Ethernet on
# the return path. Larger TUN packets can cross the exit but stall at WebVM.
NVPN_MESH_TUNNEL_MTU=${NVPN_MESH_TUNNEL_MTU:-1000}
auto_select_exit=${NVPN_WEBVM_AUTO_SELECT_EXIT:-1}
auto_select_marker=$state_dir/.webvm-exit-autoselect-complete
export NVPN_FIPS_NOSTR_DISCOVERY_POLICY
export NVPN_FIPS_LINUX_TUN_GRO
export NVPN_MESH_TUNNEL_MTU

first_offered_private_exit() {
    [ -s "$daemon_state" ] || return 1
    awk -f /usr/local/libexec/webvm-first-exit.awk "$daemon_state"
}

auto_select_first_private_exit() {
    daemon_pid=$1
    while kill -0 "$daemon_pid" 2>/dev/null; do
        if [ -e "$auto_select_marker" ]; then
            return
        fi
        if grep -Eq '^internet_source = "(private_vpn|wireguard|paid_automatic|paid_manual)"$' \
            "$config" 2>/dev/null; then
            : >"$auto_select_marker"
            return
        fi
        exit_peer=$(first_offered_private_exit || true)
        if [ -n "$exit_peer" ] && \
            timeout 5 nvpn set --config "$config" --exit-node "$exit_peer" >/dev/null 2>&1; then
            timeout 5 nvpn reload --config "$config" >/dev/null 2>&1 || true
            : >"$auto_select_marker"
            return
        fi
        sleep 2
    done
}

install -d -m 0700 "$state_dir"
install -d -m 0755 "$runtime_dir"

# The browser's 1,280-byte FIPS path budget can produce a 1,302-byte
# authenticated FMP frame for a routed 1,200-byte FSP payload. Native Ethernet
# adds a 3-byte record header, so the guest NIC must carry 1,305 bytes without
# truncating large signed-roster and FIPS-TCP records.
ip link set dev "$ethernet_interface" mtu 1305

# Start unpaired with direct .fips reachability before the daemon reads the
# config, while browser-side Ethernet remains available for discovery.
nvpn set \
    --config "$config" \
    --fips-host-tunnel-enabled true \
    --connect-to-non-roster-fips-peers true \
    >/dev/null

if [ "$auto_select_exit" = 1 ] && [ ! -e "$auto_select_marker" ]; then
    auto_select_first_private_exit "$$" &
fi

exec nvpn daemon \
    --service \
    --config "$config" \
    --iface "$tun_interface" \
    --fips-ethernet-interface "$ethernet_interface" \
    --fips-ethernet-discovery-scope "$discovery_scope"
