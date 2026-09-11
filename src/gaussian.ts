import type { PoseGuidance } from "./pose";

export interface GaussianCloud {
  count: number;
  position: Float32Array;
  scale: Float32Array;
  rotation: Float32Array;
  color: Uint8Array;
  opacity: Float32Array;
  depth: Float32Array;
  confidence: Float32Array;
  layer: Uint8Array;
}
export interface BuildOptions {
  maxSplats: number;
  depthStrength: number;
  alphaThreshold: number;
}

const BONES = [
  [0, 11],
  [0, 12],
  [11, 12],
  [11, 23],
  [12, 24],
  [23, 24],
  [11, 13],
  [13, 15],
  [12, 14],
  [14, 16],
  [23, 25],
  [25, 27],
  [24, 26],
  [26, 28],
] as const;

function maskAt(
  pose: PoseGuidance,
  x: number,
  y: number,
  width: number,
  height: number,
): number {
  const mx = Math.min(
    pose.maskWidth - 1,
    Math.floor((x / width) * pose.maskWidth),
  );
  const my = Math.min(
    pose.maskHeight - 1,
    Math.floor((y / height) * pose.maskHeight),
  );
  return pose.mask[my * pose.maskWidth + mx];
}

function distanceField(pose: PoseGuidance): Float32Array {
  const w = pose.maskWidth,
    h = pose.maskHeight,
    d = new Float32Array(w * h),
    diag = Math.SQRT2;
  for (let i = 0; i < d.length; i++) d[i] = pose.mask[i] > 0.35 ? 1e4 : 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!d[i]) continue;
      if (x) d[i] = Math.min(d[i], d[i - 1] + 1);
      if (y) d[i] = Math.min(d[i], d[i - w] + 1);
      if (x && y) d[i] = Math.min(d[i], d[i - w - 1] + diag);
      if (x + 1 < w && y) d[i] = Math.min(d[i], d[i - w + 1] + diag);
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!d[i]) continue;
      if (x + 1 < w) d[i] = Math.min(d[i], d[i + 1] + 1);
      if (y + 1 < h) d[i] = Math.min(d[i], d[i + w] + 1);
      if (x + 1 < w && y + 1 < h) d[i] = Math.min(d[i], d[i + w + 1] + diag);
      if (x && y + 1 < h) d[i] = Math.min(d[i], d[i + w - 1] + diag);
    }
  return d;
}

function skeletalDepth(
  x: number,
  y: number,
  pose: PoseGuidance,
): { z: number; confidence: number } {
  let sum = 0,
    weight = 0;
  for (const [ai, bi] of BONES) {
    const a = pose.landmarks[ai],
      b = pose.landmarks[bi];
    if (!a || !b || Math.min(a.visibility ?? 1, b.visibility ?? 1) < 0.25)
      continue;
    const vx = b.x - a.x,
      vy = b.y - a.y,
      l = Math.max(1e-6, vx * vx + vy * vy);
    const t = Math.max(0, Math.min(1, ((x - a.x) * vx + (y - a.y) * vy) / l));
    const dx = x - (a.x + vx * t),
      dy = y - (a.y + vy * t);
    const w =
      Math.exp(-(dx * dx + dy * dy) / 0.006) *
      Math.min(a.visibility ?? 1, b.visibility ?? 1);
    sum += -(a.z + (b.z - a.z) * t) * w;
    weight += w;
  }
  return {
    z: weight > 1e-5 ? sum / weight : 0,
    confidence: Math.min(1, weight),
  };
}

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
function maskBounds(
  mask: Float32Array,
  w: number,
  h: number,
  predicate: (v: number) => boolean,
): Bounds {
  let minX = w,
    minY = h,
    maxX = 0,
    maxY = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (predicate(mask[y * w + x])) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
  return {
    minX,
    minY,
    maxX: Math.max(minX + 1, maxX),
    maxY: Math.max(minY + 1, maxY),
  };
}
function rotationFromNormal(
  nx: number,
  ny: number,
  nz: number,
): [number, number, number, number] {
  const length = Math.hypot(nx, ny, nz) || 1;
  nx /= length;
  ny /= length;
  nz /= length;
  const dot = nz,
    w = Math.sqrt((1 + dot) * 2);
  return w < 1e-5 ? [1, 0, 0, 0] : [-ny / w, nx / w, 0, w / 2];
}

