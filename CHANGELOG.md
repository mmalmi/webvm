# Changelog

## Unreleased

## 2.0.5 - 2026-08-18

- Upgrade the 32-bit guest to nVPN 4.1.8 and native FIPS 0.4.59.
- Upgrade the browser to FIPS TypeScript runtime 0.0.31, including its
  simultaneous WebRTC session-glare fix.
- Exercise ordinary signed-roster pairing against a real private FIPS exit and
  require automatic exit selection, a non-WireGuard default route, public DNS,
  ICMP, and HTTPS before deployment.
- Automatically select the first roster peer that advertises a private IPv4
  default route on a fresh WebVM, while preserving later user exit choices.
- Let the Ethernet-carried native FIPS tunnel activate its selected private
  exit without requiring an in-guest IP endpoint for the browser-owned carrier.
- Keep the browser underlay at a 1,280-byte FIPS path budget and let the guest
  NIC carry its full 1,302-byte authenticated frame plus Ethernet record header,
  preventing large signed rosters from being truncated at the WebVM boundary.
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
