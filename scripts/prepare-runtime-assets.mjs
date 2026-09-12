import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
