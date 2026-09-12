import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  MIN_HAND_CONFIDENCE,
  type HandPose,
  type HandSide,
  type PoseGuidance,
  type RigSurfaceBuffer,
} from "./pose";
import {
  getContainRect,
  mapLandmarkToContain,
  type Point,
  type Size,
} from "./pose-overlay";

export type JointId =
  | "hips"
  | "spine"
  | "spine1"
  | "chest"
  | "neck"
  | "head"
  | "leftShoulder"
  | "leftUpperArm"
  | "leftLowerArm"
  | "leftHand"
  | "rightShoulder"
  | "rightUpperArm"
  | "rightLowerArm"
  | "rightHand"
  | "leftUpperLeg"
  | "leftLowerLeg"
  | "leftFoot"
  | "rightUpperLeg"
  | "rightLowerLeg"
  | "rightFoot";
type Rule = {
  id: JointId;
  bone: string;
  from: number[];
  to: number[];
  child?: string;
};
export type RetargetReport = {
  appliedBones: number;
  missingBones: string[];
  skippedBones: string[];
};

/** GLTFLoader sanitizes ':' from node names; restore the authored Mixamo names. */
export function restoreMixamoBoneNames(model: THREE.Object3D) {
  model.traverse((node) => {
    if ((node as THREE.Bone).isBone && /^mixamorig(?!:)/.test(node.name))
      node.name = node.name.replace(/^mixamorig/, "mixamorig:");
  });
}
export type RestBone = {
  localPosition: THREE.Vector3;
  localQuaternion: THREE.Quaternion;
  worldQuaternion: THREE.Quaternion;
  start: THREE.Vector3;
  end: THREE.Vector3;
  worldDirection: THREE.Vector3;
};
export type BodyProportions = {
  height: number;
  width: number;
  armLength: number;
  legLength: number;
};
export type HipFacing = "front" | "back";
export type JointCorrection = {
  rotation: THREE.Euler;
  /** Translation in the bone's local (parent) coordinate system. */
  translation: THREE.Vector3;
};
export type ProportionReport = {
  missingBones: string[];
  appliedSegments: number;
};

export const DEFAULT_PROPORTIONS: Readonly<BodyProportions> = {
  height: 1,
  width: 1,
  armLength: 1,
  legLength: 1,
};

const ARM_SEGMENT_ENDS = [
  "mixamorig:LeftArm",
  "mixamorig:LeftForeArm",
  "mixamorig:LeftHand",
  "mixamorig:RightArm",
  "mixamorig:RightForeArm",
  "mixamorig:RightHand",
] as const;
const LEG_SEGMENT_ENDS = [
  "mixamorig:LeftUpLeg",
  "mixamorig:LeftLeg",
  "mixamorig:LeftFoot",
  "mixamorig:RightUpLeg",
  "mixamorig:RightLeg",
  "mixamorig:RightFoot",
] as const;

/** Rebuilds every local offset from the immutable rest pose (never cumulatively). */
export function applyBodyProportions(
  model: THREE.Object3D,
  rest: Map<string, RestBone>,
  value: BodyProportions,
  baseScale = 1,
): ProportionReport {
  const report: ProportionReport = { missingBones: [], appliedSegments: 0 };
  model.scale.set(baseScale * value.width, baseScale * value.height, baseScale);
  for (const [name, saved] of rest) {
    const bone = model.getObjectByName(name);
    if (bone) bone.position.copy(saved.localPosition);
  }
  for (const [names, scale] of [
    [ARM_SEGMENT_ENDS, value.armLength],
    [LEG_SEGMENT_ENDS, value.legLength],
  ] as const) {
    for (const name of names) {
      const bone = model.getObjectByName(name);
      const saved = rest.get(name);
      if (!bone || !saved) report.missingBones.push(name);
      else {
        bone.position.copy(saved.localPosition).multiplyScalar(scale);
        report.appliedSegments++;
      }
    }
  }
  model.updateWorldMatrix(true, true);
  return report;
}

export function clampJointCorrection(id: JointId, correction: JointCorrection) {
  const translationLimit = id === "hips" ? 0.75 : 0.15;
  const clamp = (v: number, limit: number) =>
    THREE.MathUtils.clamp(v, -limit, limit);
  return {
    rotation: new THREE.Euler(
      clamp(correction.rotation.x, Math.PI / 2),
      clamp(correction.rotation.y, Math.PI / 2),
      clamp(correction.rotation.z, Math.PI / 2),
      "XYZ",
    ),
    translation: new THREE.Vector3(
      clamp(correction.translation.x, translationLimit),
      clamp(correction.translation.y, translationLimit),
      clamp(correction.translation.z, translationLimit),
    ),
  } satisfies JointCorrection;
}

