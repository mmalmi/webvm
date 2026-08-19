import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('interactive WebVM prompts quietly flush ash history before disk snapshots', () => {
	const page = readFileSync('src/routes/v86/+page.svelte', 'utf8');

	assert.match(page, /export PS1='\$\(history -w >\/dev\/null 2>&1\)root@webvm/u);
	assert.doesNotMatch(page, /export PS1='\$\(history -w 2>\/dev\/null\)root@webvm/u);
});
