// Excalidraw loads its fonts from EXCALIDRAW_ASSET_PATH. Ship them with the
// module so the board never depends on a public CDN. Xiaolai (the CJK
// fallback, ~10MB) is left out; CJK text falls back to the system font.
import { cpSync, readdirSync } from 'node:fs';
const src = 'node_modules/@excalidraw/excalidraw/dist/prod/fonts';
for (const f of readdirSync(src)) if (f !== 'Xiaolai') cpSync(`${src}/${f}`, `dist/fonts/${f}`, { recursive: true });
console.log('fonts copied');
