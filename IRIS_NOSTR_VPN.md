# Iris WebVM + Nostr VPN

This fork is an Iris WebVM experiment that keeps the upstream CheerpX/WebVM runtime and adds a Nostr VPN pairing panel.

As of 2026-07-09, the implemented milestone is browser-side pairing:

- The sidebar has a "Nostr VPN" panel.
- The panel creates an `nvpn://join-request/...` QR/link with a browser AppKey, one-time request pubkey, request secret, and signed AppKey proof in `localStorage`.
- Users can open or copy the link into the native Nostr VPN app.
- The visible Tailscale networking option has been removed from this Iris fork.
- The QR pairing state flips to paired only when a NIP-44 encrypted approval receipt addressed to the request pubkey includes the matching request secret.

The next milestone is packet transport:

1. Publish the native Nostr VPN approval receipt when the scanner accepts a full join request.
2. Persist the request private key only as long as it is needed to receive/verify the approval receipt.
3. Determine whether CheerpX exposes a packet-level network backend that can be backed by Nostr VPN/FIPS transport.
4. If CheerpX does not expose that layer, evaluate a v86-based WebVM profile for a custom virtual NIC.
5. Connect virtual NIC packets to a browser Nostr VPN transport and route them through native Nostr VPN exit nodes.
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