/** Applies one correction from a supplied base transform, making reset exact. */
export function applyJointCorrection(
  bone: THREE.Object3D,
  basePosition: THREE.Vector3,
  baseQuaternion: THREE.Quaternion,
  correction?: JointCorrection,
) {
  bone.position.copy(basePosition);
  bone.quaternion.copy(baseQuaternion);
  if (correction) {
    bone.position.add(correction.translation);
    bone.quaternion.multiply(
      new THREE.Quaternion().setFromEuler(correction.rotation),
    );
  }
  bone.updateWorldMatrix(true, true);
}
export const JOINT_LABELS: Record<JointId, string> = {
  hips: "腰",
  spine: "背骨",
  spine1: "背骨（中央）",
  chest: "胸",
  neck: "首",
  head: "頭",
  leftShoulder: "左肩",
  leftUpperArm: "左上腕",
  leftLowerArm: "左前腕",
  leftHand: "左手",
  rightShoulder: "右肩",
  rightUpperArm: "右上腕",
  rightLowerArm: "右前腕",
  rightHand: "右手",
  leftUpperLeg: "左大腿",
  leftLowerLeg: "左すね",
  leftFoot: "左足",
  rightUpperLeg: "右大腿",
  rightLowerLeg: "右すね",
  rightFoot: "右足",
};
// This is deliberately a parent-before-child traversal.  The retargeter relies
// on every parent's world quaternion having been finalised before its child.
export const RULES: readonly Rule[] = [
  {
    id: "hips",
    bone: "mixamorig:Hips",
    from: [23, 24],
    to: [11, 12],
    child: "mixamorig:Spine",
  },
  {
    id: "spine",
    bone: "mixamorig:Spine",
    from: [23, 24],
    to: [11, 12],
    child: "mixamorig:Spine1",
  },
  {
    id: "spine1",
    bone: "mixamorig:Spine1",
    from: [23, 24],
    to: [11, 12],
    child: "mixamorig:Spine2",
  },
  {
    id: "chest",
    bone: "mixamorig:Spine2",
    from: [23, 24],
    to: [11, 12],
    child: "mixamorig:Neck",
  },
  {
    id: "neck",
    bone: "mixamorig:Neck",
    from: [11, 12],
    to: [7, 8],
    child: "mixamorig:Head",
  },
  { id: "head", bone: "mixamorig:Head", from: [7, 8], to: [0] },
  {
    id: "leftShoulder",
    bone: "mixamorig:LeftShoulder",
    from: [11, 12],
    to: [11],
    child: "mixamorig:LeftArm",
  },
  {
    id: "leftUpperArm",
    bone: "mixamorig:LeftArm",
    from: [11],
    to: [13],
    child: "mixamorig:LeftForeArm",
  },
  {
    id: "leftLowerArm",
    bone: "mixamorig:LeftForeArm",
    from: [13],
    to: [15],
    child: "mixamorig:LeftHand",
  },
  { id: "leftHand", bone: "mixamorig:LeftHand", from: [15], to: [17, 19] },
  {
    id: "rightShoulder",
    bone: "mixamorig:RightShoulder",
    from: [11, 12],
    to: [12],
    child: "mixamorig:RightArm",
  },
  {
    id: "rightUpperArm",
    bone: "mixamorig:RightArm",
    from: [12],
    to: [14],
    child: "mixamorig:RightForeArm",
  },
  {
    id: "rightLowerArm",
    bone: "mixamorig:RightForeArm",
    from: [14],
    to: [16],
    child: "mixamorig:RightHand",
  },
  { id: "rightHand", bone: "mixamorig:RightHand", from: [16], to: [18, 20] },
  {
    id: "leftUpperLeg",
    bone: "mixamorig:LeftUpLeg",
    from: [23],
    to: [25],
    child: "mixamorig:LeftLeg",
  },
  {
    id: "leftLowerLeg",
    bone: "mixamorig:LeftLeg",
    from: [25],
    to: [27],
    child: "mixamorig:LeftFoot",
  },
  { id: "leftFoot", bone: "mixamorig:LeftFoot", from: [27], to: [31] },
  {
    id: "rightUpperLeg",
    bone: "mixamorig:RightUpLeg",
    from: [24],
    to: [26],
    child: "mixamorig:RightLeg",
  },
  {
    id: "rightLowerLeg",
    bone: "mixamorig:RightLeg",
    from: [26],
    to: [28],
    child: "mixamorig:RightFoot",
  },
  { id: "rightFoot", bone: "mixamorig:RightFoot", from: [28], to: [32] },
];

/** STEP 1 requires every body rule to have been applied successfully. */
export function isCompleteBodyRetarget(report: RetargetReport) {
  return (
    report.appliedBones >= RULES.length &&
    RULES.every(
      ({ bone }) =>
        !report.missingBones.includes(bone) &&
        !report.skippedBones.includes(bone),
    )
  );
}

type FingerRule = {
  side: HandSide;
  bone: string;
  from: number;
  to: number;
  /** Share the last measured distal bend with an otherwise unobserved tip bone. */
  distalBlend?: number;
};

const FINGER_LANDMARKS = {
  Thumb: [1, 2, 3, 4],
  Index: [5, 6, 7, 8],
  Middle: [9, 10, 11, 12],
  Ring: [13, 14, 15, 16],
  Pinky: [17, 18, 19, 20],
} as const;

/** Mixamo's four phalange bones mapped onto MediaPipe's observed segments. */
export const HAND_BONE_RULES: readonly FingerRule[] = (
  ["Left", "Right"] as const
).flatMap((mixamoSide) =>
  Object.entries(FINGER_LANDMARKS).flatMap(([finger, points]) => {
    const side = mixamoSide.toLowerCase() as HandSide;
    return [1, 2, 3, 4].map(
      (number): FingerRule => ({
        side,
        bone: `mixamorig:${mixamoSide}Hand${finger}${number}`,
        from: points[Math.min(number - 1, 2)],
        to: points[Math.min(number, 3)],
        // Bone 3 and the extra terminal bone share the final observed flexion.
        distalBlend: number === 3 ? 0.7 : number === 4 ? 1 : undefined,
      }),
    );
  }),
);
export const EDITABLE_JOINTS = RULES.map((r) => r.id);

const MIN_VISIBILITY = 0.45;
const EPSILON = 1e-6;

export type FrontAlignment = {
  target: Point;
  pixelsPerWorldUnit: number;
  distance: number;
  normalizedRmsError: number;
};

