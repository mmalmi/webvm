import { browser } from '$app/environment';

let authKey;
let controlUrl;

if (browser) {
	const params = new URLSearchParams(`?${window.location.hash.slice(1)}`);
	authKey = params.get('authKey') || undefined;
	controlUrl = params.get('controlUrl') || undefined;
}

function validateLoginUrl(url) {
	const parsedUrl = new URL(url);
	if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
		throw new Error('Invalid network login URL scheme');
	}
	return parsedUrl.href;
}

function loginUrlCb(url) {
	validateLoginUrl(url);
}

function stateUpdateCb() {}

function netmapUpdateCb() {}

export const networkInterface = {
	authKey,
	controlUrl,
	loginUrlCb,
	stateUpdateCb,
	netmapUpdateCb,
};
