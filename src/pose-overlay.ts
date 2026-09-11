export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface ContainRect extends Size {
  x: number;
  y: number;
  scale: number;
}

/** Returns the exact destination rectangle used by an object-fit: contain image. */
export function getContainRect(source: Size, destination: Size): ContainRect {
  if (
    source.width <= 0 ||
    source.height <= 0 ||
    destination.width <= 0 ||
    destination.height <= 0
  ) {
    return { x: 0, y: 0, width: 0, height: 0, scale: 0 };
  }
  const scale = Math.min(
    destination.width / source.width,
    destination.height / source.height,
  );
  const width = source.width * scale;
  const height = source.height * scale;
  return {
    x: (destination.width - width) / 2,
    y: (destination.height - height) / 2,
    width,
    height,
    scale,
  };
}

/** Maps a normalized image landmark into the shared image/canvas contain area. */
export function mapLandmarkToContain(point: Point, rect: ContainRect): Point {
  return {
    x: rect.x + point.x * rect.width,
    y: rect.y + point.y * rect.height,
  };
}
