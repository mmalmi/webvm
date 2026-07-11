# Iris WebVM + Nostr VPN

The production architecture keeps VPN policy inside the Linux guest:

1. v86 restores a preinitialized, automatically logged-in Alpine i686 state over the same-origin content-addressed 9p image.
2. The browser runs a generic FIPS node with virtual Ethernet and WebRTC transports and forwarding enabled.
3. Guest FIPS uses only `eth0`; it does not open independent relay, UDP, TCP, or WebRTC transports.
4. Guest-side `nvpn` persists one pending join request and renders its QR/URI in the terminal.
5. A generic Nostr pubsub service on FSP port `7368` carries bounded `REQ`, `CLOSE`, and verified `EVENT` frames between the guest and browser relays.
6. Signed NIP-44 approval events target the separate request pubkey. The request secret stays inside ciphertext and is never used as a topic or filter tag.
7. After approval, guest-side `nvpn` applies the roster and exit context, creates the TUN, and routes private/public traffic through the selected Nostr VPN exit peer.

The shipped state is captured before Hashtree or Nostr VPN starts, so it contains no reusable guest identity. Each browser starts those services after restore and creates its own keys. There is no browser VPN identity, pairing panel, packet gateway, or fallback network path.

## Guest Tools

The image includes `nvpn`, `htree`, and `git-remote-htree`. Hashtree and `.fips` services are expected to work through the browser FIPS router before VPN pairing. VPN approval adds private routes and public Internet exit; it is not required for the FIPS underlay itself.

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
