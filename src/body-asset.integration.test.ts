import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  alignRootToImagePelvis,
  captureRestPose,
  restoreMixamoBoneNames,
  retargetSkeleton,
} from "./body-viewer";
import type { PoseGuidance } from "./pose";

const MAX_HIP_REPROJECTION_ERROR_DIAGONAL_RATIO = 1e-5;

async function loadBodyAsset() {
  globalThis.ProgressEvent ??= class NodeProgressEvent extends Event {
    readonly lengthComputable = false;
    readonly loaded = 0;
    readonly total = 0;
  } as typeof ProgressEvent;
  const bytes = await readFile("public/runtime/body.glb");
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
  const gltf = await new Promise<Awaited<ReturnType<GLTFLoader["loadAsync"]>>>(
    (resolve, reject) => new GLTFLoader().parse(buffer, "", resolve, reject),
  );
  restoreMixamoBoneNames(gltf.scene);
  gltf.scene.updateWorldMatrix(true, true);
  return gltf.scene;
}

function armsDownFixture(): PoseGuidance {
  const landmarks = Array.from({ length: 33 }, () => ({
    x: 0.5,
    y: 0.5,
    z: 0,
    visibility: 1,
  }));
  const worldLandmarks = Array.from({ length: 33 }, () => ({
    x: 0,
    y: 0,
    z: 0,
    visibility: 1,
  }));
  const put = (index: number, x: number, y: number, z = 0) => {
    worldLandmarks[index] = { x, y: -y, z: -z, visibility: 1 };
  };
  put(0, 0, 1.65);
  put(7, -0.08, 1.5);
  put(8, 0.08, 1.5);
  put(11, -0.35, 1.25);
  put(12, 0.35, 1.25);
  put(13, -0.38, 0.7, 0.08);
  put(14, 0.38, 0.7, 0.08);
  put(15, -0.4, 0.15, 0.04);
  put(16, 0.4, 0.15, 0.04);
  put(17, -0.42, 0.02);
  put(18, 0.42, 0.02);
  put(19, -0.38, 0.02);
  put(20, 0.38, 0.02);
  put(23, -0.2, 0);
  put(24, 0.2, 0);
  put(25, -0.2, -0.75);
  put(26, 0.2, -0.75);
  put(27, -0.2, -1.5);
  put(28, 0.2, -1.5);
  put(31, -0.2, -1.5, 0.25);
  put(32, 0.2, -1.5, 0.25);
  landmarks[23] = { x: 0.42, y: 0.57, z: 0, visibility: 1 };
  landmarks[24] = { x: 0.46, y: 0.59, z: 0, visibility: 1 };
  return {
    landmarks,
    worldLandmarks,
    mask: new Float32Array([1]),
    maskWidth: 1,
    maskHeight: 1,
  };
}

function vertexWorld(mesh: THREE.SkinnedMesh, index: number) {
  const vertex = new THREE.Vector3().fromBufferAttribute(
    mesh.geometry.attributes.position,
    index,
  );
  mesh.applyBoneTransform(index, vertex);
  return mesh.localToWorld(vertex);
}

describe("generated body.glb integration", () => {
  it("deforms the real skinned asset for the known arms-down pose", async () => {
    const model = await loadBodyAsset();
    const names = ["LeftArm", "LeftForeArm", "RightArm", "RightForeArm"].map(
      (name) => `mixamorig:${name}`,
    );
    const beforeRotations = new Map(
      names.map((name) => [
        name,
        model.getObjectByName(name)!.getWorldQuaternion(new THREE.Quaternion()),
      ]),
    );
    const wrists = ["mixamorig:LeftHand", "mixamorig:RightHand"].map(
      (name) => model.getObjectByName(name)!,
    );
    const beforeWrists = wrists.map((bone) =>
      bone.getWorldPosition(new THREE.Vector3()),
    );
    const mesh = model.getObjectByProperty(
      "isSkinnedMesh",
      true,
    ) as THREE.SkinnedMesh;
    const sampleStep = Math.max(
      1,
      Math.floor(mesh.geometry.attributes.position.count / 1000),
    );
    const indices = Array.from(
      {
        length: Math.ceil(mesh.geometry.attributes.position.count / sampleStep),
      },
      (_, i) => i * sampleStep,
    ).filter((i) => i < mesh.geometry.attributes.position.count);
    const beforeVertices = indices.map((index) => vertexWorld(mesh, index));

    const report = retargetSkeleton(
      model,
      armsDownFixture(),
      captureRestPose(model),
    );
    expect(report.appliedBones).toBeGreaterThan(0);
    for (const name of names) {
      const after = model
        .getObjectByName(name)!
        .getWorldQuaternion(new THREE.Quaternion());
      expect(Math.abs(after.dot(beforeRotations.get(name)!))).toBeLessThan(
        0.9999,
      );
    }
    wrists.forEach((bone, i) =>
      expect(
        bone.getWorldPosition(new THREE.Vector3()).distanceTo(beforeWrists[i]),
      ).toBeGreaterThan(1e-4),
    );
    const greatestVertexMotion = Math.max(
      ...indices.map((index, i) =>
        vertexWorld(mesh, index).distanceTo(beforeVertices[i]),
      ),
    );
    expect(greatestVertexMotion).toBeGreaterThan(1e-4);
  });

  it("aligns the real GLB hips within the explicit image-diagonal tolerance", async () => {
    const model = await loadBodyAsset();
    const hips = model.getObjectByName("mixamorig:Hips")!;
    const viewport = { width: 960, height: 540 },
      imageSize = { width: 900, height: 1600 };
    const camera = new THREE.PerspectiveCamera(
      36,
      viewport.width / viewport.height,
      0.01,
      100,
    );
    camera.position.z = 3;
    camera.updateProjectionMatrix();
    const fixture = armsDownFixture();
    expect(
      alignRootToImagePelvis(
        model,
        hips,
        fixture.landmarks,
        imageSize,
        viewport,
        camera,
      ),
    ).toBe(true);
    const clip = hips.getWorldPosition(new THREE.Vector3()).project(camera);
    const actual = {
      x: ((clip.x + 1) / 2) * viewport.width,
      y: ((1 - clip.y) / 2) * viewport.height,
    };
    const containedWidth =
      (imageSize.width / imageSize.height) * viewport.height;
    const pelvis = {
      x: (fixture.landmarks[23].x + fixture.landmarks[24].x) / 2,
      y: (fixture.landmarks[23].y + fixture.landmarks[24].y) / 2,
    };
    const expected = {
      x: (viewport.width - containedWidth) / 2 + pelvis.x * containedWidth,
      y: pelvis.y * viewport.height,
    };
    const errorRatio =
      Math.hypot(actual.x - expected.x, actual.y - expected.y) /
      Math.hypot(viewport.width, viewport.height);
    expect(errorRatio).toBeLessThanOrEqual(
      MAX_HIP_REPROJECTION_ERROR_DIAGONAL_RATIO,
    );
  });
});
