import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

const copy = (src, dest) => ({ src, dest, rename: { stripBase: true } });

export default defineConfig({
	build: {
		target: 'es2022',
	},
	plugins: [
		sveltekit(),
		viteStaticCopy({
			targets: [
				copy('custom-disk-images/v86-guest/seabios.bin', 'v86'),
				copy('custom-disk-images/v86-guest/vgabios.bin', 'v86'),
				copy('node_modules/v86/build/v86.wasm', 'v86'),
				copy('node_modules/v86/build/v86-fallback.wasm', 'v86'),
				copy('custom-disk-images/v86-guest/fs.json', 'v86/guest'),
				copy('custom-disk-images/v86-guest/manifest.json', 'v86/guest'),
				copy('custom-disk-images/v86-guest/rootfs', 'v86/guest/rootfs'),
				copy('custom-disk-images/v86-guest/state', 'v86/guest/state'),
			]
		})
	]
});
