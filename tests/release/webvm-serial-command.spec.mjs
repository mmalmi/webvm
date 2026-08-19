import assert from 'node:assert/strict';
import test from 'node:test';

import { parseSerialCommandResult } from '../e2e/helpers/webvm-serial-command.js';

test('parses markers surrounded by terminal prompt control sequences', () => {
	const begin = '__NVPN_STANDARD_BEGIN_abc__';
	const end = '__NVPN_STANDARD_END_abc__';
	const serial = [
		"root@webvm:~# printf '__NVPN_STANDARD_BEGIN_ab",
		"c__'; printf '__NVPN_STANDARD_END_abc__:%s'",
		`\u001b[?2004l\r${begin}\r`,
		'nvpn://join-request/example',
		'FIPS connection active; approval can be delivered immediately after an admin accepts.',
		`${end}:0\r`,
		'\u001b[?2004hroot@webvm:~# ',
	].join('\n');

	assert.deepEqual(parseSerialCommandResult(serial, begin, end), {
		status: 0,
		output: [
			'nvpn://join-request/example',
			'FIPS connection active; approval can be delivered immediately after an admin accepts.',
		],
	});
});

test('ignores an incomplete echoed marker before the completed command result', () => {
	const begin = '__NVPN_STANDARD_BEGIN_def__';
	const end = '__NVPN_STANDARD_END_def__';
	const serial = `${begin} echoed command without an end status\n${begin}\nready\n${end}:0\n`;

	assert.deepEqual(parseSerialCommandResult(serial, begin, end), {
		status: 0,
		output: ['ready'],
	});
});
