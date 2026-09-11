import { FilesetResolver, PoseLandmarker, type NormalizedLandmark } from '@mediapipe/tasks-vision';

export interface PoseGuidance {
  landmarks: NormalizedLandmark[];
  mask: Float32Array;
  maskWidth: number;
  maskHeight: number;
}

let instance: Promise<PoseLandmarker> | undefined;

function landmarker(): Promise<PoseLandmarker> {
  instance ??= (async () => {
    const base = import.meta.env.BASE_URL;
    const wasm = await FilesetResolver.forVisionTasks(`${base}runtime/wasm`);
    return PoseLandmarker.createFromOptions(wasm, {
      baseOptions: { modelAssetPath: `${base}runtime/models/pose_landmarker_full.task`, delegate: 'GPU' },
      runningMode: 'IMAGE', numPoses: 2, outputSegmentationMasks: true,
      minPoseDetectionConfidence: 0.55, minPosePresenceConfidence: 0.55,
    });
  })();
  return instance;
}

export async function detectSinglePerson(image: HTMLImageElement): Promise<PoseGuidance> {
  const result = (await landmarker()).detect(image);
  if (!result.landmarks.length) throw new Error('人物を検出できませんでした。全身または上半身が見える写真を選択してください。');
  if (result.landmarks.length !== 1) throw new Error('複数の人物を検出しました。人物が1人だけの写真を選択してください。');
  const segmentation = result.segmentationMasks?.[0];
  if (!segmentation) throw new Error('人物マスクを生成できませんでした。');
  const guidance = {
    landmarks: result.landmarks[0].map((point) => ({ ...point })),
    mask: new Float32Array(segmentation.getAsFloat32Array()),
    maskWidth: segmentation.width,
    maskHeight: segmentation.height,
  };
  result.close();
  return guidance;
}
