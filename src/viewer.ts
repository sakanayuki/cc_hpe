import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { GaussianCloud } from "./gaussian";
import { depthSortIndices, reorder } from "./splat-sort";

export type RenderMode =
  | "color"
  | "depth"
  | "opacity"
  | "confidence"
  | "source";

/** Instanced, covariance-projected Gaussian renderer. Unlike THREE.Points this honors every splat's scale and quaternion. */
export class SplatViewer {
  private renderer: THREE.WebGLRenderer;
  private frames = 0;
  private sampleAt = performance.now();
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(42, 1, 0.01, 100);
  private controls: OrbitControls;
  private cloud?: GaussianCloud;
  private sortTimer = 0;
  private mesh?: THREE.Mesh<
    THREE.InstancedBufferGeometry,
    THREE.ShaderMaterial
  >;
  private raf = 0;
  constructor(
    private host: HTMLElement,
    onAngle: (degrees: number) => void,
    private onFps?: (fps: number) => void,
  ) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      alpha: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(0x121018, 1);
    host.append(this.renderer.domElement);
    this.camera.position.set(0, 0, 3.5);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.addEventListener("change", () => {
      const d = this.camera.position
        .clone()
        .sub(this.controls.target)
        .normalize();
      onAngle(
        THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(d.z, -1, 1))),
      );
      if (this.cloud) this.scheduleSort();
    });
    new ResizeObserver(() => this.resize()).observe(host);
    this.loop();
  }
  setCloud(cloud: GaussianCloud) {
    this.cloud = cloud;
    const order = this.order();
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
    }
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(
        [-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1],
        2,
      ),
    );
    geometry.setAttribute(
      "splatPosition",
      new THREE.InstancedBufferAttribute(reorder(cloud.position, 3, order), 3),
    );
    geometry.setAttribute(
      "splatScale",
      new THREE.InstancedBufferAttribute(reorder(cloud.scale, 3, order), 3),
    );
    geometry.setAttribute(
      "splatRotation",
      new THREE.InstancedBufferAttribute(reorder(cloud.rotation, 4, order), 4),
    );
    geometry.setAttribute(
      "splatColor",
      new THREE.InstancedBufferAttribute(
        reorder(cloud.color, 4, order),
        4,
        true,
      ),
    );
    geometry.setAttribute(
      "splatDepth",
      new THREE.InstancedBufferAttribute(reorder(cloud.depth, 1, order), 1),
    );
    geometry.setAttribute(
      "splatOpacity",
      new THREE.InstancedBufferAttribute(reorder(cloud.opacity, 1, order), 1),
    );
    geometry.setAttribute(
      "splatConfidence",
      new THREE.InstancedBufferAttribute(
        reorder(cloud.confidence, 1, order),
        1,
      ),
    );
    geometry.setAttribute(
      "splatLayer",
      new THREE.InstancedBufferAttribute(reorder(cloud.layer, 1, order), 1),
    );
    geometry.instanceCount = cloud.count;
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
      uniforms: {
        mode: { value: 0 },
        minConfidence: { value: 0 },
        layerFilter: { value: -1 },
        viewport: { value: new THREE.Vector2(1, 1) },
      },
      vertexShader: `
attribute vec3 splatPosition,splatScale;attribute vec4 splatRotation,splatColor;attribute float splatDepth,splatOpacity,splatConfidence,splatLayer;uniform vec2 viewport;uniform float minConfidence,layerFilter;varying vec2 vUv;varying vec4 vColor;varying float vDepth,vConfidence,vLayer,vVisible;
mat3 quat(vec4 q){float x=q.x,y=q.y,z=q.z,w=q.w;return mat3(1.-2.*(y*y+z*z),2.*(x*y+z*w),2.*(x*z-y*w),2.*(x*y-z*w),1.-2.*(x*x+z*z),2.*(y*z+x*w),2.*(x*z+y*w),2.*(y*z-x*w),1.-2.*(x*x+y*y));}
void main(){vUv=position.xy;vColor=splatColor;vColor.a*=splatOpacity;vDepth=splatDepth;vConfidence=splatConfidence;vLayer=splatLayer;vVisible=step(minConfidence,splatConfidence)*(layerFilter<-.5?1.:1.-step(.49,abs(splatLayer-layerFilter)));vec4 center=modelViewMatrix*vec4(splatPosition,1.);mat3 R=mat3(modelViewMatrix)*quat(normalize(splatRotation));mat3 V=R*mat3(splatScale.x*splatScale.x,0,0,0,splatScale.y*splatScale.y,0,0,0,splatScale.z*splatScale.z)*transpose(R);float f=projectionMatrix[1][1]*viewport.y*.5;float iz=1./max(.01,-center.z);mat3 J=mat3(f*iz,0,0,0,f*iz,0,-f*center.x*iz*iz,-f*center.y*iz*iz,0);mat3 C=J*V*transpose(J);float a=C[0][0]+.3,b=C[0][1],d=C[1][1]+.3;float mid=.5*(a+d),disc=sqrt(max(.0,.25*(a-d)*(a-d)+b*b));float l1=max(.2,mid+disc),l2=max(.2,mid-disc);vec2 axis1=normalize(abs(b)>.00001?vec2(b,l1-a):vec2(1,0));vec2 axis2=vec2(-axis1.y,axis1.x);vec2 pixel=(axis1*sqrt(l1)*position.x+axis2*sqrt(l2)*position.y)*3.;vec4 clip=projectionMatrix*center;clip.xy+=pixel/viewport*2.*clip.w;gl_Position=clip;}
`,
      fragmentShader: `precision highp float;uniform int mode;varying vec2 vUv;varying vec4 vColor;varying float vDepth,vConfidence,vLayer,vVisible;void main(){if(vVisible<.5)discard;float alpha=exp(-.5*dot(vUv,vUv)*9.)*vColor.a;if(alpha<.004)discard;vec3 c=vColor.rgb;if(mode==1)c=mix(vec3(.16,.08,.48),vec3(.18,1.,.72),clamp(vDepth*3.+.5,0.,1.));else if(mode==2)c=vec3(vColor.a);else if(mode==3)c=mix(vec3(1.,.12,.22),vec3(.2,1.,.55),vConfidence);else if(mode==4)c=vLayer<.5?vec3(.2,1.,.65):vLayer<1.5?vec3(1.,.55,.2):vec3(.7,.48,1.);gl_FragColor=vec4(c,alpha);}`,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
    this.resize();
  }
  private order() {
    if (!this.cloud) return new Uint32Array();
    const direction = new THREE.Vector3();
    this.camera.getWorldDirection(direction);
    return depthSortIndices(
      this.cloud.position,
      this.camera.position.toArray() as [number, number, number],
      direction.toArray() as [number, number, number],
    );
  }
  private scheduleSort() {
    clearTimeout(this.sortTimer);
    this.sortTimer = window.setTimeout(() => this.sort(), 40);
  }
  private sort() {
    if (!this.cloud || !this.mesh) return;
    const order = this.order(),
      attributes = this.mesh.geometry.attributes;
    const update = (
      name: string,
      data: Float32Array | Uint8Array,
      size: number,
    ) => {
      const attribute = attributes[name] as THREE.InstancedBufferAttribute;
      attribute.array = reorder(data, size, order);
      attribute.needsUpdate = true;
    };
    update("splatPosition", this.cloud.position, 3);
    update("splatScale", this.cloud.scale, 3);
    update("splatRotation", this.cloud.rotation, 4);
    update("splatColor", this.cloud.color, 4);
    update("splatDepth", this.cloud.depth, 1);
    update("splatOpacity", this.cloud.opacity, 1);
    update("splatConfidence", this.cloud.confidence, 1);
    update("splatLayer", this.cloud.layer, 1);
  }
  setMode(mode: RenderMode) {
    if (this.mesh)
      this.mesh.material.uniforms.mode.value = {
        color: 0,
        depth: 1,
        opacity: 2,
        confidence: 3,
        source: 4,
      }[mode];
  }
  setMinConfidence(v: number) {
    if (this.mesh) this.mesh.material.uniforms.minConfidence.value = v;
  }
  setLayer(layer: number) {
    if (this.mesh) this.mesh.material.uniforms.layerFilter.value = layer;
  }
  setVisible(v: boolean) {
    this.renderer.domElement.hidden = !v;
  }
  reset() {
    this.camera.position.set(0, 0, 3.5);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }
  private resize() {
    const w = this.host.clientWidth,
      h = this.host.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.mesh?.material.uniforms.viewport.value.set(
      w * this.renderer.getPixelRatio(),
      h * this.renderer.getPixelRatio(),
    );
  }
  private loop = () => {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.frames++;
    const now = performance.now();
    if (now - this.sampleAt >= 1000) {
      this.onFps?.((this.frames * 1000) / (now - this.sampleAt));
      this.frames = 0;
      this.sampleAt = now;
    }
    this.raf = requestAnimationFrame(this.loop);
  };
  dispose() {
    clearTimeout(this.sortTimer);
    cancelAnimationFrame(this.raf);
    this.controls.dispose();
    this.renderer.dispose();
  }
}
