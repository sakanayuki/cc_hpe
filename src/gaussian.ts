export interface GaussianCloud {
  count: number;
  position: Float32Array;
  scale: Float32Array;
  rotation: Float32Array;
  color: Uint8Array;
  opacity: Float32Array;
  depth: Float32Array;
  confidence: Float32Array;
}

export interface BuildOptions { maxSplats: number; depthStrength: number; alphaThreshold: number }

export function imageToCloud(image: ImageData, options: BuildOptions): GaussianCloud {
  const { width, height, data } = image;
  const candidates: number[] = [];
  for (let i = 0; i < width * height; i += 1) {
    const a = data[i * 4 + 3];
    const whiteDistance = 255 * 3 - data[i * 4] - data[i * 4 + 1] - data[i * 4 + 2];
    if (a >= options.alphaThreshold && (a < 250 || whiteDistance > 38)) candidates.push(i);
  }
  const stride = Math.max(1, Math.ceil(candidates.length / options.maxSplats));
  const count = Math.ceil(candidates.length / stride);
  const position = new Float32Array(count * 3);
  const scale = new Float32Array(count * 3);
  const rotation = new Float32Array(count * 4);
  const color = new Uint8Array(count * 4);
  const opacity = new Float32Array(count);
  const depth = new Float32Array(count);
  const confidence = new Float32Array(count);
  const aspect = width / height;
  const pixelScale = (2 / height) * Math.sqrt(stride) * 0.7;

  for (let out = 0, source = 0; source < candidates.length; source += stride, out += 1) {
    const index = candidates[source];
    const x = index % width;
    const y = Math.floor(index / width);
    const nx = (x / Math.max(1, width - 1)) * 2 - 1;
    const ny = (y / Math.max(1, height - 1)) * 2 - 1;
    const radial = Math.max(0, 1 - nx * nx * 0.55 - ny * ny * 0.28);
    const luminance = (data[index * 4] * 0.2126 + data[index * 4 + 1] * 0.7152 + data[index * 4 + 2] * 0.0722) / 255;
    const z = (radial * 0.22 + (0.5 - luminance) * 0.04) * options.depthStrength;
    position.set([nx * aspect, -ny, z], out * 3);
    scale.set([pixelScale, pixelScale, pixelScale * 0.18], out * 3);
    rotation.set([0, 0, 0, 1], out * 4);
    color.set(data.subarray(index * 4, index * 4 + 4), out * 4);
    opacity[out] = data[index * 4 + 3] / 255;
    depth[out] = z;
    confidence[out] = Math.min(1, radial * 0.7 + opacity[out] * 0.3);
  }
  return { count, position, scale, rotation, color, opacity, depth, confidence };
}

