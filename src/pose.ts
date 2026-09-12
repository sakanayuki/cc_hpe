import {
  FilesetResolver,
  HandLandmarker,
  PoseLandmarker,
  type Category,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";

export type HandSide = "left" | "right";
export type HandLandmark = NormalizedLandmark & {
  /** Hand Landmarker does not expose per-point visibility; this is its hand score. */
  visibility: number;
  confidence: number;
};
export interface HandPose {
  /** Exactly 21 MediaPipe hand landmarks, in image coordinates. */
  landmarks: HandLandmark[];
  /** Exactly 21 landmarks in the Hand Landmarker's metric world coordinates. */
  worldLandmarks: HandLandmark[];
  handedness: HandSide;
  confidence: number;
}
export type HandsGuidance = Partial<Record<HandSide, HandPose>>;

export interface PoseGuidance {
  landmarks: NormalizedLandmark[];
  worldLandmarks: NormalizedLandmark[];
  hands?: HandsGuidance;
  mask: Float32Array;
  maskWidth: number;
  maskHeight: number;
  rigDepth?: Float32Array;
  rigDepthWidth?: number;
  rigDepthHeight?: number;
  /** Camera-fitted G-buffer of the posed body, in source-image pixel space. */
  rigSurface?: RigSurfaceBuffer;
}

export interface RigSurfaceBuffer {
  width: number;
  height: number;
  /** WebGL depth in [0,1], with 1 denoting no mesh. */
  frontDepth: Float32Array;
  backDepth: Float32Array;
  mask: Uint8Array;
  /** View-space XYZ normal, three floats per pixel. */
  normal: Float32Array;
  inverseProjectionView: Float32Array;
  camera: {
    position: [number, number, number];
    target: [number, number, number];
    frontAngleDegrees: number;
    projectionMatrixFinite: boolean;
  };
}

let instance: Promise<PoseLandmarker> | undefined;
let handInstance: Promise<HandLandmarker> | undefined;

export const MIN_HAND_CONFIDENCE = 0.65;
export const MIN_HAND_IMAGE_DIAGONAL = 0.055;

function landmarker(): Promise<PoseLandmarker> {
  instance ??= (async () => {
    const base = import.meta.env.BASE_URL;
    const wasm = await FilesetResolver.forVisionTasks(`${base}runtime/wasm`);
    return PoseLandmarker.createFromOptions(wasm, {
      baseOptions: {
        modelAssetPath: `${base}runtime/models/pose_landmarker_full.task`,
        delegate: "GPU",
      },
      runningMode: "IMAGE",
      numPoses: 2,
      outputSegmentationMasks: true,
      minPoseDetectionConfidence: 0.55,
      minPosePresenceConfidence: 0.55,
    });
  })();
  return instance;
}

function handLandmarker(): Promise<HandLandmarker> {
  handInstance ??= (async () => {
    const base = import.meta.env.BASE_URL;
    const wasm = await FilesetResolver.forVisionTasks(`${base}runtime/wasm`);
    return HandLandmarker.createFromOptions(wasm, {
      baseOptions: {
        modelAssetPath: `${base}runtime/models/hand_landmarker.task`,
        delegate: "GPU",
      },
      runningMode: "IMAGE",
      numHands: 2,
      minHandDetectionConfidence: MIN_HAND_CONFIDENCE,
      minHandPresenceConfidence: MIN_HAND_CONFIDENCE,
    });
  })();
  return handInstance;
}

type RawHand = {
  landmarks: NormalizedLandmark[];
  worldLandmarks: NormalizedLandmark[];
  handedness: Category[];
};

/** Filters and anatomically associates detections rather than trusting labels alone. */
export function associateHands(
  detections: RawHand[],
  poseLandmarks: NormalizedLandmark[],
  imageMirrored = false,
): HandsGuidance {
  const candidates = detections.flatMap((hand, sourceIndex) => {
    if (hand.landmarks.length !== 21 || hand.worldLandmarks.length !== 21)
      return [];
    const xs = hand.landmarks.map((p) => p.x);
    const ys = hand.landmarks.map((p) => p.y);
    const imageDiagonal = Math.hypot(
      Math.max(...xs) - Math.min(...xs),
      Math.max(...ys) - Math.min(...ys),
    );
    const category = hand.handedness[0];
    const confidence = category?.score ?? 0;
    if (
      confidence < MIN_HAND_CONFIDENCE ||
      imageDiagonal < MIN_HAND_IMAGE_DIAGONAL
    )
      return [];
    let label = category.categoryName.toLowerCase() as HandSide;
    // MediaPipe's label convention assumes a mirrored/selfie image.
    if (!imageMirrored) label = label === "left" ? "right" : "left";
    return [{ hand, sourceIndex, confidence, label, imageDiagonal }];
  });
  const sides = [
    ["left", 15],
    ["right", 16],
  ] as const;
  const options = sides.map(([side, wristIndex]) => {
    const wrist = poseLandmarks[wristIndex];
    if (!wrist || (wrist.visibility ?? 1) < 0.45) return [];
    return candidates.flatMap((candidate) => {
      const handWrist = candidate.hand.landmarks[0];
      const distance = Math.hypot(handWrist.x - wrist.x, handWrist.y - wrist.y);
      if (distance > Math.max(0.12, candidate.imageDiagonal * 1.5)) return [];
      // Distance is authoritative; handedness resolves crossings/near ties.
      const cost = distance + (candidate.label === side ? 0 : 0.08);
      return [{ ...candidate, distance, cost }];
    });
  });

  // Solve both wrists together. A greedy left-first match can consume the only
  // valid candidate for the right wrist when hands overlap or cross.
  let assignment: Array<(typeof options)[number][number] | undefined> = [];
  let bestMatched = -1;
  let bestCost = Number.POSITIVE_INFINITY;
  for (const left of [undefined, ...options[0]]) {
    for (const right of [undefined, ...options[1]]) {
      if (left && right && left.sourceIndex === right.sourceIndex) continue;
      const matched = Number(Boolean(left)) + Number(Boolean(right));
      const cost = (left?.cost ?? 0) + (right?.cost ?? 0);
      if (
        matched > bestMatched ||
        (matched === bestMatched && cost < bestCost)
      ) {
        assignment = [left, right];
        bestMatched = matched;
        bestCost = cost;
      }
    }
  }

  const output: HandsGuidance = {};
  for (let index = 0; index < sides.length; index++) {
    const side = sides[index][0];
    const best = assignment[index];
    if (!best) continue;
    const enrich = (p: NormalizedLandmark): HandLandmark => ({
      ...p,
      visibility: best.confidence,
      confidence: best.confidence,
    });
    output[side] = {
      landmarks: best.hand.landmarks.map(enrich),
      worldLandmarks: best.hand.worldLandmarks.map(enrich),
      handedness: side,
      confidence: best.confidence,
    };
  }
  return output;
}

export async function detectSinglePerson(
  image: HTMLImageElement,
  imageMirrored = false,
): Promise<PoseGuidance> {
  const [result, handResult] = await Promise.all([
    landmarker().then((detector) => detector.detect(image)),
    handLandmarker().then((detector) => detector.detect(image)),
  ]);
  if (!result.landmarks.length)
    throw new Error(
      "人物を検出できませんでした。全身または上半身が見える写真を選択してください。",
    );
  if (result.landmarks.length !== 1)
    throw new Error(
      "複数の人物を検出しました。人物が1人だけの写真を選択してください。",
    );
  const segmentation = result.segmentationMasks?.[0];
  if (!segmentation) throw new Error("人物マスクを生成できませんでした。");
  if (!result.worldLandmarks[0])
    throw new Error("人物の3D骨格を推定できませんでした。");
  const guidance = {
    landmarks: result.landmarks[0].map((point) => ({ ...point })),
    worldLandmarks: result.worldLandmarks[0].map((point) => ({ ...point })),
    hands: associateHands(
      handResult.landmarks.map((landmarks, index) => ({
        landmarks,
        worldLandmarks: handResult.worldLandmarks[index] ?? [],
        handedness: handResult.handedness[index] ?? [],
      })),
      result.landmarks[0],
      imageMirrored,
    ),
    mask: new Float32Array(segmentation.getAsFloat32Array()),
    maskWidth: segmentation.width,
    maskHeight: segmentation.height,
  };
  result.close();
  return guidance;
}
