import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  applyBodyProportions,
  applyJointCorrection,
  alignRootToImagePelvis,
  captureRestPose,
  fitFrontProjection,
  landmarkToModel,
  poseDirection,
  retargetSkeleton,
} from "./body-viewer";
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
  it.each([
    ["left/up", 0.2, 0.25],
    ["right/down", 0.8, 0.75],
  ])(
    "projects the hips onto an offset pelvis anchor (%s) with transformed parents and a portrait image",
    (_label, x, y) => {
      const viewport = { width: 1000, height: 600 };
      const imageSize = { width: 600, height: 1200 };
      const camera = new THREE.PerspectiveCamera(
        36,
        viewport.width / viewport.height,
        0.01,
        100,
      );
      camera.position.set(0.4, -0.2, 6);
      camera.lookAt(0, 0, 0);
      camera.updateProjectionMatrix();

      const parent = new THREE.Group();
      parent.position.set(0.3, -0.1, 0.2);
      parent.rotation.set(0.1, -0.2, 0.35);
      parent.scale.set(1.3, 0.8, 1.1);
      const root = new THREE.Group();
      root.scale.set(1.7, 0.65, 1.25);
      root.position.set(-0.25, 0.35, -0.1);
      const hips = new THREE.Bone();
      hips.name = "mixamorig:Hips";
      hips.position.set(0.15, 0.4, 0.05);
      parent.add(root);
      root.add(hips);

      const landmarks = structuredClone(points);
      landmarks[23] = { x: x - 0.04, y: y + 0.02, z: 0, visibility: 1 };
      landmarks[24] = { x: x + 0.04, y: y - 0.02, z: 0, visibility: 1 };
      expect(
        alignRootToImagePelvis(
          root,
          hips,
          landmarks,
          imageSize,
          viewport,
          camera,
        ),
      ).toBe(true);

      const projected = hips
        .getWorldPosition(new THREE.Vector3())
        .project(camera);
      const projectedPixel = {
        x: ((projected.x + 1) / 2) * viewport.width,
        y: ((1 - projected.y) / 2) * viewport.height,
      };
      // 600x1200 contained in 1000x600 is 300px wide with a 350px x offset.
      expect(projectedPixel.x).toBeCloseTo(350 + x * 300, 5);
      expect(projectedPixel.y).toBeCloseTo(y * 600, 5);
    },
  );

  it("minimizes major-joint reprojection error relative to image diagonal", () => {
    // shoulders, hips and feet in model space, transformed into a 9:16 photo.
    const model = [
      { x: -0.5, y: 1 },
      { x: 0.5, y: 1 },
      { x: -0.3, y: 0 },
      { x: 0.3, y: 0 },
      { x: -0.25, y: -1.5 },
      { x: 0.25, y: -1.5 },
    ];
    const image = model.map((p) => ({
      x: (p.x * 240 + 450) / 900,
      y: (-p.y * 240 + 760) / 1600,
    }));
    const fit = fitFrontProjection(
      model,
      image,
      { width: 900, height: 1600 },
      { width: 800, height: 500 },
    );
    expect(fit.normalizedRmsError).toBeLessThan(0.01);
    expect(fit.pixelsPerWorldUnit).toBeGreaterThan(0);
    expect(fit.distance).toBeGreaterThan(0);
  });
});

