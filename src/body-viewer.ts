import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { PoseGuidance } from "./pose";
import {
  getContainRect,
  mapLandmarkToContain,
  type Size,
} from "./pose-overlay";

export interface FrontAlignment {
  pixelsPerUnit: number;
  offsetX: number;
  offsetY: number;
  rmsDiagonalRatio: number;
}

/** Least-squares screen-space fit used by both the live camera and regression tests. */
export function solveFrontAlignment(
  modelPoints: Array<{ x: number; y: number }>,
  imagePoints: Array<{ x: number; y: number }>,
  viewport: Size,
): FrontAlignment {
  if (modelPoints.length !== imagePoints.length || modelPoints.length < 2)
    throw new Error("対応点が不足しています");
  const mc = modelPoints.reduce(
    (a, p) => ({
      x: a.x + p.x / modelPoints.length,
      y: a.y + p.y / modelPoints.length,
    }),
    { x: 0, y: 0 },
  );
  const ic = imagePoints.reduce(
    (a, p) => ({
      x: a.x + p.x / imagePoints.length,
      y: a.y + p.y / imagePoints.length,
    }),
    { x: 0, y: 0 },
  );
  let numerator = 0,
    denominator = 0;
  for (let i = 0; i < modelPoints.length; i++) {
    const mx = modelPoints[i].x - mc.x,
      my = modelPoints[i].y - mc.y;
    numerator +=
      mx * (imagePoints[i].x - ic.x) + my * (imagePoints[i].y - ic.y);
    denominator += mx * mx + my * my;
  }
  const pixelsPerUnit = denominator ? numerator / denominator : 1;
  const offsetX = ic.x - pixelsPerUnit * mc.x;
  const offsetY = ic.y - pixelsPerUnit * mc.y;
  const squared = modelPoints.reduce((sum, p, i) => {
    const dx = pixelsPerUnit * p.x + offsetX - imagePoints[i].x;
    const dy = pixelsPerUnit * p.y + offsetY - imagePoints[i].y;
    return sum + dx * dx + dy * dy;
  }, 0);
  return {
    pixelsPerUnit,
    offsetX,
    offsetY,
    rmsDiagonalRatio:
      Math.sqrt(squared / modelPoints.length) /
      Math.hypot(viewport.width, viewport.height),
  };
}

export type JointId =
  | "hips"
  | "spine"
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
export type RestBone = {
  localPosition: THREE.Vector3;
  localQuaternion: THREE.Quaternion;
  worldQuaternion: THREE.Quaternion;
  start: THREE.Vector3;
  end: THREE.Vector3;
  worldDirection: THREE.Vector3;
};
export const JOINT_LABELS: Record<JointId, string> = {
  hips: "腰",
  spine: "背骨",
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
export const EDITABLE_JOINTS = RULES.map((r) => r.id);

const MIN_VISIBILITY = 0.45;
const EPSILON = 1e-6;

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
  return result;
}

function torsoFrame(pose: PoseGuidance, depthScale: number) {
  if (!usable([11, 12, 23, 24], pose)) return undefined;
  const hips = average([23, 24], pose, depthScale);
  const shoulders = average([11, 12], pose, depthScale);
  const right = average([12], pose, depthScale).sub(
    average([11], pose, depthScale),
  );
  const up = shoulders.sub(hips);
  if (right.lengthSq() <= EPSILON || up.lengthSq() <= EPSILON) return undefined;
  right.normalize();
  const front = right.clone().cross(up).normalize();
  if (front.lengthSq() <= EPSILON) return undefined;
  const correctedUp = front.clone().cross(right).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(right, correctedUp, front),
  );
}

