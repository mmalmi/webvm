import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: adapter(),
		csp: {
			mode: 'hash',
			directives: {
				'default-src': ['self'],
				'base-uri': ['none'],
				'connect-src': [
					'self',
					'stun:',
					'wss:'
				],
				'font-src': ['self', 'data:'],
				'img-src': ['self', 'data:'],
				'object-src': ['none'],
				'script-src': ['self', 'wasm-unsafe-eval'],
				'style-src': ['self', 'unsafe-inline'],
				'worker-src': ['self', 'blob:']
			}
		}
	},
	preprocess: vitePreprocess()
};

export default config;
