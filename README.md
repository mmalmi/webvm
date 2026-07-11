# Iris WebVM

Iris WebVM is a private Alpine Linux workspace that runs entirely in the browser. It restores an identity-free, automatically logged-in v86 machine state and connects the guest's virtual Ethernet device to browser-side FIPS transports.

The guest includes:

- `htree` and `git-remote-htree`
- Nostr VPN (`nvpn`) with normal network-invite pairing over FIPS
- `.fips` private names and Hashtree site resolution
- A root shell with no boot transcript or login step

The shipped snapshot is captured before Hashtree or Nostr VPN creates an identity. Each browser starts the services after restore and creates its own keys. See [IRIS_NOSTR_VPN.md](IRIS_NOSTR_VPN.md) for the networking architecture.

## Development

Install dependencies and start the local app:

```sh
npm install
npm run dev
```

Build and verify the static application:

```sh
npm run build
npm run test:e2e
```

The credentialed end-to-end Nostr VPN test is skipped unless its host-test environment is configured.

## Guest image and state

Build the Alpine i686 guest and capture a compressed, preinitialized state:

```sh
npm run guest:build
```

When the guest filesystem is unchanged and only the saved machine state needs refreshing:

```sh
npm run state:build
```

Generated guest artifacts live under `custom-disk-images/v86-guest` and are intentionally excluded from Git.

## Deployment

Preview the Cloudflare deployment commands or deploy to the configured WebVM domain:

```sh
npm run deploy:webvm:dry-run
npm run deploy:webvm
```

Production verification:

```sh
npm run test:production
```

## Licence

The WebVM application code retains its original Apache-2.0 licence. v86 and bundled third-party components remain under their respective licences; see [LICENSE.txt](LICENSE.txt) and the licence files shipped with the runtime assets.
