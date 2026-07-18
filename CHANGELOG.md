# Changelog

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
