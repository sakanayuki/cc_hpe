import { describe, expect, it } from "vitest";
import { poseDirection, solveFrontAlignment } from "./body-viewer";
import type { PoseGuidance } from "./pose";

const points = Array.from({ length: 33 }, () => ({
  x: 0,
  y: 0,
  z: 0,
  visibility: 1,
}));
const pose = {
  landmarks: points,
  worldLandmarks: points,
  mask: new Float32Array([1]),
  maskWidth: 1,
  maskHeight: 1,
} satisfies PoseGuidance;

describe("GLB pose retargeting", () => {
  it("uses 3D world-landmark depth instead of flattened image coordinates", () => {
    pose.worldLandmarks[11] = { x: 0, y: 0, z: 0, visibility: 1 };
    pose.worldLandmarks[13] = { x: 1, y: 0, z: 1, visibility: 1 };
    const direction = poseDirection([11], [13], pose);
    expect(direction.x).toBeCloseTo(Math.SQRT1_2);
    expect(direction.z).toBeCloseTo(-Math.SQRT1_2);
  });
  it("supports midpoint landmarks for torso retargeting", () => {
    pose.worldLandmarks[23] = { x: -1, y: 1, z: 0, visibility: 1 };
    pose.worldLandmarks[24] = { x: 1, y: 1, z: 0, visibility: 1 };
    pose.worldLandmarks[11] = { x: -1, y: 0, z: 0, visibility: 1 };
    pose.worldLandmarks[12] = { x: 1, y: 0, z: 0, visibility: 1 };
    expect(poseDirection([23, 24], [11, 12], pose).y).toBeCloseTo(1);
  });
  it("retargets parent-child arm and leg world directions without swapping left/right", () => {
    const root = new THREE.Bone();
    root.name = "mixamorig:Hips";
    const add = (parent: THREE.Bone, name: string, position: THREE.Vector3) => {
      const bone = new THREE.Bone();
      bone.name = name;
      bone.position.copy(position);
      parent.add(bone);
      return bone;
    };
    const spine = add(root, "mixamorig:Spine", new THREE.Vector3(0, 1, 0));
    add(spine, "mixamorig:Spine1", new THREE.Vector3(0, 1, 0));
    const leftArm = add(root, "mixamorig:LeftArm", new THREE.Vector3(-1, 1, 0));
    const leftForearm = add(
      leftArm,
      "mixamorig:LeftForeArm",
      new THREE.Vector3(-1, 0, 0),
    );
    add(leftForearm, "mixamorig:LeftHand", new THREE.Vector3(-1, 0, 0));
    const leftLeg = add(
      root,
      "mixamorig:LeftUpLeg",
      new THREE.Vector3(-0.5, 0, 0),
    );
    const leftShin = add(
      leftLeg,
      "mixamorig:LeftLeg",
      new THREE.Vector3(0, -1, 0),
    );
    add(leftShin, "mixamorig:LeftFoot", new THREE.Vector3(0, -1, 0));
    root.updateWorldMatrix(true, true);
    const rest = captureRestPose(root);
    const p = structuredClone(pose);
    p.worldLandmarks[11] = { x: -1, y: -1, z: 0, visibility: 1 };
    p.worldLandmarks[12] = { x: 1, y: -1, z: 0, visibility: 1 };
    p.worldLandmarks[23] = { x: -0.5, y: 0, z: 0, visibility: 1 };
    p.worldLandmarks[24] = { x: 0.5, y: 0, z: 0, visibility: 1 };
    p.worldLandmarks[13] = { x: -2, y: -1, z: 1, visibility: 1 };
    p.worldLandmarks[15] = { x: -3, y: -2, z: 1, visibility: 1 };
    p.worldLandmarks[25] = { x: -0.5, y: 1, z: 1, visibility: 1 };
    p.worldLandmarks[27] = { x: 0, y: 2, z: 1, visibility: 1 };
    retargetSkeleton(root, p, rest);
    const direction = (a: THREE.Object3D, b: THREE.Object3D) =>
      b
        .getWorldPosition(new THREE.Vector3())
        .sub(a.getWorldPosition(new THREE.Vector3()))
        .normalize();
    expect(
      direction(leftArm, leftForearm).dot(poseDirection([11], [13], p)),
    ).toBeCloseTo(1);
    expect(
      direction(leftLeg, leftShin).dot(poseDirection([23], [25], p)),
    ).toBeCloseTo(1);
    expect(landmarkToModel(p.worldLandmarks[11]).x).toBeLessThan(
      landmarkToModel(p.worldLandmarks[12]).x,
    );
  });

  it("does not accumulate rotations or root translation on repeated retargeting", () => {
    const hips = new THREE.Bone();
    hips.name = "mixamorig:Hips";
    const spine = new THREE.Bone();
    spine.name = "mixamorig:Spine";
    spine.position.y = 1;
    hips.add(spine);
    const spine1 = new THREE.Bone();
    spine1.name = "mixamorig:Spine1";
    spine1.position.y = 1;
    spine.add(spine1);
    const rest = captureRestPose(hips);
    const p = structuredClone(pose);
    p.worldLandmarks[11] = { x: -1, y: -2, z: 0.3, visibility: 1 };
    p.worldLandmarks[12] = { x: 1, y: -1, z: 0, visibility: 1 };
    p.worldLandmarks[23] = { x: -0.5, y: 0, z: 0, visibility: 1 };
    p.worldLandmarks[24] = { x: 0.5, y: 0, z: 0, visibility: 1 };
    retargetSkeleton(hips, p, rest);
    const onceQ = hips.quaternion.clone();
    const onceP = hips.position.clone();
    retargetSkeleton(hips, p, rest);
    expect(Math.abs(hips.quaternion.dot(onceQ))).toBeCloseTo(1);
    expect(hips.position.distanceTo(onceP)).toBeCloseTo(0);
  });
});

describe("front image/GLB projection alignment", () => {
  it("minimizes shoulder, hip, knee and ankle error relative to image diagonal", () => {
    const glb = [
      { x: -0.45, y: -0.8 },
      { x: 0.45, y: -0.8 },
      { x: -0.25, y: 0 },
      { x: 0.25, y: 0 },
      { x: -0.22, y: 0.85 },
      { x: 0.22, y: 0.85 },
      { x: -0.2, y: 1.65 },
      { x: 0.2, y: 1.65 },
    ];
    const landmarks = glb.map((p, i) => ({
      x: 225 + p.x * 180 + (i % 2 ? 1 : -1),
      y: 360 + p.y * 180 + ((i % 3) - 1),
    }));
    const fit = solveFrontAlignment(glb, landmarks, {
      width: 450,
      height: 800,
    });
    expect(fit.rmsDiagonalRatio).toBeLessThan(0.003);
    expect(fit.pixelsPerUnit).toBeCloseTo(180, 0);
  });
});
