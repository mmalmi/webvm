import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
	DEFAULT_FIPS_RELAYS,
	DEFAULT_FIPS_WEBSOCKET_SEED_URLS,
	WEBVM_NOSTR_PUBSUB_FILTERS,
} from '../../src/lib/webvmFipsConfig.js';

test('browser FIPS bootstraps through the two explicit authenticated WSS seeds', () => {
	assert.deepEqual(DEFAULT_FIPS_WEBSOCKET_SEED_URLS, [
		'wss://fips1.iris.to/fips',
		'wss://fips2.iris.to/fips',
	]);
	assert.deepEqual(DEFAULT_FIPS_RELAYS, ['wss://temp.iris.to']);
	assert.equal(WEBVM_NOSTR_PUBSUB_FILTERS.length, 2);
	assert.ok(WEBVM_NOSTR_PUBSUB_FILTERS.every((filter) => filter.limit === 32));
});

test('browser FIPS contains no Nostr packet transport or companion carrier', () => {
	const productionSources = [
		'src/lib/optionalFipsTransport.js',
		'src/lib/webvmFipsHost.js',
	].map((file) => readFileSync(file, 'utf8')).join('\n');
	const forbidden = [
		['Nostr', 'RelayTransport'].join(''),
		['companion', 'Transports'].join(''),
		['210', '60'].join(''),
	];
	for (const term of forbidden) assert.doesNotMatch(productionSources, new RegExp(term, 'u'));
	assert.match(productionSources, /createWebvmNostrPubsubService/u);
});

test('WebVM guest keeps authenticated transit discovery open after approval', () => {
	const launcher = readFileSync('dockerfiles/webvm-nvpn.sh', 'utf8');
	assert.match(
		launcher,
		/NVPN_FIPS_NOSTR_DISCOVERY_POLICY=\$\{NVPN_FIPS_NOSTR_DISCOVERY_POLICY:-open\}/u,
	);
	assert.match(launcher, /export NVPN_FIPS_NOSTR_DISCOVERY_POLICY/u);
	assert.match(launcher, /NVPN_FIPS_LINUX_TUN_GRO=\$\{NVPN_FIPS_LINUX_TUN_GRO:-0\}/u);
	assert.match(launcher, /export NVPN_FIPS_LINUX_TUN_GRO/u);
	assert.match(launcher, /NVPN_MESH_TUNNEL_MTU=\$\{NVPN_MESH_TUNNEL_MTU:-1000\}/u);
	assert.match(launcher, /export NVPN_MESH_TUNNEL_MTU/u);
	assert.match(launcher, /NVPN_WEBVM_TCP_MSS=\$\{NVPN_WEBVM_TCP_MSS:-960\}/u);
	assert.match(launcher, /NVPN_WEBVM_IPV4_EXIT_MTU=\$\{NVPN_WEBVM_IPV4_EXIT_MTU:-1000\}/u);
	assert.match(launcher, /iptables -t mangle -[CA] OUTPUT -o "\$tun_interface"/u);
	assert.match(launcher, /--tcp-flags SYN,RST SYN -j TCPMSS --set-mss "\$NVPN_WEBVM_TCP_MSS"/u);
	assert.match(
		launcher,
		/ip -4 route change default dev "\$tun_interface" \\\n\s+mtu "\$NVPN_WEBVM_IPV4_EXIT_MTU"/u,
	);
	assert.match(
		launcher,
		/--fips-host-tunnel-enabled true/u,
	);
	assert.match(launcher, /--connect-to-non-roster-fips-peers true/u);
	assert.match(launcher, /--exit-dns-mode through_exit/u);
	assert.match(
		launcher,
		/--exit-dns-through-exit-servers 9\.9\.9\.9,149\.112\.112\.112/u,
	);
	assert.ok(
		launcher.indexOf('export NVPN_FIPS_NOSTR_DISCOVERY_POLICY')
			< launcher.indexOf('exec nvpn daemon'),
	);
	assert.ok(
		launcher.indexOf('--fips-host-tunnel-enabled true')
			< launcher.indexOf('exec nvpn daemon'),
	);
	assert.ok(
		launcher.indexOf('--connect-to-non-roster-fips-peers true')
			< launcher.indexOf('exec nvpn daemon'),
	);
});

