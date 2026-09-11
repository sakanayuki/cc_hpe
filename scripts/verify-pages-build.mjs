import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('../dist/', import.meta.url);
const html = await readFile(new URL('index.html', root), 'utf8');
const repository = process.env.GITHUB_REPOSITORY?.split('/')[1];
const expectedBase = repository ? `/${repository}/assets/` : '/assets/';

if (!html.includes(expectedBase)) {
  throw new Error(`Pages base path is invalid: expected an asset URL below ${expectedBase}`);
}
if (/https?:\/\//i.test(html)) {
  throw new Error('Built index.html contains an external HTTP(S) URL');
}

const assets = [...html.matchAll(/(?:src|href)="([^"]+\/assets\/[^\"]+)"/g)].map((match) => match[1]);
if (assets.length === 0) throw new Error('No built assets were referenced by index.html');
for (const asset of assets) {
  const relative = asset.slice(asset.indexOf('/assets/') + 1);
  await stat(join(root.pathname, relative));
}

console.log(`Verified ${assets.length} same-origin Pages assets at ${expectedBase}`);
