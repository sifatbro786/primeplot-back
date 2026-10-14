import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * Brand fonts for printed documents, embedded as base64 @font-face rules so the page renders
 * the same in the browser print preview and in headless Chrome (no network, no system fonts).
 * Licences: SIL Open Font License (Fontsource packages). Bangla glyphs come from Hind Siliguri;
 * Chrome shapes conjuncts (ক্ষ, ন্ত্র) correctly — PDFKit/react-pdf do not (ARCHITECTURE §6.6).
 */
const require = createRequire(import.meta.url);

const FACES = [
  // family, package, file stem, weight, unicode-range
  ['Playfair Display', '@fontsource/playfair-display', 'playfair-display-latin-600-normal', 600],
  ['Plus Jakarta Sans', '@fontsource/plus-jakarta-sans', 'plus-jakarta-sans-latin-400-normal', 400],
  ['Plus Jakarta Sans', '@fontsource/plus-jakarta-sans', 'plus-jakarta-sans-latin-600-normal', 600],
  ['Hind Siliguri', '@fontsource/hind-siliguri', 'hind-siliguri-bengali-400-normal', 400, 'U+0951-0952,U+0964-0965,U+0980-09FE,U+1CD0,U+1CD2,U+1CD5-1CD6,U+1CD8,U+1CE1,U+1CEA,U+1CED,U+1CF2,U+1CF5-1CF7,U+200C-200D,U+20B9,U+25CC,U+A8F1'],
  ['Hind Siliguri', '@fontsource/hind-siliguri', 'hind-siliguri-bengali-600-normal', 600, 'U+0951-0952,U+0964-0965,U+0980-09FE,U+1CD0,U+1CD2,U+1CD5-1CD6,U+1CD8,U+1CE1,U+1CEA,U+1CED,U+1CF2,U+1CF5-1CF7,U+200C-200D,U+20B9,U+25CC,U+A8F1'],
  ['Hind Siliguri', '@fontsource/hind-siliguri', 'hind-siliguri-latin-400-normal', 400],
  ['Hind Siliguri', '@fontsource/hind-siliguri', 'hind-siliguri-latin-600-normal', 600],
]; // prettier-ignore

let css = null;

function fontFile(pkg, stem) {
  const dir = dirname(require.resolve(`${pkg}/package.json`));
  return readFileSync(join(dir, 'files', `${stem}.woff2`));
}

/** The @font-face CSS (built once, ~400 KB of base64). */
export function fontFaceCss() {
  if (css) return css;
  css = FACES.map(([family, pkg, stem, weight, range]) => {
    const b64 = fontFile(pkg, stem).toString('base64');
    return `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:block;src:url(data:font/woff2;base64,${b64}) format('woff2');${range ? `unicode-range:${range};` : ''}}`;
  }).join('\n');
  return css;
}
