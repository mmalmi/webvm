import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

export default defineConfig({
	build: {
		target: 'es2022',
	},
	plugins: [
		sveltekit(),
		viteStaticCopy({
			targets: [
				{ src: 'custom-disk-images/v86-guest/seabios.bin', dest: 'v86' },
				{ src: 'custom-disk-images/v86-guest/vgabios.bin', dest: 'v86' },
				{ src: 'node_modules/v86/build/v86.wasm', dest: 'v86' },
				{ src: 'node_modules/v86/build/v86-fallback.wasm', dest: 'v86' },
				{ src: 'custom-disk-images/v86-guest/fs.json', dest: 'v86/guest' },
				{ src: 'custom-disk-images/v86-guest/rootfs', dest: 'v86/guest' },
				{ src: 'custom-disk-images/v86-guest/state', dest: 'v86/guest' }
			]
		})
	]
});
