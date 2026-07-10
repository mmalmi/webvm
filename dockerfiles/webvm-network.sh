#!/bin/sh
set -eu

interface=${WEBVM_FIPS_INTERFACE:-eth0}
hashtree_interface=${WEBVM_HASHTREE_FIPS_INTERFACE:-htree0}
scope=${WEBVM_FIPS_DISCOVERY_SCOPE:-fips-overlay-v1}
runtime_dir=${WEBVM_RUNTIME_DIR:-/run/webvm}

if [ "$interface" != "eth0" ]; then
    printf 'webvm: refusing unexpected FIPS interface %s\n' "$interface" >&2
    exit 64
fi

if [ "$hashtree_interface" != "htree0" ]; then
    printf 'webvm: refusing unexpected Hashtree FIPS interface %s\n' "$hashtree_interface" >&2
    exit 64
fi

if [ "$scope" != "fips-overlay-v1" ]; then
    printf 'webvm: refusing unexpected FIPS discovery scope %s\n' "$scope" >&2
    exit 64
fi

modprobe af_packet
modprobe macvlan
if [ ! -r /proc/net/packet ]; then
    printf 'webvm: Linux AF_PACKET support is unavailable\n' >&2
    exit 1
fi

ip link show dev "$interface" >/dev/null
ip link set dev lo up
ip link set dev "$interface" down
ip addr flush dev "$interface"
ip -6 addr flush dev "$interface" 2>/dev/null || true
ip route flush dev "$interface"
ip -6 route flush dev "$interface" 2>/dev/null || true
sysctl -qw "net.ipv6.conf.${interface}.disable_ipv6=1"
ip link set dev "$interface" arp off multicast on up

if ! ip link show dev "$hashtree_interface" >/dev/null 2>&1; then
    eth_mac=$(cat "/sys/class/net/${interface}/address")
    hashtree_mac="02:${eth_mac#*:}"
    ip link add link "$interface" name "$hashtree_interface" \
        address "$hashtree_mac" type macvlan mode bridge
fi
ip link set dev "$hashtree_interface" down
ip addr flush dev "$hashtree_interface"
ip -6 addr flush dev "$hashtree_interface" 2>/dev/null || true
ip route flush dev "$hashtree_interface"
ip -6 route flush dev "$hashtree_interface" 2>/dev/null || true
sysctl -qw "net.ipv6.conf.${hashtree_interface}.disable_ipv6=1"
ip link set dev "$hashtree_interface" arp off multicast on up

if ip -o addr show dev "$interface" | grep -q .; then
    printf 'webvm: %s unexpectedly has an IP address\n' "$interface" >&2
    exit 1
fi

if ip route show default dev "$interface" | grep -q .; then
    printf 'webvm: %s unexpectedly has a default route\n' "$interface" >&2
    exit 1
fi

if ip -o addr show dev "$hashtree_interface" | grep -q .; then
    printf 'webvm: %s unexpectedly has an IP address\n' "$hashtree_interface" >&2
    exit 1
fi

if ip route show default dev "$hashtree_interface" | grep -q .; then
    printf 'webvm: %s unexpectedly has a default route\n' "$hashtree_interface" >&2
    exit 1
fi

mkdir -p "$runtime_dir"
printf '%s\n' "$scope" >"$runtime_dir/fips-discovery-scope"
printf '%s\n' "$interface" >"$runtime_dir/fips-interface"
printf '%s\n' "$hashtree_interface" >"$runtime_dir/hashtree-fips-interface"
touch "$runtime_dir/ethernet-ready"
