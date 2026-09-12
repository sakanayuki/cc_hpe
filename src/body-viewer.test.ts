import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  applyBodyProportions,
  applyJointCorrection,
  alignRootToImagePelvis,
  captureRestPose,
  fitFrontProjection,
  HEAD_BIND_POSE_X_CORRECTION,
  landmarkToModel,
  poseDirection,
  preservingCameraState,
  retargetSkeleton,
} from "./body-viewer";
import type { PoseGuidance } from "./pose";
import { associateHands, type HandPose } from "./pose";

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

describe("camera state preservation", () => {
  it.each([
    "depth scale",
    "body width",
    "body height",
    "limb lengths",
    "joint correction",
    "joint reset",
    "pose reset",
  ])("keeps arbitrary orbit/pan/zoom state during %s updates", () => {
    const camera = new THREE.PerspectiveCamera(36, 1.7, 0.01, 100);
    camera.position.set(2.4, -0.7, 4.1);
    camera.quaternion.setFromEuler(new THREE.Euler(0.31, -0.46, 0.12));
    camera.zoom = 2.35;
    camera.updateProjectionMatrix();
    const controls = {
      target: new THREE.Vector3(-0.8, 1.3, 0.45),
      update() {},
    };
    const expected = {
      position: camera.position.clone(),
      quaternion: camera.quaternion.clone(),
      zoom: camera.zoom,
      target: controls.target.clone(),
    };

    preservingCameraState(camera, controls, () => {
      // Model recalculation must remain safe even if a future implementation
      // temporarily uses camera-dependent image alignment internally.
      camera.position.set(99, 98, 97);
      camera.quaternion.identity();
      camera.zoom = 0.25;
      controls.target.set(-9, -8, -7);
    });

    expect(camera.position.toArray()).toEqual(expected.position.toArray());
    expect(camera.quaternion.toArray()).toEqual(expected.quaternion.toArray());
    expect(camera.zoom).toBe(expected.zoom);
    expect(controls.target.toArray()).toEqual(expected.target.toArray());
  });
});

