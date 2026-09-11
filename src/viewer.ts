import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { GaussianCloud } from './gaussian';

export type RenderMode = 'color' | 'depth' | 'opacity' | 'confidence';

export class SplatViewer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(42, 1, 0.01, 100);
  private readonly controls: OrbitControls;
  private points?: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private raf = 0;

  constructor(private readonly host: HTMLElement, onAngle: (degrees: number) => void) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(0x121018, 1);
    host.append(this.renderer.domElement);
    this.camera.position.set(0, 0, 3.5);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.addEventListener('change', () => {
      const direction = this.camera.position.clone().normalize();
      onAngle(THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(direction.z, -1, 1))));
    });
    new ResizeObserver(() => this.resize()).observe(host);
    this.loop();
  }

  setCloud(cloud: GaussianCloud): void {
    if (this.points) { this.scene.remove(this.points); this.points.geometry.dispose(); this.points.material.dispose(); }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(cloud.position, 3));
    geometry.setAttribute('splatColor', new THREE.BufferAttribute(cloud.color, 4, true));
    geometry.setAttribute('splatDepth', new THREE.BufferAttribute(cloud.depth, 1));
    geometry.setAttribute('splatOpacity', new THREE.BufferAttribute(cloud.opacity, 1));
    geometry.setAttribute('splatConfidence', new THREE.BufferAttribute(cloud.confidence, 1));
    const material = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, vertexColors: true,
      uniforms: { mode: { value: 0 }, pointScale: { value: 2.2 } },
      vertexShader: `attribute vec4 splatColor; attribute float splatDepth; attribute float splatOpacity; attribute float splatConfidence; varying vec4 vColor; varying float vDepth; varying float vConfidence; uniform float pointScale; void main(){vColor=splatColor;vDepth=splatDepth;vConfidence=splatConfidence;vec4 mv=modelViewMatrix*vec4(position,1.);gl_Position=projectionMatrix*mv;gl_PointSize=clamp(pointScale*300./-mv.z,1.,12.);}`,
      fragmentShader: `precision highp float; varying vec4 vColor; varying float vDepth; varying float vConfidence; uniform int mode; void main(){vec2 q=gl_PointCoord-.5;float a=exp(-dot(q,q)*12.)*vColor.a;if(a<.02)discard;vec3 c=vColor.rgb;if(mode==1)c=mix(vec3(.18,.1,.5),vec3(.2,1.,.75),clamp(vDepth*4.,0.,1.));if(mode==2)c=vec3(vColor.a);if(mode==3)c=mix(vec3(.95,.18,.25),vec3(.25,1.,.62),vConfidence);gl_FragColor=vec4(c,a);}` });
    this.points = new THREE.Points(geometry, material);
    this.scene.add(this.points);
  }

  setMode(mode: RenderMode): void {
    if (!this.points) return;
    this.points.material.uniforms.mode.value = { color: 0, depth: 1, opacity: 2, confidence: 3 }[mode];
  }

  setVisible(value: boolean): void { this.renderer.domElement.hidden = !value; }

  reset(): void {
    this.camera.position.set(0, 0, 3.5);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  private resize(): void { const w=this.host.clientWidth,h=this.host.clientHeight; this.camera.aspect=w/Math.max(1,h);this.camera.updateProjectionMatrix();this.renderer.setSize(w,h,false); }
  private loop = (): void => { this.controls.update();this.renderer.render(this.scene,this.camera);this.raf=requestAnimationFrame(this.loop); };
  dispose(): void { cancelAnimationFrame(this.raf);this.controls.dispose();this.renderer.dispose(); }
}