/** Least-squares front-view fit (translation + uniform camera zoom). */
export function fitFrontProjection(
  modelPoints: Point[],
  imagePoints: Point[],
  imageSize: Size,
  viewport: Size,
  verticalFovDegrees = 36,
): FrontAlignment {
  if (modelPoints.length !== imagePoints.length)
    throw new Error("正面位置合わせの対応点数が一致しません");
  if (
    ![
      imageSize.width,
      imageSize.height,
      viewport.width,
      viewport.height,
      verticalFovDegrees,
    ].every((v) => Number.isFinite(v) && v > 0)
  )
    throw new Error("画像または表示領域のサイズが不正です");
  const pairs = modelPoints
    .map((model, i) => ({ model, image: imagePoints[i] }))
    .filter(({ model, image }) =>
      [model.x, model.y, image.x, image.y].every(Number.isFinite),
    );
  if (pairs.length < 2)
    throw new Error("正面位置合わせには2点以上の対応点が必要です");
  const rect = getContainRect(imageSize, viewport);
  const validModels = pairs.map(({ model }) => model);
  const pixels = pairs.map(({ image }) => mapLandmarkToContain(image, rect));
  const mean = (values: Point[]) =>
    values.reduce((sum, p) => ({ x: sum.x + p.x, y: sum.y + p.y }), {
      x: 0,
      y: 0,
    });
  const mc = mean(validModels),
    pc = mean(pixels),
    n = validModels.length;
  mc.x /= n;
  mc.y /= n;
  pc.x /= n;
  pc.y /= n;
  let numerator = 0,
    denominator = 0;
  for (let i = 0; i < n; i++) {
    const mx = validModels[i].x - mc.x,
      my = validModels[i].y - mc.y;
    numerator += mx * (pixels[i].x - pc.x) + my * (pc.y - pixels[i].y);
    denominator += mx * mx + my * my;
  }
  if (!Number.isFinite(denominator) || denominator <= EPSILON)
    throw new Error("対応点の分散が不足しているため正面位置合わせできません");
  const scale = numerator / denominator;
  if (!Number.isFinite(scale) || scale <= EPSILON)
    throw new Error("正面位置合わせの縮尺を算出できません");
  const target = {
    x: mc.x - (pc.x - viewport.width / 2) / scale,
    y: mc.y + (pc.y - viewport.height / 2) / scale,
  };
  let squaredError = 0;
  for (let i = 0; i < n; i++) {
    const x = viewport.width / 2 + (validModels[i].x - target.x) * scale;
    const y = viewport.height / 2 - (validModels[i].y - target.y) * scale;
    squaredError += (x - pixels[i].x) ** 2 + (y - pixels[i].y) ** 2;
  }
  const result = {
    target,
    pixelsPerWorldUnit: scale,
    distance:
      viewport.height /
      (2 * scale * Math.tan(THREE.MathUtils.degToRad(verticalFovDegrees / 2))),
    normalizedRmsError:
      Math.sqrt(squaredError / n) / Math.hypot(rect.width, rect.height),
  };
  if (
    ![
      result.target.x,
      result.target.y,
      result.pixelsPerWorldUnit,
      result.distance,
      result.normalizedRmsError,
    ].every(Number.isFinite)
  )
    throw new Error("正面位置合わせの計算結果が不正です");
  return result;
}

/**
 * Moves the GLB root so that its hips project onto the image pelvis anchor.
 *
 * The translation is solved at the hips' existing clip-space depth.  Applying
 * it to the model root (rather than the hips bone) preserves the complete skin
 * hierarchy.  Converting both the old and desired root world positions through
 * the inverse parent matrix also makes this correct below rotated/scaled
 * parents.
 */
export function alignRootToImagePelvis(
  modelRoot: THREE.Object3D,
  hips: THREE.Object3D,
  landmarks: PoseGuidance["landmarks"],
  imageSize: Size,
  viewport: Size,
  camera: THREE.Camera,
) {
  const finite = (...values: number[]) => values.every(Number.isFinite);
  if (
    !landmarks[23] ||
    !landmarks[24] ||
    !finite(
      landmarks[23].x,
      landmarks[23].y,
      landmarks[24].x,
      landmarks[24].y,
      imageSize.width,
      imageSize.height,
      viewport.width,
      viewport.height,
    ) ||
    imageSize.width <= 0 ||
    imageSize.height <= 0 ||
    viewport.width <= 0 ||
    viewport.height <= 0
  )
    return false;
  const pelvis = {
    x: (landmarks[23].x + landmarks[24].x) / 2,
    y: (landmarks[23].y + landmarks[24].y) / 2,
  };
  const pixel = mapLandmarkToContain(
    pelvis,
    getContainRect(imageSize, viewport),
  );

  modelRoot.parent?.updateWorldMatrix(true, false);
  modelRoot.updateWorldMatrix(true, true);
  camera.updateWorldMatrix(true, false);
  const hipsWorld = hips.getWorldPosition(new THREE.Vector3());
  const clip = hipsWorld.clone().project(camera);
  const desiredHipsWorld = new THREE.Vector3(
    (pixel.x / viewport.width) * 2 - 1,
    1 - (pixel.y / viewport.height) * 2,
    clip.z,
  ).unproject(camera);
  if (![hipsWorld, clip, desiredHipsWorld].every((v) => finite(v.x, v.y, v.z)))
    return false;
  const desiredRootWorld = modelRoot
    .getWorldPosition(new THREE.Vector3())
    .add(desiredHipsWorld.sub(hipsWorld));
  if (modelRoot.parent) {
    const parentMatrix = modelRoot.parent.matrixWorld;
    if (
      ![...parentMatrix.elements].every(Number.isFinite) ||
      Math.abs(parentMatrix.determinant()) <= EPSILON
    )
      return false;
    desiredRootWorld.applyMatrix4(parentMatrix.clone().invert());
  }
  if (!finite(desiredRootWorld.x, desiredRootWorld.y, desiredRootWorld.z))
    return false;
  modelRoot.position.copy(desiredRootWorld);
  modelRoot.updateWorldMatrix(true, true);
  return true;
}

/** The only MediaPipe -> Three/GLB coordinate-system boundary. */
export function landmarkToModel(
  landmark: { x: number; y: number; z: number },
  depthScale = 1,
) {
  // MediaPipe image Y is down and its camera looks toward -Z.  The GLB is
  // authored X-right, Y-up, Z-front, so both Y and Z are inverted here.
  return new THREE.Vector3(landmark.x, -landmark.y, -landmark.z * depthScale);
}

