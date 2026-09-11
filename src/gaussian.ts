import type { PoseGuidance, RigSurfaceBuffer } from "./pose";

/** The provenance values are stable export data, not geometric depth layers. */
export const GaussianSource = {
  ObservedSurface: 0,
  InferredBack: 1,
  Interpolated: 2,
} as const;

export interface GaussianCloud {
  count: number;
  position: Float32Array;
  scale: Float32Array;
  rotation: Float32Array;
  color: Uint8Array;
  opacity: Float32Array;
  depth: Float32Array;
  confidence: Float32Array;
  /** 0 observed surface, 1 inferred back, 2 interpolated region. */
  layer: Uint8Array;
}
export interface BuildOptions {
  maxSplats: number;
  depthStrength: number;
  alphaThreshold: number;
}

type Splat = {
  p: [number, number, number];
  s: [number, number, number];
  q: [number, number, number, number];
  c: [number, number, number, number];
  opacity: number;
  depth: number;
  confidence: number;
  source: number;
};

function unproject(
  x: number,
  y: number,
  depth: number,
  g: RigSurfaceBuffer,
): [number, number, number] {
  const e = g.inverseProjectionView,
    nx = ((x + 0.5) / g.width) * 2 - 1,
    ny = 1 - ((y + 0.5) / g.height) * 2,
    nz = depth * 2 - 1;
  const w = e[3] * nx + e[7] * ny + e[11] * nz + e[15];
  return [
    (e[0] * nx + e[4] * ny + e[8] * nz + e[12]) / w,
    (e[1] * nx + e[5] * ny + e[9] * nz + e[13]) / w,
    (e[2] * nx + e[6] * ny + e[10] * nz + e[14]) / w,
  ];
}
function crossNormal(
  a: number[],
  b: number[],
  c: number[],
): [number, number, number] {
  const ux = b[0] - a[0],
    uy = b[1] - a[1],
    uz = b[2] - a[2],
    vx = c[0] - a[0],
    vy = c[1] - a[1],
    vz = c[2] - a[2];
  const n: [number, number, number] = [
      uy * vz - uz * vy,
      uz * vx - ux * vz,
      ux * vy - uy * vx,
    ],
    l = Math.hypot(...n) || 1;
  return [n[0] / l, n[1] / l, n[2] / l];
}
function rotationFromNormal([nx, ny, nz]: number[]): [
  number,
  number,
  number,
  number,
] {
  const l = Math.hypot(nx, ny, nz) || 1;
  nx /= l;
  ny /= l;
  nz /= l;
  const w = Math.sqrt(Math.max(0, 2 * (1 + nz)));
  return w < 1e-5 ? [1, 0, 0, 0] : [-ny / w, nx / w, 0, w / 2];
}
function sampleMask(
  pose: PoseGuidance,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const mx = Math.min(pose.maskWidth - 1, Math.floor((x / w) * pose.maskWidth)),
    my = Math.min(pose.maskHeight - 1, Math.floor((y / h) * pose.maskHeight));
  return pose.mask[my * pose.maskWidth + mx];
}

/** Removes bad geometry and merges duplicate samples without changing provenance. */
export function cleanupCloud(points: Splat[], pixelWorldSize: number): Splat[] {
  const finite = points.filter(
    (v) =>
      v.opacity >= 0.04 &&
      v.s.every(
        (x) => Number.isFinite(x) && x > 0 && x <= pixelWorldSize * 5,
      ) &&
      v.p.every(Number.isFinite),
  );
  if (!finite.length) return [];
  const zs = finite.map((v) => v.p[2]).sort((a, b) => a - b),
    lo = zs[Math.floor(zs.length * 0.005)],
    hi = zs[Math.min(zs.length - 1, Math.ceil(zs.length * 0.995))];
  const vox = Math.max(1e-5, pixelWorldSize * 0.45),
    seen = new Map<string, Splat>();
  for (const v of finite) {
    if (v.p[2] < lo - pixelWorldSize * 2 || v.p[2] > hi + pixelWorldSize * 2)
      continue;
    const key = `${v.source}:${Math.round(v.p[0] / vox)},${Math.round(v.p[1] / vox)},${Math.round(v.p[2] / vox)}`;
    const old = seen.get(key);
    if (!old || v.confidence > old.confidence) seen.set(key, v);
  }
  return [...seen.values()];
}

