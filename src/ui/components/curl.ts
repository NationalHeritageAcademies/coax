export interface ToCurlInput {
	method: string;
	url: string;
	headers: { key: string; value: string }[];
	body?: { kind: string; raw: string };
}

/**
 * Converts a request draft to an equivalent `curl` command line.
 * Single-quotes everything for shell safety; embeds masked values for
 * keys whose name appears in `maskHeaderKeys` (lowercased).
 */
export function toCurl(input: ToCurlInput, maskHeaderKeys = new Set<string>()): string {
	const lines: string[] = [`curl -X ${input.method.toUpperCase()} ${shellQuote(input.url)}`];
	for (const h of input.headers) {
		const masked = maskHeaderKeys.has(h.key.toLowerCase()) ? '••••' : h.value;
		lines.push(`  -H ${shellQuote(`${h.key}: ${masked}`)}`);
	}
	if (input.body && input.body.raw !== '') {
		lines.push(`  --data ${shellQuote(input.body.raw)}`);
	}
	return lines.join(' \\\n');
}

function shellQuote(s: string): string {
	// Wrap in single quotes; escape any embedded single quotes via the standard
	// close-quote, escaped-quote, re-open-quote pattern.
	return `'${s.replace(/'/g, `'\\''`)}'`;
}