test('WebVM guest autoselects one offered private exit without overriding later choices', () => {
	const launcher = readFileSync('dockerfiles/webvm-nvpn.sh', 'utf8');
	const selector = 'dockerfiles/webvm-first-exit.awk';
	assert.match(launcher, /NVPN_WEBVM_AUTO_SELECT_EXIT:-1/u);
	assert.match(launcher, /\.webvm-exit-autoselect-complete/u);
	assert.match(launcher, /awk -f \/usr\/local\/libexec\/webvm-first-exit\.awk/u);
	assert.match(launcher, /daemon\.state\.json/u);
	assert.doesNotMatch(launcher, /nvpn status/u);
	assert.match(launcher, /nvpn set --config "\$config" --exit-node "\$exit_peer"/u);
	assert.match(launcher, /nvpn reload --config "\$config"/u);
	assert.doesNotMatch(launcher, /--wireguard-exit-enabled true/u);

	for (const peerFirst of [false, true]) {
		const candidate = [
			'    {',
			...(peerFirst ? ['      "participant_pubkey": "offered-exit",'] : []),
			'      "advertised_routes": [',
			'        "0.0.0.0/0"',
			'      ],',
			...(!peerFirst ? ['      "participant_pubkey": "offered-exit",'] : []),
			'      "reachable": true',
			'    }',
		];
		const status = [
			'{',
			'  "peers": [',
			'    {',
			'      "advertised_routes": [],',
			'      "participant_pubkey": "ordinary-peer"',
			'    },',
			...candidate,
			'  ]',
			'}',
		].join('\n');
		const parsed = spawnSync('awk', ['-f', selector], { input: status, encoding: 'utf8' });
		assert.equal(parsed.status, 0, parsed.stderr);
		assert.equal(parsed.stdout.trim(), 'offered-exit');
	}
});

test('WebVM guest retains the Linux firewall required by the FIPS host tunnel', () => {
	const guest = readFileSync('dockerfiles/v86_guest', 'utf8');
	const tunnelSetup = readFileSync('dockerfiles/webvm-tun.sh', 'utf8');
	assert.match(guest, /^    nftables \\\s*$/mu);
	assert.match(guest, /! -path '\*\/net\/netfilter\/\*'/u);
	assert.match(guest, /! -path '\*\/net\/ipv4\/netfilter\/\*'/u);
	assert.match(guest, /! -path '\*\/net\/ipv6\/netfilter\/\*'/u);
	assert.match(guest, /! -path '\*\/lib\/libcrc32c\.ko\*'/u);
	assert.match(guest, /! -path '\*\/crypto\/crc32c_generic\.ko\*'/u);
	assert.match(tunnelSetup, /^modprobe crc32c_generic$/mu);
	assert.match(tunnelSetup, /^modprobe nf_tables$/mu);
});

test('WebVM Ethernet carries full-size native FIPS frames', () => {
	const config = readFileSync('src/lib/webvmFipsConfig.js', 'utf8');
	const host = readFileSync('src/lib/webvmFipsHost.js', 'utf8');
	const guest = readFileSync('dockerfiles/webvm-nvpn.sh', 'utf8');
	assert.match(config, /WEBVM_FIPS_ETHERNET_MTU = 1497/u);
	assert.match(config, /WEBVM_FIPS_UNDERLAY_MTU = 1400/u);
	assert.match(host, /mtu: WEBVM_FIPS_ETHERNET_MTU/u);
	assert.match(host, /discovery: true/u);
	assert.match(host, /ETHERNET_SESSION_STALE_MS = 45_000/u);
	assert.match(host, /ethernet\.close\(address\)/u);
	assert.match(host, /new WebSocketTransport\([\s\S]*mtu: WEBVM_FIPS_UNDERLAY_MTU/u);
	assert.match(host, /new WebRtcTransport\([\s\S]*mtu: WEBVM_FIPS_UNDERLAY_MTU/u);
	assert.match(guest, /ip link set dev "\$ethernet_interface" mtu 1500/u);
});
