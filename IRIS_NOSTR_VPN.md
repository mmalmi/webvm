# Iris WebVM + Nostr VPN

This fork is an Iris WebVM experiment that keeps the upstream CheerpX/WebVM runtime and adds a Nostr VPN pairing panel.

As of 2026-07-09, the implemented milestone is relay-backed pairing:

- The sidebar has a "Nostr VPN" panel.
- The panel creates an `nvpn://join-request/...` QR/link with a browser AppKey, one-time request pubkey, request secret, and signed AppKey proof in `localStorage`.
- Users can open or copy the link into the native Nostr VPN app.
- The visible Tailscale networking option has been removed from this Iris fork.
- The QR pairing state flips to paired only when a NIP-44 encrypted approval receipt addressed to the request pubkey includes the matching request secret.
- The native Nostr VPN app publishes the approval receipt when an admin imports a full join request.
- The Playwright e2e starts a local Nostr relay, subscribes from WebVM, publishes a native-shaped approval receipt, and verifies that the VM auto-detects the paired state.

The next milestone is packet transport:

1. Persist the request private key only as long as it is needed to receive/verify the approval receipt.
2. Determine whether CheerpX exposes a packet-level network backend that can be backed by Nostr VPN/FIPS transport. As of 2026-07-09, installed `@leaningtech/cheerpx@1.3.5` exposes Tailscale-style `authKey`, `controlUrl`, `loginUrlCb`, `stateUpdateCb`, and `netmapUpdateCb` hooks, but not a raw packet interface. The WebVM e2e asserts this package surface so the app fails clearly instead of using fallback networking.
3. If CheerpX does not expose that layer, build a v86-based WebVM profile for the packet transport path. As of 2026-07-09, `v86@0.5.424` exposes `net0-send` and `net0-receive` hooks; this fork includes a tested adapter that maps those hooks to the Nostr VPN packet backend contract.
4. Publish or otherwise make the local `@fips/browser`, `@fips/core`, and `@fips/transport-webrtc` packages consumable by `iris-webvm`; as of 2026-07-09 they are local `0.0.1` workspace packages in `/Users/sirius/src/fips-ts` and are not resolvable through npm.
5. Connect virtual NIC packets to the browser FIPS endpoint-data API (`sendEndpointData` / `endpointData`) and route them through native Nostr VPN exit nodes. This fork includes a tested endpoint-data bridge boundary, but it is not wired to a running VM backend yet.
6. Keep the app deployable from `sites.iris.to`/`apps.iris.to`, with `webvm.iris.to` as the dedicated host if the CheerpX license and Cloudflare route are approved.

## Deployment Shape

WebVM requires a cross-origin-isolated static host with the WebAssembly bundle, worker files, and disk image assets served with the required headers. A dedicated `webvm.iris.to` host is preferred over embedding it directly inside the Iris Sites launcher runtime.

The Iris Sites launcher can link to `https://webvm.iris.to/` once that host is deployed.

This fork includes a Cloudflare Worker static-assets deploy helper:

```sh
npm run deploy:webvm:dry-run
npm run deploy:webvm
```

Defaults:

- Worker name: `iris-webvm`
- Custom domain: `webvm.iris.to`
- Static assets: `build`
- Worker script: `scripts/webvm-worker.mjs`

The worker adds the WebVM/CheerpX cross-origin isolation headers:

- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`
- `Cross-Origin-Resource-Policy: cross-origin`

## Product Note

The WebVM repository is Apache-2.0, but public/product use of the CheerpX runtime can require Leaning Technologies licensing. Review the CheerpX terms before putting this fork in front of ordinary Iris users.
