export function parseSerialCommandResult(text, beginMarker, endMarker) {
	const normalized = text.replaceAll('\r', '');
	let beginFrom = normalized.length;
	while (beginFrom >= 0) {
		const beginIndex = normalized.lastIndexOf(beginMarker, beginFrom);
		if (beginIndex < 0) return null;

		const outputStart = beginIndex + beginMarker.length;
		let endIndex = normalized.indexOf(endMarker, outputStart);
		while (endIndex >= 0) {
			const statusMatch = normalized.slice(endIndex + endMarker.length).match(/^:(\d+)/);
			if (statusMatch) {
				const status = Number.parseInt(statusMatch[1], 10);
				if (Number.isInteger(status)) {
					const output = normalized.slice(outputStart, endIndex)
						.split('\n')
						.map((line) => line.trim())
						.filter(Boolean);
					return { status, output };
				}
			}
			endIndex = normalized.indexOf(endMarker, endIndex + endMarker.length);
		}

		if (beginIndex === 0) return null;
		beginFrom = beginIndex - 1;
	}
	return null;
}
