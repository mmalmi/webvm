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
NVPN_WEBVM_IPV4_EXIT_MTU=${NVPN_WEBVM_IPV4_EXIT_MTU:-1000}
NVPN_WEBVM_TCP_MSS=${NVPN_WEBVM_TCP_MSS:-960}
auto_select_exit=${NVPN_WEBVM_AUTO_SELECT_EXIT:-1}
auto_select_marker=$state_dir/.webvm-exit-autoselect-complete
export NVPN_FIPS_NOSTR_DISCOVERY_POLICY
export NVPN_FIPS_LINUX_TUN_GRO
export NVPN_MESH_TUNNEL_MTU

enforce_webvm_exit_packet_budget() {
    daemon_pid=$1
    while kill -0 "$daemon_pid" 2>/dev/null; do
        if ip link show "$tun_interface" >/dev/null 2>&1; then
            iptables -t mangle -C OUTPUT -o "$tun_interface" -p tcp \
                --tcp-flags SYN,RST SYN -j TCPMSS --set-mss "$NVPN_WEBVM_TCP_MSS" \
                >/dev/null 2>&1 || \
                iptables -t mangle -A OUTPUT -o "$tun_interface" -p tcp \
                    --tcp-flags SYN,RST SYN -j TCPMSS --set-mss "$NVPN_WEBVM_TCP_MSS"
            if ip -4 route show default dev "$tun_interface" | grep -q . && \
                ! ip -4 route show default dev "$tun_interface" \
                    | grep -q "mtu $NVPN_WEBVM_IPV4_EXIT_MTU"; then
                ip -4 route change default dev "$tun_interface" \
                    mtu "$NVPN_WEBVM_IPV4_EXIT_MTU"
            fi
        fi
        sleep 2
    done
}

first_offered_private_exit() {
    [ -s "$daemon_state" ] || return 1
    awk -f "${WEBVM_LIBEXEC_DIR:-/usr/local/libexec}/webvm-first-exit.awk" "$daemon_state"
}

auto_select_first_private_exit() {
    daemon_pid=$1
    selection_pending=0
    while kill -0 "$daemon_pid" 2>/dev/null; do
        if [ -e "$auto_select_marker" ]; then
            return
        fi
        if [ "$selection_pending" = 0 ]; then
            if grep -Eq '^internet_source = "(private_vpn|wireguard|paid_automatic|paid_manual)"$' \
                "$config" 2>/dev/null; then
                : >"$auto_select_marker"
                return
            fi
            exit_peer=$(first_offered_private_exit || true)
            if [ -n "$exit_peer" ] && \
                timeout 5 nvpn set --config "$config" --exit-node "$exit_peer" >/dev/null 2>&1; then
                selection_pending=1
            fi
        fi
        if [ "$selection_pending" = 1 ] && \
            timeout 5 nvpn reload --config "$config" >/dev/null 2>&1; then
            : >"$auto_select_marker"
            return
        fi
        sleep 2
    done
}

install -d -m 0700 "$state_dir"
install -d -m 0755 "$runtime_dir"

# Keep the local browser/guest hop at the standard 1,500-byte Ethernet payload
# budget. Native and browser Ethernet transports subtract their 3-byte record
# header and advertise 1,497 bytes; routed WSS/WebRTC hops remain capped at
# their separate 1,280-byte underlay budget.
ip link set dev "$ethernet_interface" mtu 1500

# Start unpaired with direct .fips reachability before the daemon reads the
# config, while browser-side Ethernet remains available for discovery.
nvpn set \
    --config "$config" \
    --fips-host-tunnel-enabled true \
    --connect-to-non-roster-fips-peers true \
    --exit-dns-mode through_exit \
    --exit-dns-through-exit-servers 9.9.9.9,149.112.112.112 \
    >/dev/null

if [ "$auto_select_exit" = 1 ] && [ ! -e "$auto_select_marker" ]; then
    auto_select_first_private_exit "$$" &
fi
enforce_webvm_exit_packet_budget "$$" &

exec nvpn daemon \
    --service \
    --config "$config" \
    --iface "$tun_interface" \
    --fips-ethernet-interface "$ethernet_interface" \
    --fips-ethernet-discovery-scope "$discovery_scope"