function usable(indices: number[], pose: PoseGuidance) {
  return indices.every((i) => {
    const p = pose.worldLandmarks[i];
    return (
      p &&
      Number.isFinite(p.x + p.y + p.z) &&
      (p.visibility ?? 1) >= MIN_VISIBILITY
    );
  });
}

function average(indices: number[], pose: PoseGuidance, depthScale: number) {
  const v = new THREE.Vector3();
  for (const i of indices) {
    const p = pose.worldLandmarks[i];
    v.add(landmarkToModel(p, depthScale));
  }
  return v.multiplyScalar(1 / indices.length);
}
export function poseDirection(
  from: number[],
  to: number[],
  pose: PoseGuidance,
  depthScale = 1,
) {
  const direction = average(to, pose, depthScale).sub(
    average(from, pose, depthScale),
  );
  return direction.lengthSq() > EPSILON ? direction.normalize() : direction;
}

export function captureRestPose(model: THREE.Object3D) {
  const result = new Map<string, RestBone>();
  model.updateWorldMatrix(true, true);
  for (const rule of RULES) {
    const bone = model.getObjectByName(rule.bone);
    if (!bone) continue;
    const child = rule.child
      ? model.getObjectByName(rule.child)
      : bone.children.find((node) => (node as THREE.Bone).isBone);
    const start = bone.getWorldPosition(new THREE.Vector3());
    const end = child?.getWorldPosition(new THREE.Vector3()) ?? start.clone();
    result.set(rule.bone, {
      localPosition: bone.position.clone(),
      localQuaternion: bone.quaternion.clone(),
      worldQuaternion: bone.getWorldQuaternion(new THREE.Quaternion()),
      start,
      end,
      worldDirection: end.clone().sub(start).normalize(),
    });
  }
  for (const rule of HAND_BONE_RULES) {
    const bone = model.getObjectByName(rule.bone);
    if (!bone) continue;
    const child = bone.children.find((node) => (node as THREE.Bone).isBone);
    const start = bone.getWorldPosition(new THREE.Vector3());
    let end = child?.getWorldPosition(new THREE.Vector3()) ?? start.clone();
    if (!child) {
      const parentDirection =
        bone.parent && result.get(bone.parent.name)?.worldDirection;
      if (parentDirection) end = start.clone().add(parentDirection);
    }
    result.set(rule.bone, {
      localPosition: bone.position.clone(),
      localQuaternion: bone.quaternion.clone(),
      worldQuaternion: bone.getWorldQuaternion(new THREE.Quaternion()),
      start,
      end,
      worldDirection: end.clone().sub(start).normalize(),
    });
  }
  return result;
}

function handDirection(
  hand: HandPose,
  from: number,
  to: number,
  depthScale: number,
) {
  const a = hand.worldLandmarks[from];
  const b = hand.worldLandmarks[to];
  if (
    !a ||
    !b ||
    (a.visibility ?? 0) < MIN_HAND_CONFIDENCE ||
    (b.visibility ?? 0) < MIN_HAND_CONFIDENCE
  )
    return undefined;
  const direction = landmarkToModel(b, depthScale).sub(
    landmarkToModel(a, depthScale),
  );
  return direction.lengthSq() > EPSILON ? direction.normalize() : undefined;
}

function usableHand(hand: HandPose | undefined): hand is HandPose {
  return Boolean(
    hand &&
      hand.confidence >= MIN_HAND_CONFIDENCE &&
      hand.worldLandmarks.length === 21 &&
      hand.worldLandmarks.every(
        (point) =>
          Number.isFinite(point.x + point.y + point.z) &&
          (point.visibility ?? hand.confidence) >= MIN_HAND_CONFIDENCE &&
          point.confidence >= MIN_HAND_CONFIDENCE,
      ),
  );
}

function applyWorldDirection(
  bone: THREE.Object3D,
  saved: RestBone,
  target: THREE.Vector3,
) {
  const desiredWorld = new THREE.Quaternion()
    .setFromUnitVectors(saved.worldDirection, target)
    .multiply(saved.worldQuaternion)
    .normalize();
  const parentWorld =
    bone.parent?.getWorldQuaternion(new THREE.Quaternion()) ??
    new THREE.Quaternion();
  bone.quaternion.copy(parentWorld.invert().multiply(desiredWorld)).normalize();
}

function frameFromUpAndRight(
  upValue: THREE.Vector3,
  rightValue: THREE.Vector3,
  referenceFront?: THREE.Vector3,
) {
  const up = upValue.clone().normalize();
  const right = rightValue
    .clone()
    .addScaledVector(up, -rightValue.dot(up))
    .normalize();
  if (up.lengthSq() <= EPSILON || right.lengthSq() <= EPSILON) return undefined;
  let front = right.clone().cross(up).normalize();
  if (front.lengthSq() <= EPSILON) return undefined;
  // A pair of lateral landmarks defines an axis, but noisy depth can select
  // the frame on the other side of that axis.  Bind-pose front disambiguates
  // that sign.  Flipping both transverse axes retains `up` and is exactly the
  // unwanted 180-degree twist around it (rather than a mirror operation).
  if (
    referenceFront &&
    referenceFront.lengthSq() > EPSILON &&
    front.dot(referenceFront) < 0
  ) {
    right.negate();
    front.negate();
  }
  return new THREE.Quaternion()
    .setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(right, front.clone().cross(right), front),
    )
    .normalize();
}

