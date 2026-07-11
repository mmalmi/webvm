#!/bin/sh

if [ -n "${WEBVM_PROFILE_STARTED:-}" ]; then
    return
fi
export WEBVM_PROFILE_STARTED=1

export HTREE_CONFIG_DIR=${HTREE_CONFIG_DIR:-/var/lib/hashtree/config}
export HTREE_DATA_DIR=${HTREE_DATA_DIR:-/var/lib/hashtree/data}
export HTREE_LOCAL_DAEMON_ONLY=1

cat <<'WELCOME'

+----------------------------------------------------------------------------+
| Iris WebVM                                                                |
|                                                                            |
| A private Linux workspace running entirely in your browser.                |
| FIPS networking and Hashtree work immediately, without a VPN login.        |
| Download Nostr VPN (nostrvpn.org) to approve this device and add an exit.  |
+----------------------------------------------------------------------------+

  Nostr VPN join request:  nvpn join-request
  FIPS and peer status:    nvpn status
  Hashtree:        htree add <path>  |  htree cat <nhash>
  Git over htree:  git clone htree://<npub>/<repo>

  Private names:   <npub>.fips
  Hashtree sites:  <nhash>.iris.localhost
                   <site>.<npub>.iris.localhost

WELCOME