describe("rest-based body and joint editing", () => {
  const makeSkeleton = () => {
    const root = new THREE.Bone();
    root.name = "mixamorig:Hips";
    const add = (parent: THREE.Bone, name: string, x: number, y: number) => {
      const bone = new THREE.Bone();
      bone.name = name;
      bone.position.set(x, y, 0);
      parent.add(bone);
      return bone;
    };
    for (const side of ["Left", "Right"] as const) {
      const sign = side === "Left" ? -1 : 1;
      const shoulder = add(root, `mixamorig:${side}Shoulder`, sign, 1);
      const arm = add(shoulder, `mixamorig:${side}Arm`, sign, 0);
      const forearm = add(arm, `mixamorig:${side}ForeArm`, sign, 0);
      add(forearm, `mixamorig:${side}Hand`, sign, 0);
      const thigh = add(root, `mixamorig:${side}UpLeg`, sign * 0.25, -1);
      const shin = add(thigh, `mixamorig:${side}Leg`, 0, -1);
      add(shin, `mixamorig:${side}Foot`, 0, -1);
    }
    return root;
  };

  it("distributes arm and leg lengths over all three left/right segments without changing the other limb", () => {
    const model = makeSkeleton();
    const rest = captureRestPose(model);
    applyBodyProportions(model, rest, {
      height: 1,
      width: 1,
      armLength: 1.5,
      legLength: 1,
    });
    expect(
      model.getObjectByName("mixamorig:LeftArm")!.position.length(),
    ).toBeCloseTo(1.5);
    expect(
      model.getObjectByName("mixamorig:LeftForeArm")!.position.length(),
    ).toBeCloseTo(1.5);
    expect(
      model.getObjectByName("mixamorig:RightHand")!.position.length(),
    ).toBeCloseTo(1.5);
    expect(
      model.getObjectByName("mixamorig:LeftLeg")!.position.length(),
    ).toBeCloseTo(1);
    applyBodyProportions(model, rest, {
      height: 1,
      width: 1,
      armLength: 1,
      legLength: 1.25,
    });
    expect(
      model.getObjectByName("mixamorig:LeftUpLeg")!.position.length(),
    ).toBeCloseTo(Math.hypot(0.25, 1) * 1.25);
    expect(
      model.getObjectByName("mixamorig:RightFoot")!.position.length(),
    ).toBeCloseTo(1.25);
  });

  it("rebuilds height and width from rest and reports missing segment bones", () => {
    const model = makeSkeleton();
    const rest = captureRestPose(model);
    applyBodyProportions(model, rest, {
      height: 1.2,
      width: 0.8,
      armLength: 1,
      legLength: 1,
    });
    expect(model.scale.toArray()).toEqual([0.8, 1.2, 1]);
    const hand = model.getObjectByName("mixamorig:RightHand")!;
    hand.position.setScalar(99);
    applyBodyProportions(model, rest, {
      height: 1,
      width: 1,
      armLength: 1,
      legLength: 1,
    });
    expect(hand.position.toArray()).toEqual(
      rest.get(hand.name)!.localPosition.toArray(),
    );
    hand.removeFromParent();
    expect(
      applyBodyProportions(model, rest, {
        height: 1,
        width: 1,
        armLength: 1,
        legLength: 1,
      }).missingBones,
    ).toContain(hand.name);
  });

  it("propagates local translation to descendants and resets exactly to rest", () => {
    const model = makeSkeleton();
    const rest = captureRestPose(model);
    const arm = model.getObjectByName("mixamorig:LeftArm")!;
    const hand = model.getObjectByName("mixamorig:LeftHand")!;
    const before = hand.getWorldPosition(new THREE.Vector3());
    const saved = rest.get(arm.name)!;
    applyJointCorrection(arm, saved.localPosition, saved.localQuaternion, {
      rotation: new THREE.Euler(),
      translation: new THREE.Vector3(0.1, 0.05, 0),
    });
    const propagated = hand.getWorldPosition(new THREE.Vector3()).sub(before);
    expect(propagated.x).toBeCloseTo(0.1);
    expect(propagated.y).toBeCloseTo(0.05);
    expect(propagated.z).toBeCloseTo(0);
    applyJointCorrection(arm, saved.localPosition, saved.localQuaternion);
    expect(arm.position.toArray()).toEqual(saved.localPosition.toArray());
    expect(Math.abs(arm.quaternion.dot(saved.localQuaternion))).toBeCloseTo(1);
  });
});
