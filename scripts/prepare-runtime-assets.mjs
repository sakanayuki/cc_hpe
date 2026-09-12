import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bodyOnly = process.argv.includes("--body-only");

const models = [
  {
    url: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task",
    sha256: "5134a3aad27a58b93da0088d431f366da362b44e3ccfbe3462b3827a839011b1",
    output: "public/runtime/models/pose_landmarker_full.task",
    label: "Pose",
  },
  {
    url: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
    sha256: "fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1",
    output: "public/runtime/models/hand_landmarker.task",
    label: "Hand",
  },
];
if (!bodyOnly) {
  await mkdir("public/runtime/wasm", { recursive: true });
  await mkdir(dirname(models[0].output), { recursive: true });
  await cp("node_modules/@mediapipe/tasks-vision/wasm", "public/runtime/wasm", {
    recursive: true,
  });
  for (const model of models) {
    let bytes;
    try {
      bytes = await readFile(model.output);
    } catch {
      bytes = new Uint8Array(await (await fetch(model.url)).arrayBuffer());
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== model.sha256)
      throw new Error(`${model.label} model checksum mismatch: ${digest}`);
    await writeFile(model.output, bytes);
  }
}

// fbx2gltf resolves the output directory with realpathSync, so it must exist
// on a clean checkout even when --body-only skips the model/wasm setup above.
await mkdir("public/runtime", { recursive: true });

const temporary = await mkdtemp(join(tmpdir(), "posesplat-fbx-"));
try {
  const fbx = join(temporary, "body.fbx");
  await promisify(execFile)(
    "unzip",
    ["-p", "womenfemale-body-base-rigged.zip", "source/MujerBaseRigged.fbx"],
    { encoding: "buffer", maxBuffer: 8_000_000 },
  ).then(({ stdout }) => writeFile(fbx, stdout));
  const require = createRequire(import.meta.url);
  const convert = require("fbx2gltf");
  await convert(fbx, "public/runtime/body.glb", ["--binary"]);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

const REQUIRED_CHAINS = [
  ["Hips", "Spine", "Spine1", "Spine2"],
  [
    "Spine2",
    "LeftShoulder",
    "LeftArm",
    "LeftForeArm",
    "LeftHand",
    "LeftHandMiddle1",
  ],
  [
    "Spine2",
    "RightShoulder",
    "RightArm",
    "RightForeArm",
    "RightHand",
    "RightHandMiddle1",
  ],
  ["Hips", "LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase"],
  ["Hips", "RightUpLeg", "RightLeg", "RightFoot", "RightToeBase"],
];

function parseGlb(bytes) {
  if (bytes.readUInt32LE(0) !== 0x46546c67)
    throw new Error("body.glb is not a GLB file");
  let json, binary;
  for (let offset = 12; offset < bytes.length; ) {
    const length = bytes.readUInt32LE(offset);
    const type = bytes.readUInt32LE(offset + 4);
    const chunk = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 0x4e4f534a) json = JSON.parse(chunk.toString("utf8"));
    if (type === 0x004e4942) binary = chunk;
    offset += 8 + length;
  }
  if (!json || !binary)
    throw new Error("body.glb must contain JSON and BIN chunks");
  return { json, binary };
}

async function inspectBodyGlb(path) {
  const { json, binary } = parseGlb(await readFile(path));
  const nodes = json.nodes ?? [];
  const byName = new Map(nodes.map((node, index) => [node.name, index]));
  const fullName = (name) => `mixamorig:${name}`;
  const required = new Set(
    REQUIRED_CHAINS.flatMap((chain) => chain.slice(0, -1)).map(fullName),
  );
  const errors = [];
  for (const name of required)
    if (!byName.has(name)) errors.push(`missing required bone ${name}`);
  for (const chain of REQUIRED_CHAINS) {
    for (let i = 0; i < chain.length - 1; i++) {
      const parentName = fullName(chain[i]),
        childName = fullName(chain[i + 1]);
      const parent = nodes[byName.get(parentName)],
        childIndex = byName.get(childName);
      if (
        parent &&
        childIndex !== undefined &&
        !(parent.children ?? []).includes(childIndex)
      )
        errors.push(
          `invalid hierarchy: ${parentName} must directly parent ${childName}`,
        );
      if (
        parent &&
        childIndex !== undefined &&
        Math.hypot(...(nodes[childIndex].translation ?? [0, 0, 0])) <= 1e-7
      )
        errors.push(`zero-length bone ${parentName} -> ${childName}`);
    }
  }
  const skins = json.skins ?? [];
  if (!skins.length) errors.push("no skin found");
  for (const [skinIndex, skin] of skins.entries()) {
    const joints = new Set(skin.joints ?? []);
    for (const name of required)
      if (byName.has(name) && !joints.has(byName.get(name)))
        errors.push(`skin ${skinIndex} omits ${name}`);
    const accessor = json.accessors?.[skin.inverseBindMatrices];
    if (
      !accessor ||
      accessor.type !== "MAT4" ||
      accessor.componentType !== 5126 ||
      accessor.count !== skin.joints.length
    ) {
      errors.push(
        `skin ${skinIndex} has invalid inverse bind matrices accessor`,
      );
      continue;
    }
    const view = json.bufferViews?.[accessor.bufferView];
    const start = (view?.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const values = new Float32Array(
      binary.buffer,
      binary.byteOffset + start,
      accessor.count * 16,
    );
    if (![...values].every(Number.isFinite))
      errors.push(`skin ${skinIndex} has non-finite inverse bind matrices`);
  }
  if (!nodes.some((node) => node.mesh !== undefined && node.skin !== undefined))
    errors.push("no mesh node references a skin");
  if (errors.length)
    throw new Error(`GLB asset inspection failed:\n- ${errors.join("\n- ")}`);
  console.log(
    `Inspected ${path}: ${required.size} required bones, skin, inverse bind matrices and non-zero lengths OK`,
  );
}

await inspectBodyGlb("public/runtime/body.glb");
