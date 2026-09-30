import { dev } from '$app/environment';

export async function prepareWebvmOffline() {
	if (dev || !globalThis.navigator?.serviceWorker) return;
	const worker = navigator.serviceWorker;
	let timer;
	let finished = false;
	let removeListeners = () => {};
	try {
		await Promise.race([
			(async () => {
				const registration = await worker.register('/service-worker.js');
				if (finished || worker.controller) return;
				await new Promise((resolve, reject) => {
					const installing = registration.installing || registration.waiting;
					const changed = () => {
						if (worker.controller) resolve();
						else if (installing?.state === 'redundant') reject(new Error('Offline cache unavailable'));
					};
					worker.addEventListener('controllerchange', changed);
					installing?.addEventListener('statechange', changed);
					removeListeners = () => {
						worker.removeEventListener('controllerchange', changed);
						installing?.removeEventListener('statechange', changed);
					};
					changed();
				});
			})(),
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error('Offline cache is still loading')), 15_000);
			}),
		]);
	} catch (error) {
		// Storage restrictions or a slow first download must not prevent online use.
		console.warn('WebVM offline cache is not ready', error);
	} finally {
		finished = true;
		clearTimeout(timer);
		removeListeners();
	}
}