describe("GLB pose retargeting", () => {
  const makeFrontFacingRig = () => {
    const hips = new THREE.Bone();
    hips.name = "mixamorig:Hips";
    hips.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
    const add = (parent: THREE.Bone, name: string, position: THREE.Vector3) => {
      const bone = new THREE.Bone();
      bone.name = name;
      bone.position.copy(position);
      parent.add(bone);
      return bone;
    };
    const spine = add(hips, "mixamorig:Spine", new THREE.Vector3(0, 1, 0));
    const spine1 = add(spine, "mixamorig:Spine1", new THREE.Vector3(0, 1, 0));
    const chest = add(spine1, "mixamorig:Spine2", new THREE.Vector3(0, 1, 0));
    const neck = add(chest, "mixamorig:Neck", new THREE.Vector3(0, 0.4, 0));
    const head = add(neck, "mixamorig:Head", new THREE.Vector3(0, 0.3, 0));
    add(head, "mixamorig:HeadTop_End", new THREE.Vector3(0, 0.4, 0));
    const leftShoulder = add(
      chest,
      "mixamorig:LeftShoulder",
      new THREE.Vector3(0.5, 0.3, 0),
    );
    add(leftShoulder, "mixamorig:LeftArm", new THREE.Vector3(0.5, 0, 0));
    const rightShoulder = add(
      chest,
      "mixamorig:RightShoulder",
      new THREE.Vector3(-0.5, 0.3, 0),
    );
    add(rightShoulder, "mixamorig:RightArm", new THREE.Vector3(-0.5, 0, 0));
    const leftLeg = add(
      hips,
      "mixamorig:LeftUpLeg",
      new THREE.Vector3(-0.3, 0, 0),
    );
    add(leftLeg, "mixamorig:LeftLeg", new THREE.Vector3(0, -1, 0));
    const rightLeg = add(
      hips,
      "mixamorig:RightUpLeg",
      new THREE.Vector3(0.3, 0, 0),
    );
    add(rightLeg, "mixamorig:RightLeg", new THREE.Vector3(0, -1, 0));
    hips.updateWorldMatrix(true, true);
    return {
      hips,
      chest,
      neck,
      head,
      leftShoulder,
      rightShoulder,
      leftLeg,
      rightLeg,
    };
  };

  const frontalPose = (depthOffset = 0) => {
    const p: PoseGuidance = structuredClone(pose);
    const put = (index: number, x: number, y: number, z: number) => {
      p.worldLandmarks[index] = { x, y: -y, z: -z, visibility: 1 };
    };
    put(23, -0.35, 0, depthOffset);
    put(24, 0.35, 0, -depthOffset);
    put(11, -0.7, 2, -depthOffset);
    put(12, 0.7, 2, depthOffset);
    put(7, -0.1, 3, 0);
    put(8, 0.1, 3, 0);
    put(0, 0, 3, 1);
    put(25, -0.35, -1, depthOffset);
    put(26, 0.35, -1, -depthOffset);
    return p;
  };

  it("keeps frontal torso and proximal limbs in the GLB bind-front hemisphere", () => {
    const rig = makeFrontFacingRig();
    const rest = captureRestPose(rig.hips);
    const referenceFront = new THREE.Vector3(0, 0, 1).applyQuaternion(
      rest.get("mixamorig:Hips")!.worldQuaternion,
    );

    retargetSkeleton(rig.hips, frontalPose(), rest);

    for (const bone of [rig.hips, rig.chest]) {
      const front = new THREE.Vector3(0, 0, 1).applyQuaternion(
        bone.getWorldQuaternion(new THREE.Quaternion()),
      );
      expect(front.dot(referenceFront)).toBeGreaterThan(0);
    }
    for (const bone of [
      rig.leftLeg,
      rig.rightLeg,
      rig.leftShoulder,
      rig.rightShoulder,
    ]) {
      const front = new THREE.Vector3(0, 0, 1).applyQuaternion(
        bone.getWorldQuaternion(new THREE.Quaternion()),
      );
      expect(front.dot(referenceFront)).toBeGreaterThan(0.99);
    }
  });

  it("does not flip torso frame sign when left and right move slightly in depth", () => {
    const rig = makeFrontFacingRig();
    const rest = captureRestPose(rig.hips);
    retargetSkeleton(rig.hips, frontalPose(-0.01), rest);
    const before = rig.hips.getWorldQuaternion(new THREE.Quaternion());
    retargetSkeleton(rig.hips, frontalPose(0.01), rest);
    const after = rig.hips.getWorldQuaternion(new THREE.Quaternion());
    expect(Math.abs(before.dot(after))).toBeGreaterThan(0.999);
  });

  it("applies the fixed local X-axis -90° head correction to a front-facing pose", () => {
    const rig = makeFrontFacingRig();
    const rest = captureRestPose(rig.hips);
    const p = frontalPose();

    retargetSkeleton(rig.hips, p, rest);
    const saved = rest.get(rig.head.name)!;
    const target = poseDirection([7, 8], [0], p);
    const estimatedWorld = new THREE.Quaternion()
      .setFromUnitVectors(saved.worldDirection, target)
      .multiply(saved.worldQuaternion)
      .normalize();
    const estimatedLocal = rig.neck
      .getWorldQuaternion(new THREE.Quaternion())
      .invert()
      .multiply(estimatedWorld);
    const expected = estimatedLocal.multiply(
      new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(1, 0, 0),
        -Math.PI / 2,
      ),
    );

    expect(HEAD_BIND_POSE_X_CORRECTION).toBe(-Math.PI / 2);
    expect(rig.head.quaternion.angleTo(expected)).toBeCloseTo(0, 5);
  });

  it("rebuilds the -90° head correction from rest across retarget, edit, and reset", () => {
    const rig = makeFrontFacingRig();
    const rest = captureRestPose(rig.hips);
    const p = frontalPose();

    retargetSkeleton(rig.hips, p, rest);
    const rebuiltHead = rig.head.quaternion.clone();

    retargetSkeleton(rig.hips, p, rest);
    expect(rig.head.quaternion.angleTo(rebuiltHead)).toBeCloseTo(0, 5);

    const manual = new THREE.Euler(0, Math.PI / 6, 0, "XYZ");
    const basePosition = rig.head.position.clone();
    applyJointCorrection(rig.head, basePosition, rebuiltHead, {
      rotation: manual,
      translation: new THREE.Vector3(),
    });
    const manuallyCorrected = rebuiltHead
      .clone()
      .multiply(new THREE.Quaternion().setFromEuler(manual));
    expect(rig.head.quaternion.angleTo(manuallyCorrected)).toBeCloseTo(0, 5);

    applyJointCorrection(rig.head, basePosition, rebuiltHead);
    expect(rig.head.quaternion.angleTo(rebuiltHead)).toBeCloseTo(0, 5);

    retargetSkeleton(rig.hips, p, rest);
    expect(rig.head.quaternion.angleTo(rebuiltHead)).toBeCloseTo(0, 5);
  });

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
    const p: PoseGuidance = structuredClone(pose);
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

  it("switches only the hips local facing by 180 degrees without accumulating", () => {
    const rig = makeFrontFacingRig();
    const rest = captureRestPose(rig.hips);
    const p = frontalPose();

    retargetSkeleton(rig.hips, p, rest, 1, "front");
    const frontHips = rig.hips.quaternion.clone();
    const frontSpine = rig.hips
      .getObjectByName("mixamorig:Spine")!
      .quaternion.clone();
    const frontSpine1 = rig.hips
      .getObjectByName("mixamorig:Spine1")!
      .quaternion.clone();
    const frontChest = rig.chest.quaternion.clone();

    retargetSkeleton(rig.hips, p, rest, 1, "back");
    const backHips = rig.hips.quaternion.clone();
    const angularDifference =
      2 *
      Math.acos(
        THREE.MathUtils.clamp(Math.abs(frontHips.dot(backHips)), -1, 1),
      );
    expect(angularDifference).toBeCloseTo(Math.PI, 5);
    expect(
      Math.abs(
        rig.hips.getObjectByName("mixamorig:Spine")!.quaternion.dot(frontSpine),
      ),
    ).toBeCloseTo(1, 5);
    expect(
      Math.abs(
        rig.hips
          .getObjectByName("mixamorig:Spine1")!
          .quaternion.dot(frontSpine1),
      ),
    ).toBeCloseTo(1, 5);
    expect(Math.abs(rig.chest.quaternion.dot(frontChest))).toBeCloseTo(1, 5);

    retargetSkeleton(rig.hips, p, rest, 1, "back");
    expect(Math.abs(rig.hips.quaternion.dot(backHips))).toBeCloseTo(1, 5);
  });

  it("distributes simultaneous hip yaw, torso lean, and shoulder roll through the real spine chain", () => {
    const hips = new THREE.Bone();
    hips.name = "mixamorig:Hips";
    const add = (parent: THREE.Bone, name: string) => {
      const bone = new THREE.Bone();
      bone.name = name;
      bone.position.y = 1;
      parent.add(bone);
      return bone;
    };
    const spine = add(hips, "mixamorig:Spine");
    const spine1 = add(spine, "mixamorig:Spine1");
    const spine2 = add(spine1, "mixamorig:Spine2");
    add(spine2, "mixamorig:Neck");
    hips.updateWorldMatrix(true, true);
    const rest = captureRestPose(hips);
    expect(rest.has("mixamorig:Spine1")).toBe(true);

    const p = structuredClone(pose);
    const put = (index: number, value: THREE.Vector3) => {
      p.worldLandmarks[index] = {
        x: value.x,
        y: -value.y,
        z: -value.z,
        visibility: 1,
      };
    };
    const hipCenter = new THREE.Vector3(0, 0, 0);
    const shoulderCenter = new THREE.Vector3(0.45, 2, 0.35);
    const hipRight = new THREE.Vector3(0.8, 0, -0.6);
    const shoulderRight = new THREE.Vector3(0.75, 0.45, -0.3).normalize();
    const headCenter = shoulderCenter
      .clone()
      .add(new THREE.Vector3(0.2, 1, 0.4));
    put(23, hipCenter.clone().addScaledVector(hipRight, -0.5));
    put(24, hipCenter.clone().addScaledVector(hipRight, 0.5));
    put(11, shoulderCenter.clone().addScaledVector(shoulderRight, -0.7));
    put(12, shoulderCenter.clone().addScaledVector(shoulderRight, 0.7));
    put(7, headCenter.clone().addScaledVector(shoulderRight, -0.15));
    put(8, headCenter.clone().addScaledVector(shoulderRight, 0.15));

    const frame = (upValue: THREE.Vector3, rightValue: THREE.Vector3) => {
      const up = upValue.clone().normalize();
      const right = rightValue
        .clone()
        .addScaledVector(up, -rightValue.dot(up))
        .normalize();
      const front = right.clone().cross(up).normalize();
      return new THREE.Quaternion().setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(right, front.clone().cross(right), front),
      );
    };
    const rootFrame = frame(
      shoulderCenter.clone().sub(hipCenter),
      hipRight.clone().normalize().add(shoulderRight),
    );
    const chestFrame = frame(
      headCenter.clone().sub(shoulderCenter),
      shoulderRight,
    );
    const expectedWorld = [0, 1 / 3, 2 / 3, 1].map((weight) =>
      rootFrame.clone().slerp(chestFrame, weight).normalize(),
    );

    retargetSkeleton(hips, p, rest);
    const bones = [hips, spine, spine1, spine2];
    for (let i = 0; i < bones.length; i++) {
      const actualWorld = bones[i].getWorldQuaternion(new THREE.Quaternion());
      const actualDirection = new THREE.Vector3(0, 1, 0).applyQuaternion(
        actualWorld,
      );
      const expectedDirection = new THREE.Vector3(0, 1, 0).applyQuaternion(
        expectedWorld[i],
      );
      expect(actualDirection.dot(expectedDirection)).toBeCloseTo(1, 5);

      const parentWorld =
        i === 0 ? new THREE.Quaternion() : expectedWorld[i - 1];
      const expectedLocal = parentWorld
        .clone()
        .invert()
        .multiply(expectedWorld[i]);
      expect(Math.abs(bones[i].quaternion.dot(expectedLocal))).toBeCloseTo(
        1,
        5,
      );
    }
  });
});

