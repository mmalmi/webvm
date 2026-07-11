# Iris WebVM + Nostr VPN

The production architecture keeps VPN policy inside the Linux guest:

1. v86 restores a preinitialized, automatically logged-in Alpine i686 state over the same-origin content-addressed 9p image.
2. The browser runs a generic FIPS node with virtual Ethernet and WebRTC transports and forwarding enabled.
3. Guest FIPS uses only `eth0`; it does not open independent relay, UDP, TCP, or WebRTC transports.
4. `nvpn join-request` displays the guest's stable authenticated join-request link and terminal QR; it waits for approval by default.
5. An admin scans or pastes that request in Nostr VPN. Network invites are not part of the WebVM onboarding flow.
6. The browser's FIPS node exposes a narrowly authorized pubsub service only to its local Ethernet guest, carrying the admin's signed approval back over routed FIPS application datagrams. This does not change the FIPS protocol or give `eth0` an IP route.
7. The normal guest `nvpn daemon` applies the signed roster, reports the transition through `nvpn status`, and enables the TUN for private/public traffic through the selected exit peer.

The shipped state is captured before Hashtree or Nostr VPN starts, so it contains no reusable guest identity. Each browser starts those services after restore and creates its own keys. There is no browser VPN identity, pairing panel, packet gateway, or fallback network path.

## Guest Tools

The image includes `nvpn`, `htree`, and `git-remote-htree`. Hashtree and `.fips` services work through the browser FIPS router before Nostr VPN approval. Run `nvpn join-request` to show the link/QR and wait for an admin; run `nvpn status` to inspect FIPS peers. Approval adds private routes and public Internet exit, but is not required for the FIPS underlay itself.

## Build

```sh
npm run guest:build
npm run build
npm run test:e2e
```

The guest builder compiles static i686 binaries, emits `fs.json` plus content-addressed zstd chunks, and captures the identity-free logged-in state under `custom-disk-images/v86-guest`. Run `npm run state:build` by itself when only the WebVM state needs to be recaptured.

## Deployment

```sh
npm run deploy:webvm:dry-run
npm run deploy:webvm
```

The Cloudflare Worker serves the static build with cross-origin isolation headers at `https://webvm.iris.to/`.