/** Pose and silhouette conditioned closed proxy; no background fallback is allowed. */
export function imageToCloud(
  image: ImageData,
  options: BuildOptions,
  pose: PoseGuidance,
): GaussianCloud {
  if (pose.landmarks.length < 29)
    throw new Error("人体骨格が不完全なため立体化できません。");
  const { width, height, data } = image,
    candidates: number[] = [];
  for (let i = 0; i < width * height; i++) {
    const x = i % width,
      y = Math.floor(i / width);
    if (
      data[i * 4 + 3] >= options.alphaThreshold &&
      maskAt(pose, x, y, width, height) > 0.35
    )
      candidates.push(i);
  }
  if (!candidates.length) throw new Error("人物領域を抽出できませんでした。");
  const layers = Math.max(1, Math.min(3, Math.floor(options.maxSplats))),
    budget = Math.max(1, Math.floor(options.maxSplats / layers));
  const stride = Math.max(1, Math.ceil(candidates.length / budget)),
    count = Math.ceil(candidates.length / stride) * layers;
  const position = new Float32Array(count * 3),
    scale = new Float32Array(count * 3),
    rotation = new Float32Array(count * 4),
    color = new Uint8Array(count * 4),
    opacity = new Float32Array(count),
    depth = new Float32Array(count),
    confidence = new Float32Array(count),
    layer = new Uint8Array(count);
  const distances = distanceField(pose),
    aspect = width / height,
    pixelScale = (2 / height) * Math.sqrt(stride) * 0.72,
    personBox = maskBounds(
      pose.mask,
      pose.maskWidth,
      pose.maskHeight,
      (v) => v > 0.35,
    ),
    rig = pose.rigDepth,
    rigWidth = pose.rigDepthWidth ?? 0,
    rigHeight = pose.rigDepthHeight ?? 0,
    rigBox = rig
      ? maskBounds(rig, rigWidth, rigHeight, (v) => v < 0.999)
      : { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  let rigMin = 1,
    rigMax = 0,
    out = 0;
  if (rig)
    for (const v of rig)
      if (v < 0.999) {
        rigMin = Math.min(rigMin, v);
        rigMax = Math.max(rigMax, v);
      }
  const rigSample = (rx: number, ry: number) => {
    if (!rig || !rigWidth || !rigHeight) return 1;
    const ix = Math.max(0, Math.min(rigWidth - 1, Math.round(rx))),
      iy = Math.max(0, Math.min(rigHeight - 1, Math.round(ry)));
    return rig[iy * rigWidth + ix];
  };
  for (let source = 0; source < candidates.length; source += stride) {
    let index = candidates[source],
      best = -1;
    for (
      let candidate = source;
      candidate < Math.min(candidates.length, source + stride);
      candidate++
    ) {
      const ci = candidates[candidate],
        cx = ci % width,
        cy = Math.floor(ci / width),
        cmx = Math.min(
          pose.maskWidth - 1,
          Math.floor((cx / width) * pose.maskWidth),
        ),
        cmy = Math.min(
          pose.maskHeight - 1,
          Math.floor((cy / height) * pose.maskHeight),
        ),
        edge = 1 / (1 + distances[cmy * pose.maskWidth + cmx]),
        right = ci + (cx + 1 < width ? 1 : 0),
        down = ci + (cy + 1 < height ? width : 0),
        detail =
          Math.abs(data[ci * 4] - data[right * 4]) +
          Math.abs(data[ci * 4 + 1] - data[right * 4 + 1]) +
          Math.abs(data[ci * 4 + 2] - data[right * 4 + 2]) +
          Math.abs(data[ci * 4] - data[down * 4]) +
          edge * 255;
      if (detail > best) {
        best = detail;
        index = ci;
      }
    }
    const x = index % width,
      y = Math.floor(index / width),
      nx = (x / Math.max(1, width - 1)) * 2 - 1,
      ny = (y / Math.max(1, height - 1)) * 2 - 1,
      mx = Math.min(
        pose.maskWidth - 1,
        Math.floor((x / width) * pose.maskWidth),
      ),
      my = Math.min(
        pose.maskHeight - 1,
        Math.floor((y / height) * pose.maskHeight),
      ),
      u = (mx - personBox.minX) / (personBox.maxX - personBox.minX),
      v = (my - personBox.minY) / (personBox.maxY - personBox.minY),
      rigX = rigBox.minX + u * (rigBox.maxX - rigBox.minX),
      rigY = rigBox.minY + v * (rigBox.maxY - rigBox.minY),
      rawRig = rigSample(rigX, rigY),
      hasRig = rawRig < 0.999 && rigMax > rigMin,
      rigZ = hasRig ? (0.5 - (rawRig - rigMin) / (rigMax - rigMin)) * 0.7 : 0,
      dx = hasRig
        ? (rigSample(rigX + 1, rigY) - rigSample(rigX - 1, rigY)) * 60
        : 0,
      dy = hasRig
        ? (rigSample(rigX, rigY + 1) - rigSample(rigX, rigY - 1)) * 60
        : 0,
      normal = rotationFromNormal(-dx, dy, 1),
      half =
        Math.min(
          0.22,
          Math.max(
            0.012,
            (distances[my * pose.maskWidth + mx] / pose.maskHeight) * 1.8,
          ),
        ) * options.depthStrength,
      bone = skeletalDepth(x / width, y / height, pose),
      center =
        (bone.z * (hasRig ? 0.28 : 1) + rigZ * (hasRig ? 0.72 : 0)) *
        options.depthStrength,
      maskValue = maskAt(pose, x, y, width, height),
      feather = Math.max(0, Math.min(1, (maskValue - 0.25) / 0.4)),
      alpha =
        (feather * feather * (3 - 2 * feather) * data[index * 4 + 3]) / 255,
      offsets =
        layers === 1 ? [0] : layers === 2 ? [0.9, -0.9] : [0.9, 0, -0.9];
    for (const factor of offsets) {
      const z = center + factor * half,
        shade = factor > 0 ? 1 : factor < 0 ? 0.64 : 0.82;
      position.set([nx * aspect, -ny, z], out * 3);
      scale.set(
        [
          pixelScale * 1.15,
          pixelScale * 0.85,
          factor === 0
            ? Math.max(pixelScale * 0.35, half * 0.25)
            : pixelScale * 0.42,
        ],
        out * 3,
      );
      rotation.set(normal, out * 4);
      color.set(
        [
          Math.round(data[index * 4] * shade),
          Math.round(data[index * 4 + 1] * shade),
          Math.round(data[index * 4 + 2] * shade),
          Math.round(alpha * 255),
        ],
        out * 4,
      );
      opacity[out] = alpha * (factor === 0 ? 0.42 : 0.92);
      depth[out] = z;
      confidence[out] = Math.min(
        1,
        alpha * 0.55 + bone.confidence * 0.25 + (hasRig ? 0.2 : 0),
      );
      layer[out] = factor > 0 ? 0 : factor === 0 ? 1 : 2;
      out++;
    }
  }
  return {
    count,
    position,
    scale,
    rotation,
    color,
    opacity,
    depth,
    confidence,
    layer,
  };
}
