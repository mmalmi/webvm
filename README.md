# Iris WebVM

Iris WebVM is a private Alpine Linux workspace that runs entirely in the browser. It restores an identity-free, automatically logged-in v86 machine state and connects the guest's virtual Ethernet device to browser-side FIPS transports.

After the first successful nVPN pairing, WebVM selects the first reachable roster peer
that advertises `0.0.0.0/0` as its private FIPS exit. The one-time selection is
recorded on the persistent guest disk after the daemon reloads successfully,
so clearing or changing the exit later is respected. Set `NVPN_WEBVM_AUTO_SELECT_EXIT=0` in the guest service environment
to disable this behavior.

The guest includes:

- `htree` and `git-remote-htree`
- Nostr VPN (`nvpn`) with normal network-invite pairing over FIPS
- `.fips` private names and Hashtree site resolution
- A root shell with no boot transcript or login step

The shipped snapshot is captured before Hashtree or Nostr VPN creates an identity. Each browser starts the services after restore and creates its own keys. See [IRIS_NOSTR_VPN.md](IRIS_NOSTR_VPN.md) for the networking architecture.

## Development

Install dependencies and start the local app:

```sh
npm ci
npm run dev
```

Build and verify the static application:

```sh
npm run build
npm run test:e2e
```

The credentialed end-to-end Nostr VPN test is skipped unless its host-test environment is configured.
To additionally prove automatic private-exit selection and public traffic through
an existing non-WireGuard exit, point the test at an exit-advertising admin
configuration:

```sh
NVPN_WEBVM_REAL_E2E=1 \
NVPN_WEBVM_EXIT_ADMIN_CONFIG=<admin-config.toml> \
NVPN_WEBVM_EXIT_ADMIN_BIN=<matching-nvpn-binary> \
NVPN_WEBVM_EXIT_ADMIN_EXCLUSIVE=1 \
NVPN_WEBVM_NVPN_BIN=<matching-nvpn-binary> \
NVPN_APP_CORE_MANIFEST=<clean-native-source>/crates/nostr-vpn-app-core/Cargo.toml \
NVPN_WEBVM_NATIVE_SOURCE_SHA=<clean-native-source-commit> \
NVPN_WEBVM_FIPS_VERSION=<pinned-fips-version> \
  npx playwright test tests/e2e/webvm-native-nostr-vpn.spec.js
```

On macOS, `NVPN_WEBVM_EXIT_ADMIN_EXCLUSIVE=1` briefly boots out the standard
nVPN LaunchDaemon while the ordinary join helper owns the same admin identity.
The test restores the daemon immediately afterward and attempts restoration
again during cleanup.

Set `NVPN_WEBVM_E2E_BASE_URL=https://webvm.iris.to` to run the same acceptance
test against the deployed WebVM instead of the local preview.

For a local release candidate, set `NVPN_WEBVM_NATIVE_SOURCE_MODE=candidate`.
This accepts an unpublished commit while still requiring a clean repository,
the exact source commit, matching binary version, and checksummed registry FIPS dependencies.
Published-source verification remains the default and is required for deployment.

The private-exit acceptance test allows one minute for automatic exit selection.
It then requires a complete `apk update` before the DNS and HTTP checks warm the
connection. Package, system DNS, HTTP, and HTTPS checks run once, so a successful
retry cannot hide a first-use failure.

## Guest image and state

Build the Alpine i686 guest and capture a compressed, preinitialized state:

```sh
NVPN_REPO_PATH=<clean-nvpn-source> \
HASHTREE_REPO_PATH=<clean-hashtree-source> \
FIPS_REPO_PATH=<clean-fips-source> \
V86_REPO_PATH=<clean-v86-source> \
NVPN_BINARY=<i386-nvpn> \
HTREE_BINARY=<i386-htree> \
GIT_REMOTE_HTREE_BINARY=<i386-git-remote-htree> \
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
