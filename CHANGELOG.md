# Changelog

## 2.0.10 - 2026-09-30

- Use paths with enough capacity for peer connection messages and recover authenticated peer connections sooner.
- Retry lost peer handshakes and connection answers as routes recover.
- Preserve saved disks and browser identity.

## 2.0.9 - 2026-09-30

- Update the shared event runtime with interoperable relay filter batches.
- Preserve saved guest disks, browser identity, and existing FIPS transport versions.

## 2.0.8 - 2026-09-30

- Wait for durable event delivery before completing Nostr history requests.
- Preserve the browser host identity and saved guest disks during the shared runtime upgrade.

## 2.0.7 - 2026-09-06

- Warm coordinates when browser traffic changes transit paths and accept coordinate
  warmup from native peers without repeating session setup.
- Upgrade browser FIPS core to 0.0.42 for faster replay protection, matching
  Rust timing and delivery reports, and confirmed carrier changes that preserve
  traffic through key rotation, without changing the wire protocol.
- Upgrade the Linux guest to nVPN 4.1.10 and native FIPS 0.4.74.
- Select a reachable private exit after pairing and retry a failed daemon
  reload before recording the automatic choice. Preserve later manual choices.
- Verify public HTTP and certificate-checked HTTPS alongside ICMP and DNS,
  with bounded probe timeouts and fewer redundant retries.
- Resolve native FIPS package aliases when validating paired nVPN fixtures,
  and allow explicit clean release candidates before publication.
- Fail guest snapshot capture if its preview port is occupied, preventing
  accidental snapshots from another server and simplifying preview cleanup.
- Build the native approval helper before starting the guest, reusing pinned
  dependencies and keeping compilation outside the pairing deadline.
- Run approval through the selected exit's CLI and report completed pairing
  and Internet checks, including exits managed outside the local host.

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
- Upgrade the browser to FIPS TypeScript core 0.0.34 and retain the first
  authenticated direct record when it legitimately arrives before the routed
  final handshake message, so native pubsub approval survives carrier
  reordering between the guest and browser.
- Upgrade the browser bridge to `nostr-pubsub` 0.5.6, including its latest
  verification boundary and idempotent cleanup for a simultaneous TCP/FIPS
  stream that the remote guest already closed.
- Upgrade the browser to FIPS TypeScript core 0.0.35 and remove a displaced
  guest identity from WebVM admission state before accepting the replacement
  identity at the VM's stable Ethernet address.
- Upgrade the browser to FIPS TypeScript core 0.0.36 so a timed-out pubsub FSP
  handshake is discarded and the next delivery attempt starts a fresh session
  instead of waiting forever on the dead one.
- Upgrade the 32-bit guest and public bootstrap seeds to native FIPS 0.4.61,
  evict persistently poisoned end-to-end sessions, and preserve fresh-client
  admission headroom as the public mesh grows.
- Upgrade the guest and public bootstrap seeds to native FIPS 0.4.62, closing
  orphaned browser WebSockets after an authenticated route expires so WebVM
  reconnects and receives a later admin approval.
- Quiet BusyBox history persistence at each interactive prompt, preventing the
  full command history from flooding the console and obscuring pairing updates.
- Keep the restored shell in its concise, bounded startup state until nVPN has
  opened both DNS and its join-control socket, so an immediately entered
  approval command cannot race normal daemon startup.

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
