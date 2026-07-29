// Generates src/ui/components/ui/icon/icon-set.ts from the Phosphor source SVGs.
//
// Coax inlines the handful of icons it actually uses rather than shipping an
// icon font. Fonts were a recurring packaging hazard here: under file:// a
// mis-resolved @font-face silently renders every glyph as a tofu box, and the
// failure only shows up in a packaged build. Inlined path data has no such
// failure mode, adds ~6 kB, and needs no asset-copy step.
//
// Every icon in ICON_NAMES is a single <path> in Phosphor's regular weight, so
// we store just the `d` attribute and bind it with [attr.d] — no innerHTML and
// no DomSanitizer bypass anywhere in the render path.
//
// Usage:  node scripts/generate-icon-set.mjs
// Adding an icon: add its Phosphor name below and re-run.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC = join(ROOT, 'node_modules', '@phosphor-icons', 'core', 'assets', 'regular');
const OUT = join(ROOT, 'src', 'ui', 'components', 'ui', 'icon', 'icon-set.ts');

const ICON_NAMES = [
	'arrow-square-out',
	'cards-three',
	'caret-down',
	'caret-right',
	'check',
	'check-circle',
	'copy',
	'dots-three-vertical',
	'download-simple',
	'file-arrow-down',
	'folder',
	'folder-open',
	'folder-plus',
	'gear',
	'globe',
	'lock',
	'moon',
	'pencil-simple',
	'plus',
	'question',
	'sparkle',
	'sun',
	'trash',
	'upload-simple',
	'x',
	'x-circle'
];

if (!existsSync(SRC)) {
	console.error(`Phosphor assets not found at ${SRC}\nRun: npm install`);
	process.exit(1);
}

const entries = ICON_NAMES.map((name) => {
	const file = join(SRC, `${name}.svg`);
	if (!existsSync(file)) throw new Error(`No such Phosphor icon: ${name}`);
	const svg = readFileSync(file, 'utf8');
	const paths = [...svg.matchAll(/<path\b[^>]*\bd="([^"]+)"/g)].map((m) => m[1]);
	if (paths.length !== 1) {
		throw new Error(`Expected exactly one <path> in ${name}.svg, found ${paths.length}. ` + `The icon component binds a single [attr.d] and would drop the rest.`);
	}
	return [name, paths[0]];
});

const body = entries.map(([name, d]) => `\t'${name}': '${d}'`).join(',\n');

const out = `// GENERATED FILE — do not edit by hand.
// Regenerate with: node scripts/generate-icon-set.mjs
//
// Phosphor Icons (regular weight), MIT licensed — https://phosphoricons.com
// Only the icons Coax actually renders are inlined here; see the generator for
// why we inline rather than ship a font.

export const ICON_PATHS = {
${body}
} as const satisfies Record<string, string>;

export type IconName = keyof typeof ICON_PATHS;

/** Phosphor's canonical 256x256 design grid. */
export const ICON_VIEW_BOX = '0 0 256 256';
`;

writeFileSync(OUT, out, 'utf8');
console.log(`Wrote ${entries.length} icons to ${OUT.replace(ROOT + '/', '')}`);