describe("dedicated hand retargeting", () => {
  const makeHand = (side: "Left" | "Right") => {
    const forearm = new THREE.Bone();
    forearm.name = `mixamorig:${side}ForeArm`;
    const hand = new THREE.Bone();
    hand.name = `mixamorig:${side}Hand`;
    hand.position.x = 1;
    forearm.add(hand);
    for (const finger of ["Thumb", "Index", "Middle", "Ring", "Pinky"]) {
      let parent = hand;
      for (let i = 1; i <= 4; i++) {
        const bone = new THREE.Bone();
        bone.name = `mixamorig:${side}Hand${finger}${i}`;
        bone.position.x = 0.2;
        parent.add(bone);
        parent = bone;
      }
    }
    forearm.updateWorldMatrix(true, true);
    return { root: forearm, hand };
  };
  const detectedHand = (
    side: "left" | "right",
    confidence = 0.95,
  ): HandPose => {
    const landmarks = Array.from({ length: 21 }, (_, i) => ({
      x: i * 0.01,
      y: 0,
      z: 0,
      visibility: confidence,
      confidence,
    }));
    landmarks[0] = { ...landmarks[0], x: 0, y: 0 };
    landmarks[9] = { ...landmarks[9], x: 0, y: -1 };
    landmarks[5] = { ...landmarks[5], x: 0, y: 0 };
    landmarks[6] = { ...landmarks[6], x: 1, y: 0 };
    landmarks[7] = { ...landmarks[7], x: 1, y: -1 };
    landmarks[8] = { ...landmarks[8], x: 2, y: -1 };
    return {
      landmarks,
      worldLandmarks: structuredClone(landmarks),
      handedness: side,
      confidence,
    };
  };

  it("uses dedicated palm and finger directions", () => {
    const { root, hand } = makeHand("Left");
    const rest = captureRestPose(root);
    const p: PoseGuidance = structuredClone(pose);
    p.hands = { left: detectedHand("left") };
    retargetSkeleton(root, p, rest);
    const palmDirection = hand.children[0]
      .getWorldPosition(new THREE.Vector3())
      .sub(hand.getWorldPosition(new THREE.Vector3()))
      .normalize();
    expect(palmDirection.y).toBeGreaterThan(0.99);
    const index1 = root.getObjectByName("mixamorig:LeftHandIndex1")!;
    const index2 = root.getObjectByName("mixamorig:LeftHandIndex2")!;
    expect(
      index2
        .getWorldPosition(new THREE.Vector3())
        .sub(index1.getWorldPosition(new THREE.Vector3()))
        .normalize().x,
    ).toBeGreaterThan(0.99);
  });

  it("associates geometrically nearest left and right wrists despite result order", () => {
    const posePoints = structuredClone(points);
    posePoints[15] = { x: 0.2, y: 0.5, z: 0, visibility: 1 };
    posePoints[16] = { x: 0.8, y: 0.5, z: 0, visibility: 1 };
    const raw = (x: number, label: "Left" | "Right") => ({
      landmarks: Array.from({ length: 21 }, (_, i) => ({
        x: x + i * 0.003,
        y: 0.5,
        z: 0,
        visibility: 1,
      })),
      worldLandmarks: Array.from({ length: 21 }, (_, i) => ({
        x: i * 0.01,
        y: 0,
        z: 0,
        visibility: 1,
      })),
      handedness: [
        { score: 0.98, categoryName: label, index: 0, displayName: label },
      ],
    });
    const matched = associateHands(
      [raw(0.8, "Left"), raw(0.2, "Right")],
      posePoints,
      false,
    );
    expect(matched.left?.landmarks[0].x).toBeCloseTo(0.2);
    expect(matched.right?.landmarks[0].x).toBeCloseTo(0.8);

    posePoints[15].x = 0.4;
    posePoints[16].x = 0.6;
    const overlapping = associateHands(
      [raw(0.49, "Left"), raw(0.29, "Right")],
      posePoints,
      false,
    );
    expect(overlapping.left?.landmarks[0].x).toBeCloseTo(0.29);
    expect(overlapping.right?.landmarks[0].x).toBeCloseTo(0.49);
  });

  it("keeps fingers at rest and falls back to pose palm rotation at low confidence", () => {
    const { root, hand } = makeHand("Right");
    const rest = captureRestPose(root);
    const p: PoseGuidance = structuredClone(pose);
    p.worldLandmarks[16] = { x: 0, y: 0, z: 0, visibility: 1 };
    p.worldLandmarks[18] = p.worldLandmarks[20] = {
      x: 0,
      y: -1,
      z: 0,
      visibility: 1,
    };
    p.hands = { right: detectedHand("right", 0.4) };
    retargetSkeleton(root, p, rest);
    expect(
      Math.abs(hand.quaternion.dot(rest.get(hand.name)!.localQuaternion)),
    ).toBeLessThan(0.99);
    const finger = root.getObjectByName("mixamorig:RightHandIndex1")!;
    expect(
      Math.abs(finger.quaternion.dot(rest.get(finger.name)!.localQuaternion)),
    ).toBeCloseTo(1);
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

  it("filters NaN correspondences and rejects a degenerate projection", () => {
    const size = { width: 100, height: 100 };
    const fit = fitFrontProjection(
      [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        { x: NaN, y: 2 },
      ],
      [
        { x: 0.2, y: 0.8 },
        { x: 0.8, y: 0.2 },
        { x: 0.5, y: 0.5 },
      ],
      size,
      size,
    );
    expect(fit.distance).toBeGreaterThan(0);
    expect(() =>
      fitFrontProjection(
        [
          { x: 1, y: 1 },
          { x: 1, y: 1 },
        ],
        [
          { x: 0.2, y: 0.2 },
          { x: 0.8, y: 0.8 },
        ],
        size,
        size,
      ),
    ).toThrow("分散が不足");
  });

  it("does not move the root for a non-finite pelvis landmark", () => {
    const root = new THREE.Group();
    const hips = new THREE.Bone();
    root.add(hips);
    root.position.set(1, 2, 3);
    const invalid = structuredClone(points);
    invalid[23].x = NaN;
    expect(
      alignRootToImagePelvis(
        root,
        hips,
        invalid,
        { width: 100, height: 100 },
        { width: 100, height: 100 },
        new THREE.PerspectiveCamera(),
      ),
    ).toBe(false);
    expect(root.position.toArray()).toEqual([1, 2, 3]);
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