function torsoFrames(
  pose: PoseGuidance,
  depthScale: number,
  referenceFront: THREE.Vector3,
) {
  if (!usable([11, 12, 23, 24], pose)) return undefined;
  const hips = average([23, 24], pose, depthScale);
  const shoulders = average([11, 12], pose, depthScale);
  const hipRight = average([24], pose, depthScale).sub(
    average([23], pose, depthScale),
  );
  const shoulderRight = average([12], pose, depthScale).sub(
    average([11], pose, depthScale),
  );
  const torsoUp = shoulders.clone().sub(hips);
  // Both lateral observations contribute to the pelvis frame: using only the
  // shoulders makes a hip yaw look like spine twist.
  const root = frameFromUpAndRight(
    torsoUp,
    hipRight.clone().normalize().add(shoulderRight.clone().normalize()),
    referenceFront,
  );
  if (!root) return undefined;

  let chestUp = torsoUp;
  if (usable([7, 8], pose))
    chestUp = average([7, 8], pose, depthScale).sub(shoulders);
  else if (usable([0], pose))
    chestUp = average([0], pose, depthScale).sub(shoulders);
  const chest =
    frameFromUpAndRight(chestUp, shoulderRight, referenceFront) ?? root.clone();
  return { root, chest };
}

function restFrame(saved: RestBone) {
  const restRight = new THREE.Vector3(1, 0, 0).applyQuaternion(
    saved.worldQuaternion,
  );
  return frameFromUpAndRight(saved.worldDirection, restRight);
}

/** Retargets from immutable rest data and is intentionally usable in unit tests. */
export function retargetSkeleton(
  model: THREE.Object3D,
  pose: PoseGuidance,
  rest: Map<string, RestBone>,
  depthScale = 1,
  hipFacing: HipFacing = "front",
): RetargetReport {
  const report: RetargetReport = {
    appliedBones: 0,
    missingBones: [],
    skippedBones: [],
  };
  const hipsRest = rest.get("mixamorig:Hips");
  const hipsRestFrame = hipsRest && restFrame(hipsRest);
  // The authored bind pose is the only reliable definition of model front.
  // Use it before constructing any torso targets so every descendant observes
  // the same, already-disambiguated pelvis/chest world frames.
  const referenceFront = hipsRestFrame
    ? new THREE.Vector3(0, 0, 1).applyQuaternion(hipsRestFrame).normalize()
    : new THREE.Vector3(0, 0, 1);
  const bodyFrames = torsoFrames(pose, depthScale, referenceFront);
  const torsoWeights: Partial<Record<JointId, number>> = {
    hips: 0,
    spine: 1 / 3,
    spine1: 2 / 3,
    chest: 1,
  };
  const torsoTargets = new Map<JointId, THREE.Quaternion>();
  if (bodyFrames) {
    for (const [id, weight] of Object.entries(torsoWeights) as [
      JointId,
      number,
    ][])
      torsoTargets.set(
        id,
        bodyFrames.root.clone().slerp(bodyFrames.chest, weight).normalize(),
      );
  }

  // Always reset the whole chain first: repeated calls must never accumulate.
  for (const rule of RULES) {
    const bone = model.getObjectByName(rule.bone);
    const saved = rest.get(rule.bone);
    if (bone && saved) {
      bone.quaternion.copy(saved.localQuaternion);
      bone.position.copy(saved.localPosition);
    }
  }
  for (const rule of HAND_BONE_RULES) {
    const bone = model.getObjectByName(rule.bone);
    const saved = rest.get(rule.bone);
    if (bone && saved) {
      bone.quaternion.copy(saved.localQuaternion);
      bone.position.copy(saved.localPosition);
    }
  }
  model.updateWorldMatrix(true, true);

  for (const rule of RULES) {
    const bone = model.getObjectByName(rule.bone);
    const saved = rest.get(rule.bone);
    if (!bone || !saved) {
      report.missingBones.push(rule.bone);
      continue;
    }
    let desiredWorld: THREE.Quaternion | undefined;
    const targetFrame = torsoTargets.get(rule.id);
    if (targetFrame) {
      // Interpolated *world* frames distribute bend/twist along the chain;
      // applying one torso quaternion to every local bone would compound it.
      const sourceFrame = restFrame(saved);
      if (sourceFrame) {
        const restCorrection = sourceFrame
          .clone()
          .invert()
          .multiply(saved.worldQuaternion);
        desiredWorld = targetFrame.multiply(restCorrection).normalize();
      }
    } else if (
      (rule.id === "leftHand" || rule.id === "rightHand") &&
      usableHand(pose.hands?.[rule.id === "leftHand" ? "left" : "right"])
    ) {
      const hand = pose.hands![rule.id === "leftHand" ? "left" : "right"]!;
      const target = handDirection(hand, 0, 9, depthScale);
      if (target)
        desiredWorld = new THREE.Quaternion()
          .setFromUnitVectors(saved.worldDirection, target)
          .multiply(saved.worldQuaternion)
          .normalize();
      else if (usable([...rule.from, ...rule.to], pose)) {
        const fallback = poseDirection(rule.from, rule.to, pose, depthScale);
        if (
          fallback.lengthSq() > EPSILON &&
          saved.worldDirection.lengthSq() > EPSILON
        )
          desiredWorld = new THREE.Quaternion()
            .setFromUnitVectors(saved.worldDirection, fallback)
            .multiply(saved.worldQuaternion)
            .normalize();
      }
    } else if (usable([...rule.from, ...rule.to], pose)) {
      const target = poseDirection(rule.from, rule.to, pose, depthScale);
      if (
        target.lengthSq() > EPSILON &&
        saved.worldDirection.lengthSq() > EPSILON
      )
        desiredWorld = new THREE.Quaternion()
          .setFromUnitVectors(saved.worldDirection, target)
          .multiply(saved.worldQuaternion)
          .normalize();
    }
    if (!desiredWorld) {
      // Keeping the restored local rotation safely inherits the final parent.
      report.skippedBones.push(rule.bone);
      model.updateWorldMatrix(true, true);
      continue;
    }
    const parentWorld =
      bone.parent?.getWorldQuaternion(new THREE.Quaternion()) ??
      new THREE.Quaternion();
    // local = inverse(parent target world) * target world * rest correction.
    // `desiredWorld` already includes that correction.  Minimal-vector swing
    // above leaves the unobservable rest-pose twist intact.
    bone.quaternion
      .copy(parentWorld.invert().multiply(desiredWorld))
      .normalize();
    model.updateWorldMatrix(true, true);
    report.appliedBones++;
  }
  // Finger observations are applied parent-first after the palm. Missing,
  // mismatched, occluded, and low-confidence hands remain at immutable rest.
  for (const rule of HAND_BONE_RULES) {
    const bone = model.getObjectByName(rule.bone);
    const saved = rest.get(rule.bone);
    if (!bone || !saved) {
      report.missingBones.push(rule.bone);
      continue;
    }
    const hand = pose.hands?.[rule.side];
    if (!usableHand(hand)) {
      report.skippedBones.push(rule.bone);
      continue;
    }
    let target = handDirection(hand, rule.from, rule.to, depthScale);
    if (target && rule.distalBlend === 0.7) {
      const previous = handDirection(
        hand,
        rule.from - 1,
        rule.from,
        depthScale,
      );
      if (previous)
        target = previous.lerp(target, rule.distalBlend).normalize();
    }
    if (!target || saved.worldDirection.lengthSq() <= EPSILON) {
      report.skippedBones.push(rule.bone);
      continue;
    }
    applyWorldDirection(bone, saved, target);
    model.updateWorldMatrix(true, true);
    report.appliedBones++;
  }
  // Apply the facing choice exactly once, at the top of the torso hierarchy.
  // At this point all local rotations were rebuilt from `rest`, so repeated
  // retargets cannot accumulate this half-turn. Every descendant inherits it
  // without receiving an additional local rotation of its own.
  if (hipFacing === "back") {
    const hips = model.getObjectByName("mixamorig:Hips");
    if (hips) {
      const spine = model.getObjectByName("mixamorig:Spine");
      const torsoUp = spine
        ? spine
            .getWorldPosition(new THREE.Vector3())
            .sub(hips.getWorldPosition(new THREE.Vector3()))
            .normalize()
        : new THREE.Vector3(0, 1, 0).applyQuaternion(
            hips.getWorldQuaternion(new THREE.Quaternion()),
          );
      const hipsWorld = hips.getWorldQuaternion(new THREE.Quaternion());
      const localTorsoUp = torsoUp
        .applyQuaternion(hipsWorld.invert())
        .normalize();
      hips.quaternion.multiply(
        new THREE.Quaternion().setFromAxisAngle(localTorsoUp, Math.PI),
      );
    }
  }
  model.updateWorldMatrix(true, true);
  return report;
}