/** Retargets from immutable rest data and is intentionally usable in unit tests. */
export function retargetSkeleton(
  model: THREE.Object3D,
  pose: PoseGuidance,
  rest: Map<string, RestBone>,
  depthScale = 1,
): RetargetReport {
  const report: RetargetReport = {
    appliedBones: 0,
    missingBones: [],
    skippedBones: [],
  };
  const bodyFrame = torsoFrame(pose, depthScale);
  const torsoIds = new Set<JointId>(["hips", "spine", "chest"]);

  // Always reset the whole chain first: repeated calls must never accumulate.
  for (const rule of RULES) {
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
    if (torsoIds.has(rule.id) && bodyFrame) {
      // Rest GLB axes are inferred once from its front/up convention.  The
      // target body frame carries root yaw/roll, torso lean and shoulder tilt.
      const restUp = saved.worldDirection;
      const restRight = new THREE.Vector3(1, 0, 0).applyQuaternion(
        saved.worldQuaternion,
      );
      const restFront = restRight.clone().cross(restUp).normalize();
      const restFrame = new THREE.Quaternion().setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(restRight, restUp, restFront),
      );
      desiredWorld = bodyFrame
        .clone()
        .multiply(restFrame.invert())
        .multiply(saved.worldQuaternion);
    } else if (usable([...rule.from, ...rule.to], pose)) {
      const target = poseDirection(rule.from, rule.to, pose, depthScale);
      if (
        target.lengthSq() > EPSILON &&
        saved.worldDirection.lengthSq() > EPSILON
      )
        desiredWorld = new THREE.Quaternion()
          .setFromUnitVectors(saved.worldDirection, target)
          .multiply(saved.worldQuaternion);
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
    bone.quaternion.copy(parentWorld.invert().multiply(desiredWorld));
    model.updateWorldMatrix(true, true);
    report.appliedBones++;
  }
  const hips = model.getObjectByName("mixamorig:Hips");
  if (hips && usable([23, 24], pose)) {
    const center = average([23, 24], pose, depthScale);
    hips.position.add(center);
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
  private corrections = new Map<JointId, THREE.Euler>();
  private helper = new THREE.Group();
  private restPositions = new Map<string, THREE.Vector3>();
  private heightScale = 1;
  private armScale = 1;
  private legScale = 1;
  private selected: JointId = "hips";
  private depthScale = 1;
  private widthScale = 1;
  private imageSize?: Size;
  constructor(
    private host: HTMLElement,
    private onSelect?: (id: JointId) => void,
    private onFrontAngle?: (degrees: number) => void,
  ) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(0x121018, 0);
    this.renderer.domElement.classList.add("glb-canvas");
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.append(this.renderer.domElement);
    this.camera.position.set(0, 0.05, 3.4);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(0, 0, 0);
    this.controls.addEventListener("change", () => this.reportFrontAngle());
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x24182f, 2.4));
    const light = new THREE.DirectionalLight(0xffffff, 3);
    light.position.set(2, 4, 3);
    this.scene.add(light, this.helper);
    this.renderer.domElement.addEventListener("pointerdown", this.pick);
    new ResizeObserver(() => this.resize()).observe(host);
    this.loop();
  }
  async showPose(pose: PoseGuidance, depthScale = 1, imageSize?: Size) {
    await this.ensureModel();
    this.pose = pose;
    this.depthScale = depthScale;
    this.imageSize = imageSize;
    this.corrections.clear();
    this.fit();
    this.retarget();
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
    this.scene.add(this.model);
    this.model.traverse((node) =>
      this.restPositions.set(node.name, node.position.clone()),
    );
    this.rest = captureRestPose(this.model);
  }
  private retarget() {
    if (!this.model || !this.pose) return;
    this.lastReport = retargetSkeleton(
      this.model,
      this.pose,
      this.rest,
      this.depthScale,
    );
    for (const r of RULES) {
      const bone = this.model.getObjectByName(r.bone);
      if (bone) this.posed.set(r.bone, bone.quaternion.clone());
    }
    this.applyCorrections();
  }
  setDepthScale(v: number) {
    this.depthScale = v;
    this.retarget();
  }
  setBodyWidth(v: number) {
    this.widthScale = v;
    this.applyProportions();
  }
  setBodyHeight(v: number) {
    this.heightScale = v;
    this.applyProportions();
  }
  setLimbLengths(arm: number, leg: number) {
    this.armScale = arm;
    this.legScale = leg;
    this.applyProportions();
    this.retarget();
  }
  private applyProportions() {
    if (!this.model) return;
    this.model.scale.set(
      this.baseScale * this.widthScale,
      this.baseScale * this.heightScale,
      this.baseScale,
    );
    for (const name of [
      "mixamorig:LeftForeArm",
      "mixamorig:LeftHand",
      "mixamorig:RightForeArm",
      "mixamorig:RightHand",
    ]) {
      const b = this.model.getObjectByName(name),
        p = this.restPositions.get(name);
      if (b && p) b.position.copy(p).multiplyScalar(this.armScale);
    }
    for (const name of [
      "mixamorig:LeftLeg",
      "mixamorig:LeftFoot",
      "mixamorig:RightLeg",
      "mixamorig:RightFoot",
    ]) {
      const b = this.model.getObjectByName(name),
        p = this.restPositions.get(name);
      if (b && p) b.position.copy(p).multiplyScalar(this.legScale);
    }
    this.model.updateWorldMatrix(true, true);
    this.updateHelper();
  }
  selectJoint(id: JointId) {
    this.selected = id;
    this.updateHelper();
  }
  getJointCorrection(id: JointId) {
    const e = this.corrections.get(id) ?? new THREE.Euler();
    return [e.x, e.y, e.z].map(THREE.MathUtils.radToDeg) as [
      number,
      number,
      number,
    ];
  }
  setJointCorrection(id: JointId, x: number, y: number, z: number) {
    this.corrections.set(
      id,
      new THREE.Euler(
        ...([x, y, z].map(THREE.MathUtils.degToRad) as [
          number,
          number,
          number,
        ]),
        "XYZ",
      ),
    );
    this.applyCorrections();
  }
  resetJoint(id: JointId) {
    this.corrections.delete(id);
    this.applyCorrections();
  }
  resetPose() {
    this.corrections.clear();
    this.applyCorrections();
  }
  private applyCorrections() {
    if (!this.model) return;
    for (const r of RULES) {
      const b = this.model.getObjectByName(r.bone),
        q = this.posed.get(r.bone);
      if (!b || !q) continue;
      b.quaternion.copy(q);
      const e = this.corrections.get(r.id);
      if (e) b.quaternion.multiply(new THREE.Quaternion().setFromEuler(e));
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
  captureDepth(size = 512) {
    if (!this.model) throw new Error("素体が読み込まれていません");
    const box = new THREE.Box3().setFromObject(this.model),
      center = box.getCenter(new THREE.Vector3()),
      span =
        Math.max(
          box.getSize(new THREE.Vector3()).x,
          box.getSize(new THREE.Vector3()).y,
        ) * 0.58;
    const target = new THREE.WebGLRenderTarget(size, size, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      depthBuffer: true,
    });
    const camera = new THREE.OrthographicCamera(
      -span,
      span,
      span,
      -span,
      0.1,
      10,
    );
    camera.position.set(center.x, center.y, center.z + 4);
    camera.lookAt(center);
    const previous = this.scene.overrideMaterial;
    this.helper.visible = false;
    this.scene.overrideMaterial = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
    });
    this.renderer.setRenderTarget(target);
    this.renderer.clear();
    this.renderer.render(this.scene, camera);
    const rgba = new Uint8Array(size * size * 4);
    this.renderer.readRenderTargetPixels(target, 0, 0, size, size, rgba);
    this.renderer.setRenderTarget(null);
    this.scene.overrideMaterial = previous;
    this.helper.visible = true;
    target.dispose();
    const result = new Float32Array(size * size);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const s = ((size - 1 - y) * size + x) * 4,
          d = y * size + x;
        result[d] =
          rgba[s] / 255 / 256 ** 3 +
          rgba[s + 1] / 255 / 256 ** 2 +
          rgba[s + 2] / 255 / 256 +
          rgba[s + 3] / 255;
      }
    return result;
  }
  setView(view: "front" | "side" | "back" | "top") {
    const p = {
      front: [0, 0.05, 3.4],
      side: [3.4, 0.05, 0],
      back: [0, 0.05, -3.4],
      top: [0, 3.4, 0.01],
    }[view];
    this.camera.position.set(...(p as [number, number, number]));
    this.controls.target.set(0, 0, 0);
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
      this.baseScale * this.widthScale,
      this.baseScale * this.heightScale,
      this.baseScale,
    );
    this.model.updateWorldMatrix(true, true);
    this.fitFrontProjection();
    this.updateHelper();
  }
  private fitFrontProjection() {
    if (!this.model || !this.pose || !this.imageSize) return this.reset();
    const viewport = {
      width: this.host.clientWidth,
      height: this.host.clientHeight,
    };
    if (!viewport.width || !viewport.height) return;
    const rect = getContainRect(this.imageSize, viewport);
    // Shoulders, hips, knees, ankles: stable points spanning the person's height and width.
    const pairs: Array<[string, number]> = [
      ["mixamorig:LeftArm", 11],
      ["mixamorig:RightArm", 12],
      ["mixamorig:LeftUpLeg", 23],
      ["mixamorig:RightUpLeg", 24],
      ["mixamorig:LeftLeg", 25],
      ["mixamorig:RightLeg", 26],
      ["mixamorig:LeftFoot", 27],
      ["mixamorig:RightFoot", 28],
    ];
    const usable = pairs.filter(
      ([name, index]) =>
        this.model!.getObjectByName(name) &&
        (this.pose!.landmarks[index].visibility ?? 1) > 0.35,
    );
    const world = usable.map(([name]) => {
      const p = new THREE.Vector3();
      this.model!.getObjectByName(name)!.getWorldPosition(p);
      return { x: p.x, y: -p.y };
    });
    const image = usable.map(([, index]) =>
      mapLandmarkToContain(this.pose!.landmarks[index], rect),
    );
    if (world.length < 2) return this.reset();
    const fit = solveFrontAlignment(world, image, viewport);
    const distance = 3.4;
    this.camera.fov = THREE.MathUtils.radToDeg(
      2 *
        Math.atan(
          viewport.height / (2 * Math.abs(fit.pixelsPerUnit) * distance),
        ),
    );
    this.camera.fov = THREE.MathUtils.clamp(this.camera.fov, 10, 80);
    this.camera.updateProjectionMatrix();
    const actualScale =
      viewport.height /
      (2 * distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
    this.model.position.x += (fit.offsetX - viewport.width / 2) / actualScale;
    this.model.position.y -= (fit.offsetY - viewport.height / 2) / actualScale;
    this.model.updateWorldMatrix(true, true);
    this.camera.position.set(0, 0, distance);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }
  private reportFrontAngle() {
    const direction = this.camera.position
      .clone()
      .sub(this.controls.target)
      .normalize();
    this.onFrontAngle?.(
      THREE.MathUtils.radToDeg(
        Math.acos(THREE.MathUtils.clamp(direction.z, -1, 1)),
      ),
    );
  }
  private resize() {
    const w = this.host.clientWidth,
      h = this.host.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
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
