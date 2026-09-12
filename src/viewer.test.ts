import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import type { GaussianCloud } from "./gaussian";
import { SplatViewer } from "./viewer";

describe("SplatViewer", () => {
  it("creates finite three-component quad positions without warnings", () => {
    const viewer = Object.create(SplatViewer.prototype) as {
      camera: THREE.PerspectiveCamera;
      scene: THREE.Scene;
      host: { clientWidth: number; clientHeight: number };
      mesh?: THREE.Mesh<THREE.InstancedBufferGeometry>;
      setCloud: SplatViewer["setCloud"];
    };
    viewer.camera = new THREE.PerspectiveCamera(42, 1, 0.01, 100);
    viewer.camera.position.set(0, 0, 3.5);
    viewer.scene = new THREE.Scene();
    viewer.host = { clientWidth: 0, clientHeight: 0 };
    const cloud: GaussianCloud = {
      count: 1,
      position: new Float32Array([0, 0, 0]),
      scale: new Float32Array([0.01, 0.01, 0.01]),
      rotation: new Float32Array([0, 0, 0, 1]),
      color: new Uint8Array([255, 255, 255, 255]),
      opacity: new Float32Array([1]),
      depth: new Float32Array([0]),
      confidence: new Float32Array([1]),
      layer: new Uint8Array([0]),
    };
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    viewer.setCloud(cloud);

    const position = viewer.mesh!.geometry.getAttribute("position");
    expect(warning).not.toHaveBeenCalled();
    expect(position.itemSize).toBe(3);
    expect([...position.array].every(Number.isFinite)).toBe(true);
    expect(viewer.mesh!.frustumCulled).toBe(true);
    expect(viewer.mesh!.geometry.boundingSphere?.radius).toBeGreaterThan(0);
    warning.mockRestore();
  });
});