export class BodyViewer {
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(36, 1, 0.01, 100);
  private renderer: THREE.WebGLRenderer;
  private controls: OrbitControls;
  private model?: THREE.Object3D;
  private pose?: PoseGuidance;
  private baseScale = 1;
  private raf = 0;
  private rest = new Map<string, RestBone>();
  private posed = new Map<string, THREE.Quaternion>();
  private correctionBasePositions = new Map<string, THREE.Vector3>();
  private corrections = new Map<JointId, JointCorrection>();
  private helper = new THREE.Group();
  private proportions: BodyProportions = { ...DEFAULT_PROPORTIONS };
  private selected: JointId = "hips";
  private depthScale = 1;
  private hipFacing: HipFacing = "front";
  private imageSize?: Size;
  constructor(
    private host: HTMLElement,
    private onSelect?: (id: JointId) => void,
    private onAngle?: (degrees: number) => void,
  ) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.domElement.classList.add("body-canvas");
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.append(this.renderer.domElement);
    this.camera.position.set(0, 0.05, 3.4);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(0, 0, 0);
    this.controls.addEventListener("change", this.reportAngle);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x24182f, 2.4));
    const light = new THREE.DirectionalLight(0xffffff, 3);
    light.position.set(2, 4, 3);
    this.scene.add(light, this.helper);
    this.renderer.domElement.addEventListener("pointerdown", this.pick);
    new ResizeObserver(() => this.resize()).observe(host);
    this.loop();
  }
  async showPose(
    pose: PoseGuidance,
    depthScale = 1,
    imageSize?: Size,
  ): Promise<RetargetReport> {
    await this.ensureModel();
    this.pose = pose;
    this.depthScale = depthScale;
    this.imageSize = imageSize;
    this.corrections.clear();
    this.fit();
    this.retarget();
    this.updateImageAlignment();
    return this.lastReport;
  }
  private lastReport: RetargetReport = {
    appliedBones: 0,
    missingBones: [],
    skippedBones: [],
  };
  private async ensureModel() {
    if (this.model) return;
    const gltf = await new GLTFLoader().loadAsync(
      `${import.meta.env.BASE_URL}runtime/body.glb`,
    );
    this.model = gltf.scene;
    restoreMixamoBoneNames(this.model);
    this.scene.add(this.model);
    this.rest = captureRestPose(this.model);
  }
  private retarget() {
    if (!this.model || !this.pose) return;
    this.lastReport = retargetSkeleton(
      this.model,
      this.pose,
      this.rest,
      this.depthScale,
      this.hipFacing,
    );
    for (const r of RULES) {
      const bone = this.model.getObjectByName(r.bone);
      if (bone) this.posed.set(r.bone, bone.quaternion.clone());
    }
    this.applyProportionsAndCorrections();
  }
  private updateImageAlignment() {
    // Camera fitting and root translation are deliberately separate operations.
    this.alignToImage();
    this.alignRootToPelvis();
  }
  private alignToImage() {
    if (!this.model || !this.pose || !this.imageSize) return;
    const pairs: Array<[number, string]> = [
      [11, "mixamorig:LeftArm"],
      [12, "mixamorig:RightArm"],
      [23, "mixamorig:LeftUpLeg"],
      [24, "mixamorig:RightUpLeg"],
      [25, "mixamorig:LeftLeg"],
      [26, "mixamorig:RightLeg"],
      [27, "mixamorig:LeftFoot"],
      [28, "mixamorig:RightFoot"],
    ];
    const usablePairs = pairs.filter(
      ([i, name]) =>
        this.model!.getObjectByName(name) &&
        this.pose!.landmarks[i] &&
        (this.pose!.landmarks[i].visibility ?? 1) >= MIN_VISIBILITY,
    );
    if (usablePairs.length < 2) return;
    this.model.updateWorldMatrix(true, true);
    const world = usablePairs.map(([, name]) => {
      const p = this.model!.getObjectByName(name)!.getWorldPosition(
        new THREE.Vector3(),
      );
      return { x: p.x, y: p.y };
    });
    const image = usablePairs.map(([i]) => this.pose!.landmarks[i]);
    let result: FrontAlignment;
    try {
      result = fitFrontProjection(
        world,
        image,
        this.imageSize,
        {
          width: this.host.clientWidth,
          height: this.host.clientHeight,
        },
        this.camera.fov,
      );
    } catch {
      return;
    }
    this.controls.target.set(result.target.x, result.target.y, 0);
    this.camera.zoom = 1;
    this.camera.updateProjectionMatrix();
    this.camera.position.set(result.target.x, result.target.y, result.distance);
    this.controls.update();
  }
  private alignRootToPelvis() {
    if (!this.model || !this.pose || !this.imageSize) return;
    const hips = this.model.getObjectByName("mixamorig:Hips");
    if (!hips) return;
    alignRootToImagePelvis(
      this.model,
      hips,
      this.pose.landmarks,
      this.imageSize,
      { width: this.host.clientWidth, height: this.host.clientHeight },
      this.camera,
    );
  }
  private reportAngle = () => {
    const direction = this.camera.position
      .clone()
      .sub(this.controls.target)
      .normalize();
    this.onAngle?.(
      THREE.MathUtils.radToDeg(
        Math.acos(THREE.MathUtils.clamp(direction.z, -1, 1)),
      ),
    );
  };
  setDepthScale(v: number) {
    this.depthScale = v;
    this.retarget();
    this.updateImageAlignment();
  }
  setHipFacing(value: HipFacing) {
    if (this.hipFacing === value) return;
    this.hipFacing = value;
    this.rebuildModel();
  }
  setBodyWidth(v: number) {
    this.proportions.width = v;
    this.rebuildModel();
  }
  setBodyHeight(v: number) {
    this.proportions.height = v;
    this.rebuildModel();
  }
  setLimbLengths(arm: number, leg: number) {
    this.proportions.armLength = arm;
    this.proportions.legLength = leg;
    this.rebuildModel();
  }
  private rebuildModel() {
    this.retarget(); // fixed order: pose first, then rest-based proportions/corrections
    this.updateImageAlignment();
  }
  private applyProportionsAndCorrections() {
    if (!this.model) return;
    const hips = this.model.getObjectByName("mixamorig:Hips");
    const savedHips = this.rest.get("mixamorig:Hips");
    const poseOffset =
      hips && savedHips
        ? hips.position.clone().sub(savedHips.localPosition)
        : new THREE.Vector3();
    const proportionReport = applyBodyProportions(
      this.model,
      this.rest,
      this.proportions,
      this.baseScale,
    );
    for (const name of proportionReport.missingBones)
      if (!this.lastReport.missingBones.includes(name))
        this.lastReport.missingBones.push(name);
    if (hips) hips.position.add(poseOffset);
    this.correctionBasePositions.clear();
    for (const r of RULES) {
      const bone = this.model.getObjectByName(r.bone);
      if (bone) this.correctionBasePositions.set(r.bone, bone.position.clone());
    }
    this.applyCorrections();
  }
  selectJoint(id: JointId) {
    this.selected = id;
    this.updateHelper();
  }
  getJointCorrection(id: JointId) {
    const c = this.corrections.get(id) ?? {
      rotation: new THREE.Euler(),
      translation: new THREE.Vector3(),
    };
    return {
      rotation: [c.rotation.x, c.rotation.y, c.rotation.z].map(
        THREE.MathUtils.radToDeg,
      ) as [number, number, number],
      translation: c.translation.toArray() as [number, number, number],
    };
  }
  setJointCorrection(
    id: JointId,
    rotation: [number, number, number],
    translation: [number, number, number],
  ) {
    this.corrections.set(
      id,
      clampJointCorrection(id, {
        rotation: new THREE.Euler(
          ...(rotation.map(THREE.MathUtils.degToRad) as [
            number,
            number,
            number,
          ]),
          "XYZ",
        ),
        translation: new THREE.Vector3(...translation),
      }),
    );
    this.applyCorrections();
    this.updateImageAlignment();
  }
  resetJoint(id: JointId) {
    this.corrections.delete(id);
    this.applyCorrections();
    this.updateImageAlignment();
  }
  resetPose() {
    this.corrections.clear();
    this.applyCorrections();
    this.updateImageAlignment();
  }
  private applyCorrections() {
    if (!this.model) return;
    for (const r of RULES) {
      const b = this.model.getObjectByName(r.bone),
        q = this.posed.get(r.bone);
      if (!b || !q) continue;
      b.quaternion.copy(q);
      const basePosition = this.correctionBasePositions.get(r.bone);
      if (basePosition) b.position.copy(basePosition);
      const c = this.corrections.get(r.id);
      if (c) {
        b.quaternion.multiply(new THREE.Quaternion().setFromEuler(c.rotation));
        b.position.add(c.translation);
      }
    }
    this.model.updateWorldMatrix(true, true);
    this.updateHelper();
  }
  private updateHelper() {
    this.helper.clear();
    if (!this.model) return;
    for (const r of RULES) {
      const b = this.model.getObjectByName(r.bone);
      if (!b) continue;
      const p = new THREE.Vector3();
      b.getWorldPosition(p);
      if (![p.x, p.y, p.z].every(Number.isFinite)) continue;
      const material = new THREE.MeshBasicMaterial({
        color: r.id === this.selected ? 0xff9bd2 : 0x9f83ff,
        depthTest: false,
      });
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(r.id === this.selected ? 0.035 : 0.022, 12, 8),
        material,
      );
      sphere.position.copy(p);
      sphere.userData.joint = r.id;
      sphere.renderOrder = 10;
      this.helper.add(sphere);
      const child = r.child && this.model.getObjectByName(r.child);
      if (child) {
        const q = new THREE.Vector3();
        child.getWorldPosition(q);
        if (![q.x, q.y, q.z].every(Number.isFinite)) continue;
        const geometry = new THREE.BufferGeometry().setFromPoints([p, q]);
        const line = new THREE.Line(
          geometry,
          new THREE.LineBasicMaterial({
            color: 0x8b72d8,
            depthTest: false,
            transparent: true,
            opacity: 0.8,
          }),
        );
        line.renderOrder = 9;
        this.helper.add(line);
      }
    }
  }
  private pick = (event: PointerEvent) => {
    if (this.renderer.domElement.hidden) return;
    const rect = this.renderer.domElement.getBoundingClientRect(),
      mouse = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        (-(event.clientY - rect.top) / rect.height) * 2 + 1,
      );
    const hit = new THREE.Raycaster();
    hit.setFromCamera(mouse, this.camera);
    const object = hit.intersectObjects(this.helper.children, false)[0]?.object;
    const id = object?.userData.joint as JointId | undefined;
    if (id) {
      this.selectJoint(id);
      this.onSelect?.(id);
    }
  };
  /** Capture a source-image-aligned front/back depth, mask and normal G-buffer. */
  captureDepth(width = 512, height = width): RigSurfaceBuffer {
    if (!this.model) throw new Error("素体が読み込まれていません");
    this.rebuildModel();
    this.model.updateWorldMatrix(true, true);
    const target = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      depthBuffer: true,
    });
    const camera = this.camera.clone();
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    const previous = this.scene.overrideMaterial;
    this.helper.visible = false;
    const render = (material: THREE.Material) => {
      this.scene.overrideMaterial = material;
      this.renderer.setRenderTarget(target);
      this.renderer.clear();
      this.renderer.render(this.scene, camera);
      const pixels = new Uint8Array(width * height * 4);
      this.renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
      material.dispose();
      return pixels;
    };
    const packedFront = render(
      new THREE.MeshDepthMaterial({
        depthPacking: THREE.RGBADepthPacking,
        side: THREE.FrontSide,
      }),
    );
    const packedBack = render(
      new THREE.MeshDepthMaterial({
        depthPacking: THREE.RGBADepthPacking,
        side: THREE.BackSide,
      }),
    );
    const packedNormal = render(
      new THREE.MeshNormalMaterial({ side: THREE.FrontSide }),
    );
    this.renderer.setRenderTarget(null);
    this.scene.overrideMaterial = previous;
    this.helper.visible = true;
    target.dispose();
    const frontDepth = new Float32Array(width * height),
      backDepth = new Float32Array(width * height),
      mask = new Uint8Array(width * height),
      normal = new Float32Array(width * height * 3);
    const unpack = (p: Uint8Array, s: number) =>
      p[s] / 255 / 256 ** 3 +
      p[s + 1] / 255 / 256 ** 2 +
      p[s + 2] / 255 / 256 +
      p[s + 3] / 255;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const s = ((height - 1 - y) * width + x) * 4,
          d = y * width + x;
        frontDepth[d] = unpack(packedFront, s);
        backDepth[d] = unpack(packedBack, s);
        mask[d] = frontDepth[d] < 0.999 ? 1 : 0;
        normal.set(
          [
            packedNormal[s] / 127.5 - 1,
            packedNormal[s + 1] / 127.5 - 1,
            packedNormal[s + 2] / 127.5 - 1,
          ],
          d * 3,
        );
      }
    const inverseProjectionView = new THREE.Matrix4()
      .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      .invert();
    return {
      width,
      height,
      frontDepth,
      backDepth,
      mask,
      normal,
      inverseProjectionView: new Float32Array(inverseProjectionView.elements),
    };
  }
  setView(view: "front" | "side" | "back" | "top") {
    if (view === "front" && this.imageSize) {
      this.updateImageAlignment();
      return;
    }
    const p = {
      front: [0, 0.05, 3.4],
      side: [3.4, 0.05, 0],
      back: [0, 0.05, -3.4],
      top: [0, 3.4, 0.01],
    }[view];
    const target = this.controls.target.clone();
    this.camera.position.set(target.x + p[0], target.y + p[1], target.z + p[2]);
    this.controls.update();
  }
  reset() {
    this.setView("front");
  }
  private fit() {
    if (!this.model) return;
    this.model.scale.set(1, 1, 1);
    const box = new THREE.Box3().setFromObject(this.model),
      size = box.getSize(new THREE.Vector3()),
      center = box.getCenter(new THREE.Vector3());
    this.model.position.sub(center);
    this.baseScale = 2 / Math.max(size.x, size.y, size.z);
    this.model.scale.set(
      this.baseScale * this.proportions.width,
      this.baseScale * this.proportions.height,
      this.baseScale,
    );
    this.model.updateWorldMatrix(true, true);
    this.updateHelper();
    this.reset();
  }
  private resize() {
    const w = this.host.clientWidth,
      h = this.host.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    if (this.pose && this.imageSize) this.updateImageAlignment();
  }
  private loop = () => {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.raf = requestAnimationFrame(this.loop);
  };
  setVisible(v: boolean) {
    this.renderer.domElement.hidden = !v;
    this.helper.visible = v;
  }
  isVisible() {
    return !this.renderer.domElement.hidden;
  }
  dispose() {
    cancelAnimationFrame(this.raf);
    this.controls.dispose();
    this.renderer.dispose();
  }
}
