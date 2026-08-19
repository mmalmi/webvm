export function parseSerialCommandResult(text, beginMarker, endMarker) {
	const normalized = text.replaceAll('\r', '');
	const beginIndex = normalized.lastIndexOf(beginMarker);
	if (beginIndex < 0) return null;

	const outputStart = beginIndex + beginMarker.length;
	const endIndex = normalized.indexOf(endMarker, outputStart);
	if (endIndex < 0) return null;

	const statusMatch = normalized.slice(endIndex + endMarker.length).match(/^:(\d+)/);
	if (!statusMatch) return null;
	const status = Number.parseInt(statusMatch[1], 10);
	if (!Number.isInteger(status)) return null;

	const output = normalized.slice(outputStart, endIndex)
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean);
	return { status, output };
}
