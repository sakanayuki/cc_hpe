/**
 * Stable far-to-near counting sort for alpha-composited splats.
 * Quantization avoids O(n log n) pauses at the 500k-splat product limit.
 */
export function depthSortIndices(
  positions: Float32Array,
  camera: readonly [number, number, number],
  forward: readonly [number, number, number],
  bins = 65_536,
): Uint32Array {
  const count = Math.floor(positions.length / 3);
  const depths = new Float32Array(count);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < count; i += 1) {
    const depth =
      (positions[i * 3] - camera[0]) * forward[0] +
      (positions[i * 3 + 1] - camera[1]) * forward[1] +
      (positions[i * 3 + 2] - camera[2]) * forward[2];
    depths[i] = depth;
    min = Math.min(min, depth);
    max = Math.max(max, depth);
  }
  const histogram = new Uint32Array(bins);
  const quantized = new Uint16Array(count);
  const scale = max > min ? (bins - 1) / (max - min) : 0;
  for (let i = 0; i < count; i += 1) {
    const bucket = Math.min(
      bins - 1,
      Math.max(0, Math.floor((depths[i] - min) * scale)),
    );
    quantized[i] = bucket;
    histogram[bucket] += 1;
  }
  // The first output bucket is the farthest one, as required by source-over alpha blending.
  let cursor = 0;
  for (let bucket = bins - 1; bucket >= 0; bucket -= 1) {
    const size = histogram[bucket];
    histogram[bucket] = cursor;
    cursor += size;
  }
  const result = new Uint32Array(count);
  for (let i = 0; i < count; i += 1) result[histogram[quantized[i]]++] = i;
  return result;
}

export function reorder<T extends Float32Array | Uint8Array>(
  source: T,
  itemSize: number,
  order: Uint32Array,
): T {
  const output = new (source.constructor as { new (length: number): T })(
    source.length,
  );
  for (let target = 0; target < order.length; target += 1) {
    const origin = order[target] * itemSize;
    output.set(source.subarray(origin, origin + itemSize), target * itemSize);
  }
  return output;
}
