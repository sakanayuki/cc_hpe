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

const glb = await readFile(new URL('runtime/body.glb', root));
if (glb.length < 1_000_000 || glb.subarray(0, 4).toString('ascii') !== 'glTF') {
  throw new Error('The rigged body was not converted to a valid binary glTF asset');
}
const jsonLength = glb.readUInt32LE(12);
const gltf = JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8'));
const nodeNames = new Set(gltf.nodes?.map((node) => node.name));
for (const bone of ['mixamorig:Hips', 'mixamorig:Spine2', 'mixamorig:LeftArm', 'mixamorig:RightArm', 'mixamorig:LeftUpLeg', 'mixamorig:RightUpLeg']) {
  if (!nodeNames.has(bone)) throw new Error(`Required rig bone is missing from GLB: ${bone}`);
}
if (!gltf.skins?.length) throw new Error('Converted body GLB does not contain a skin');
const model = await stat(new URL('runtime/models/pose_landmarker_full.task', root));
if (model.size !== 9_398_198) throw new Error(`Unexpected pose model size: ${model.size}`);

console.log(`Verified Pages assets, pose model, and ${glb.length}-byte rigged body GLB at ${expectedBase}`);
