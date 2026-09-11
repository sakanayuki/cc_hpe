import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { PoseGuidance } from './pose';

type LandmarkSet = readonly number[];
type BoneRule = { name:string; from:LandmarkSet; to:LandmarkSet };

// Parent bones must precede children because every target is transformed into parent-local space.
const RULES:BoneRule[]=[
  {name:'mixamorig:Spine2',from:[23,24],to:[11,12]},
  {name:'mixamorig:Neck',from:[11,12],to:[0]},
  {name:'mixamorig:LeftArm',from:[11],to:[13]},{name:'mixamorig:LeftForeArm',from:[13],to:[15]},
  {name:'mixamorig:RightArm',from:[12],to:[14]},{name:'mixamorig:RightForeArm',from:[14],to:[16]},
  {name:'mixamorig:LeftUpLeg',from:[23],to:[25]},{name:'mixamorig:LeftLeg',from:[25],to:[27]},
  {name:'mixamorig:RightUpLeg',from:[24],to:[26]},{name:'mixamorig:RightLeg',from:[26],to:[28]},
];

export const EDITABLE_BONES=RULES.filter(({name})=>!name.includes('Spine')&&!name.includes('Neck')).map(({name})=>name);

function average(indices:LandmarkSet,pose:PoseGuidance,depthScale:number):THREE.Vector3{
  const value=new THREE.Vector3();
  for(const index of indices){const point=pose.worldLandmarks[index];value.add(new THREE.Vector3(point.x,-point.y,-point.z*depthScale));}
  return value.multiplyScalar(1/indices.length);
}

export function poseDirection(from:LandmarkSet,to:LandmarkSet,pose:PoseGuidance,depthScale=1):THREE.Vector3{
  return average(to,pose,depthScale).sub(average(from,pose,depthScale)).normalize();
}

export class BodyViewer{
  private readonly scene=new THREE.Scene();
  private readonly camera=new THREE.PerspectiveCamera(38,1,.01,100);
  private readonly renderer:THREE.WebGLRenderer;
  private readonly controls:OrbitControls;
  private model?:THREE.Object3D;
  private baseScale=1;
  private pose?:PoseGuidance;
  private readonly posedRotations=new Map<string,THREE.Quaternion>();
  private readonly corrections=new Map<string,THREE.Euler>();
  private frame=0;

  constructor(private readonly host:HTMLElement){
    this.renderer=new THREE.WebGLRenderer({antialias:true,alpha:true});this.renderer.setPixelRatio(Math.min(devicePixelRatio,2));this.renderer.setClearColor(0x121018,1);this.renderer.outputColorSpace=THREE.SRGBColorSpace;host.append(this.renderer.domElement);
    this.camera.position.set(0,0,3.5);this.controls=new OrbitControls(this.camera,this.renderer.domElement);this.controls.enableDamping=true;
    this.scene.add(new THREE.HemisphereLight(0xffffff,0x30253d,2.2));const key=new THREE.DirectionalLight(0xffffff,2.5);key.position.set(2,3,3);this.scene.add(key);
    new ResizeObserver(()=>this.resize()).observe(host);this.loop();
  }

  async showPose(pose:PoseGuidance,depthScale=1):Promise<void>{
    if(!this.model){const gltf=await new GLTFLoader().loadAsync(`${import.meta.env.BASE_URL}runtime/body.glb`);this.model=gltf.scene;this.scene.add(this.model);this.fit();}
    this.pose=pose;this.posedRotations.clear();
    this.model.updateWorldMatrix(true,true);
    for(const rule of RULES){
      const bone=this.model.getObjectByName(rule.name) as THREE.Bone|undefined;if(!bone||!bone.children[0])continue;
      const direction=poseDirection(rule.from,rule.to,pose,depthScale);
      const parentWorld=new THREE.Quaternion();bone.parent?.getWorldQuaternion(parentWorld);
      const localDirection=direction.applyQuaternion(parentWorld.invert());
      const restDirection=bone.children[0].position.clone().normalize();
      bone.quaternion.setFromUnitVectors(restDirection,localDirection);bone.updateWorldMatrix(false,true);
      this.posedRotations.set(rule.name,bone.quaternion.clone());
    }
    this.applyCorrections();
  }

  setDepthScale(value:number):void{if(this.pose)void this.showPose(this.pose,value);}
  setBodyWidth(value:number):void{if(this.model)this.model.scale.set(this.baseScale*value,this.baseScale,this.baseScale);}
  setJointCorrection(name:string,x:number,y:number,z:number):void{this.corrections.set(name,new THREE.Euler(THREE.MathUtils.degToRad(x),THREE.MathUtils.degToRad(y),THREE.MathUtils.degToRad(z),'XYZ'));this.applyCorrections();}
  captureDepth(size=512):Float32Array{
    const target=new THREE.WebGLRenderTarget(size,size,{type:THREE.UnsignedByteType,format:THREE.RGBAFormat});
    const camera=new THREE.OrthographicCamera(-1.15,1.15,1.15,-1.15,.1,10);camera.position.set(0,0,3.5);camera.lookAt(0,0,0);
    const previous=this.scene.overrideMaterial;this.scene.overrideMaterial=new THREE.MeshDepthMaterial({depthPacking:THREE.RGBADepthPacking});
    this.renderer.setRenderTarget(target);this.renderer.clear();this.renderer.render(this.scene,camera);
    const rgba=new Uint8Array(size*size*4);this.renderer.readRenderTargetPixels(target,0,0,size,size,rgba);this.renderer.setRenderTarget(null);this.scene.overrideMaterial=previous;target.dispose();
    const result=new Float32Array(size*size);
    for(let y=0;y<size;y++)for(let x=0;x<size;x++){const source=((size-1-y)*size+x)*4,destination=y*size+x;result[destination]=(rgba[source]/255)/(256**3)+(rgba[source+1]/255)/(256**2)+(rgba[source+2]/255)/256+rgba[source+3]/255;}
    return result;
  }
  reset():void{this.camera.position.set(0,0,3.5);this.controls.target.set(0,0,0);this.controls.update();}
  private applyCorrections():void{if(!this.model)return;for(const [name,rotation] of this.posedRotations){const bone=this.model.getObjectByName(name);if(!bone)continue;bone.quaternion.copy(rotation);const correction=this.corrections.get(name);if(correction)bone.quaternion.multiply(new THREE.Quaternion().setFromEuler(correction));}this.model.updateWorldMatrix(true,true);}
  private fit():void{if(!this.model)return;const box=new THREE.Box3().setFromObject(this.model),size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3());this.model.position.sub(center);this.baseScale=2/Math.max(size.x,size.y,size.z);this.model.scale.setScalar(this.baseScale);this.reset();}
  private resize():void{const w=this.host.clientWidth,h=this.host.clientHeight;this.camera.aspect=w/Math.max(1,h);this.camera.updateProjectionMatrix();this.renderer.setSize(w,h,false);}
  private loop=():void=>{this.controls.update();this.renderer.render(this.scene,this.camera);this.frame=requestAnimationFrame(this.loop);};
  setVisible(value:boolean):void{this.renderer.domElement.hidden=!value;}
  isVisible():boolean{return !this.renderer.domElement.hidden;}
  dispose():void{cancelAnimationFrame(this.frame);this.controls.dispose();this.renderer.dispose();}
}