/** Builds one observed surfel per sampled photo pixel and optional, mesh-backed rear surfels. */
export function imageToCloud(
  image: ImageData,
  options: BuildOptions,
  pose: PoseGuidance,
): GaussianCloud {
  if (pose.landmarks.length < 29)
    throw new Error("人体骨格が不完全なため立体化できません。");
  const g = pose.rigSurface;
  if (!g) throw new Error("姿勢付きmeshのG-bufferが必要です。");
  if (g.width !== image.width || g.height !== image.height)
    throw new Error("G-bufferと元画像のアスペクト・解像度が一致しません。");
  const candidates: number[] = [];
  for (let i = 0; i < image.width * image.height; i++) {
    const x = i % image.width,
      y = Math.floor(i / image.width);
    if (
      image.data[i * 4 + 3] >= options.alphaThreshold &&
      sampleMask(pose, x, y, image.width, image.height) > 0.35 &&
      g.mask[i]
    )
      candidates.push(i);
  }
  if (!candidates.length)
    throw new Error("人物領域と姿勢付きmeshを対応付けできませんでした。");
  const rearBudget = Math.min(
    Math.floor(options.maxSplats * 0.2),
    Math.max(0, options.maxSplats - candidates.length),
  );
  const frontBudget = Math.max(1, options.maxSplats - rearBudget),
    stride = Math.max(1, Math.ceil(candidates.length / frontBudget));
  const points: Splat[] = [];
  let pixelWorld = 0.005;
  for (let k = 0; k < candidates.length; k += stride) {
    const i = candidates[k],
      x = i % g.width,
      y = Math.floor(i / g.width),
      d = g.frontDepth[i];
    if (d >= 0.999) continue;
    const p = unproject(x, y, d, g),
      xr = Math.min(g.width - 1, x + 1),
      yd = Math.min(g.height - 1, y + 1),
      pr = unproject(
        xr,
        y,
        g.frontDepth[y * g.width + xr] < 0.999
          ? g.frontDepth[y * g.width + xr]
          : d,
        g,
      ),
      pd = unproject(
        x,
        yd,
        g.frontDepth[yd * g.width + x] < 0.999
          ? g.frontDepth[yd * g.width + x]
          : d,
        g,
      );
    const sx =
        Math.hypot(pr[0] - p[0], pr[1] - p[1], pr[2] - p[2]) *
        Math.sqrt(stride),
      sy =
        Math.hypot(pd[0] - p[0], pd[1] - p[1], pd[2] - p[2]) *
        Math.sqrt(stride);
    pixelWorld = Math.max(pixelWorld, Math.min(sx, sy));
    const normal = crossNormal(p, pr, pd),
      alpha = image.data[i * 4 + 3] / 255,
      c: [number, number, number, number] = [
        image.data[i * 4],
        image.data[i * 4 + 1],
        image.data[i * 4 + 2],
        image.data[i * 4 + 3],
      ];
    points.push({
      p,
      s: [
        Math.max(sx, 0.001) * 0.72,
        Math.max(sy, 0.001) * 0.72,
        Math.max(0.0003, Math.min(sx, sy) * 0.12),
      ],
      q: rotationFromNormal(normal),
      c,
      opacity: alpha,
      depth: p[2],
      confidence: 0.75 + 0.25 * alpha,
      source: GaussianSource.ObservedSurface,
    });
  }
  if (rearBudget) {
    const step = Math.max(1, Math.ceil(candidates.length / rearBudget));
    for (
      let k = 0;
      k < candidates.length && points.length < options.maxSplats;
      k += step
    ) {
      const i = candidates[k],
        bd = g.backDepth[i],
        fd = g.frontDepth[i];
      if (bd >= 0.999 || Math.abs(bd - fd) < 1e-5) continue;
      const x = i % g.width,
        y = Math.floor(i / g.width),
        p = unproject(x, y, bd, g),
        base = i * 4;
      points.push({
        p,
        s: [pixelWorld * 0.9, pixelWorld * 0.9, pixelWorld * 0.15],
        q: rotationFromNormal([0, 0, -1]),
        c: [
          image.data[base] * 0.42,
          image.data[base + 1] * 0.42,
          image.data[base + 2] * 0.42,
          90,
        ] as [number, number, number, number],
        opacity: 0.22,
        depth: p[2],
        confidence: 0.18,
        source: GaussianSource.InferredBack,
      });
    }
  }
  const clean = cleanupCloud(points, pixelWorld).slice(0, options.maxSplats),
    n = clean.length,
    position = new Float32Array(n * 3),
    scale = new Float32Array(n * 3),
    rotation = new Float32Array(n * 4),
    color = new Uint8Array(n * 4),
    opacity = new Float32Array(n),
    depth = new Float32Array(n),
    confidence = new Float32Array(n),
    layer = new Uint8Array(n);
  clean.forEach((v, i) => {
    position.set(v.p, i * 3);
    scale.set(v.s, i * 3);
    rotation.set(v.q, i * 4);
    color.set(v.c, i * 4);
    opacity[i] = v.opacity;
    depth[i] = v.depth;
    confidence[i] = v.confidence;
    layer[i] = v.source;
  });
  return {
    count: n,
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
