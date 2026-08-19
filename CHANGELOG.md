# Changelog

## 2.0.6 - 2026-08-19

- Retry transient reliable-pubsub FIPS session setup while the authenticated
  guest remains present, so a recovered approval path does not require peer
  churn or a page reload.
- Exercise the blocking join command without repeated daemon requests and
  require exactly one reachability line while awaiting approval.
- Match the browser WSS/WebRTC record budget to native FIPS at 1,400 bytes so
  routed WebRTC negotiation can establish the admin-to-guest approval path.
- Upgrade the browser to FIPS TypeScript core 0.0.33 and Ethernet 0.0.31,
  reauthenticate a restarted guest identity at its stable virtual MAC, and propagate
  `FilterAnnounce` reachability from the Ethernet guest to upstream WSS peers,
  allowing an approving nVPN 4.1.8 admin to route its signed roster back into
  WebVM.
- Re-resolve a live transit session after its learned browser next hop disappears,
  allowing paired exit traffic to heal onto another authenticated mesh path
  without restarting nVPN or re-pairing.
- Quiet BusyBox history persistence at each interactive prompt, preventing the
  full command history from flooding the console and obscuring pairing updates.

## 2.0.5 - 2026-08-18

- Upgrade the 32-bit guest to nVPN 4.1.8 and native FIPS 0.4.59.
- Report the browser Ethernet peer as an active pre-pairing FIPS delivery path,
  allowing ordinary signed-roster approval to wait for real reachability.
- Upgrade the browser to FIPS TypeScript runtime 0.0.31, including its
  simultaneous WebRTC session-glare fix.
- Exercise ordinary signed-roster pairing against a real private FIPS exit and
  require automatic exit selection, a non-WireGuard default route, public DNS,
  ICMP, and HTTPS before deployment.
- Automatically select the first roster peer that advertises a private IPv4
  default route on a fresh WebVM, while preserving later user exit choices.
- Let the Ethernet-carried native FIPS tunnel activate its selected private
  exit without requiring an in-guest IP endpoint for the browser-owned carrier.
- Keep WebRTC and WSS at a 1,280-byte FIPS path budget while giving the local
  browser/guest Ethernet hop its standard 1,497-byte FIPS payload, preventing
  large signed rosters and current FIPS handshakes from being truncated.
- Keep TCP packets discrete, apply a 1,000-byte IPv4 exit-route budget, and
  advertise a 960-byte TCP MSS from the v86 guest, preventing oversized return
  frames from stalling HTTPS and encrypted DNS while retaining the FIPS host
  tunnel's required 1,280-byte IPv6 MTU.
- Discover as well as announce on virtual Ethernet so a restarted guest daemon
  replaces the browser's stale authenticated session automatically.
- Recycle a browser-side Ethernet session when the guest's native FIPS
  heartbeat traffic disappears, allowing asymmetric daemon restarts to heal.
- Allow the credentialed real-guest test to run unchanged against a deployed
  WebVM URL for production acceptance.
- Let the macOS acceptance gate temporarily give the ordinary join helper
  exclusive ownership of the exit-admin identity before restoring the daemon.

## 2.0.4 - 2026-07-20

- Upgrade the vendored browser transports to FIPS TypeScript 0.0.29 for
  direct FSP negotiation with legacy FMP fallback.
- Rebuild the 32-bit guest with nVPN 4.0.99 and native FIPS 0.4.20, and
  regenerate its verified preinitialized VM state.
- Replace the datagram-era WebVM Nostr bridge with `nostr-pubsub` 0.5.1's
  reliable FIPS-TCP client and transport-neutral relay/FIPS router.

## 2.0.3 - 2026-07-18

- Removed the WebVM-specific nVPN state-control proxy, mesh-ingress hints, and
  daemon flags. The guest now ships the ordinary `nvpn` binary and uses its
  standard `join-request` flow. The ordinary daemon discovers the browser as
  a generic FIPS Ethernet peer and uses the standard pubsub relay service.

## 2.0.2 - 2026-07-17

- Proxy nVPN state-control records over the existing authenticated FIPS-TCP
  service, so WebVM approval applies one signed roster without application
  relay traffic, a custom receipt, or an application ACK protocol.
- Vendor immutable `nostr-pubsub` 0.3.1, retaining the unchanged
  `nostr.pubsub/1` service and 65,525-byte FSP datagram boundary while fixing
  reconnecting subscription lifecycle.
- Publish the Iris Sites WebVM favicon.

## 2.0.1 - 2026-07-16

- Vendor the immutable FIPS TypeScript 0.0.26 core, Ethernet, and WebRTC
  release assets with fail-closed SHA-256 and SHA-512 verification.
- Preserve the guest identity across reloads and reject stale handshake epochs
  without changing the native FIPS or `nostr.pubsub/1` wire contracts.
- Keep WebVM's Nostr service on the shared authenticated pubsub transport.
