import { expect, test } from '@playwright/test';
import { InvWantMesh } from 'nostr-pubsub';

test('vendored pubsub suppresses penalties for locally disrupted transports', () => {
	const eventId = 'ab'.repeat(32);
	const eventKind = 7368;
	const mesh = new InvWantMesh({
		routeTtlMs: 10,
		eventTtlMs: 20,
		allowedKinds: new Set([eventKind]),
	});
	mesh.receive('transport-failed', {
		type: 'inventory',
		eventId,
		eventKind,
		payloadBytes: 512,
		hopLimit: 4,
	}, [], 1);

	expect(mesh.recordTransportDisruption('transport-failed', eventId)).toBe(true);
	expect(mesh.recordTransportDisruption('transport-failed', eventId)).toBe(false);
	expect(mesh.retainedState().transportDisruptedRoutePeers).toBe(1);
	mesh.maintain(20);
	expect(mesh.peerBehaviorObservation('transport-failed')).toBeUndefined();
	expect(mesh.retainedState().transportDisruptedRoutePeers).toBe(0);
});
