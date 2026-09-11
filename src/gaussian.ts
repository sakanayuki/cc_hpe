import type { PoseGuidance } from './pose';

export interface GaussianCloud {
  count: number; position: Float32Array; scale: Float32Array; rotation: Float32Array;
  color: Uint8Array; opacity: Float32Array; depth: Float32Array; confidence: Float32Array;
}
export interface BuildOptions { maxSplats: number; depthStrength: number; alphaThreshold: number }

const BONES = [[0,11],[0,12],[11,12],[11,23],[12,24],[23,24],[11,13],[13,15],[12,14],[14,16],[23,25],[25,27],[24,26],[26,28]] as const;

function maskAt(pose: PoseGuidance, x:number, y:number, width:number, height:number): number {
  const mx=Math.min(pose.maskWidth-1,Math.floor(x/width*pose.maskWidth));
  const my=Math.min(pose.maskHeight-1,Math.floor(y/height*pose.maskHeight));
  return pose.mask[my*pose.maskWidth+mx];
}

function distanceField(pose: PoseGuidance): Float32Array {
  const w=pose.maskWidth,h=pose.maskHeight,d=new Float32Array(w*h),diag=Math.SQRT2;
  for(let i=0;i<d.length;i++) d[i]=pose.mask[i]>.35?1e4:0;
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){const i=y*w+x;if(!d[i])continue;if(x)d[i]=Math.min(d[i],d[i-1]+1);if(y)d[i]=Math.min(d[i],d[i-w]+1);if(x&&y)d[i]=Math.min(d[i],d[i-w-1]+diag);if(x+1<w&&y)d[i]=Math.min(d[i],d[i-w+1]+diag);}
  for(let y=h-1;y>=0;y--) for(let x=w-1;x>=0;x--){const i=y*w+x;if(!d[i])continue;if(x+1<w)d[i]=Math.min(d[i],d[i+1]+1);if(y+1<h)d[i]=Math.min(d[i],d[i+w]+1);if(x+1<w&&y+1<h)d[i]=Math.min(d[i],d[i+w+1]+diag);if(x&&y+1<h)d[i]=Math.min(d[i],d[i+w-1]+diag);}
  return d;
}

function skeletalDepth(x:number,y:number,pose:PoseGuidance): {z:number;confidence:number} {
  let sum=0,weight=0;
  for(const [ai,bi] of BONES){const a=pose.landmarks[ai],b=pose.landmarks[bi];if(!a||!b||Math.min(a.visibility??1,b.visibility??1)<.25)continue;const vx=b.x-a.x,vy=b.y-a.y,l=Math.max(1e-6,vx*vx+vy*vy);const t=Math.max(0,Math.min(1,((x-a.x)*vx+(y-a.y)*vy)/l));const dx=x-(a.x+vx*t),dy=y-(a.y+vy*t);const w=Math.exp(-(dx*dx+dy*dy)/.006)*Math.min(a.visibility??1,b.visibility??1);sum+=-(a.z+(b.z-a.z)*t)*w;weight+=w;}
  return {z:weight>1e-5?sum/weight:0,confidence:Math.min(1,weight)};
}

/** Pose and silhouette conditioned closed proxy; no background fallback is allowed. */
export function imageToCloud(image:ImageData, options:BuildOptions, pose:PoseGuidance):GaussianCloud {
  if(pose.landmarks.length<29) throw new Error('人体骨格が不完全なため立体化できません。');
  const {width,height,data}=image,candidates:number[]=[];
  for(let i=0;i<width*height;i++){const x=i%width,y=Math.floor(i/width);if(data[i*4+3]>=options.alphaThreshold&&maskAt(pose,x,y,width,height)>.35)candidates.push(i);}
  if(!candidates.length) throw new Error('人物領域を抽出できませんでした。');
  const layers=Math.max(1,Math.min(3,Math.floor(options.maxSplats))),budget=Math.max(1,Math.floor(options.maxSplats/layers));
  const stride=Math.max(1,Math.ceil(candidates.length/budget)),count=Math.ceil(candidates.length/stride)*layers;
  const position=new Float32Array(count*3),scale=new Float32Array(count*3),rotation=new Float32Array(count*4),color=new Uint8Array(count*4),opacity=new Float32Array(count),depth=new Float32Array(count),confidence=new Float32Array(count);
  const distances=distanceField(pose),aspect=width/height,pixelScale=2/height*Math.sqrt(stride)*.72;let out=0;
  for(let source=0;source<candidates.length;source+=stride){const index=candidates[source],x=index%width,y=Math.floor(index/width),nx=x/Math.max(1,width-1)*2-1,ny=y/Math.max(1,height-1)*2-1,mx=Math.min(pose.maskWidth-1,Math.floor(x/width*pose.maskWidth)),my=Math.min(pose.maskHeight-1,Math.floor(y/height*pose.maskHeight));const half=Math.min(.22,Math.max(.012,distances[my*pose.maskWidth+mx]/pose.maskHeight*1.8))*options.depthStrength,bone=skeletalDepth(x/width,y/height,pose),center=bone.z*.65*options.depthStrength,alpha=maskAt(pose,x,y,width,height)*data[index*4+3]/255,offsets=layers===1?[0]:layers===2?[.9,-.9]:[.9,0,-.9];
    for(const factor of offsets){const z=center+factor*half,shade=factor>0?1:factor<0?.64:.82;position.set([nx*aspect,-ny,z],out*3);scale.set([pixelScale,pixelScale,factor===0?half*.65:pixelScale*.7],out*3);rotation.set([0,0,0,1],out*4);color.set([Math.round(data[index*4]*shade),Math.round(data[index*4+1]*shade),Math.round(data[index*4+2]*shade),Math.round(alpha*255)],out*4);opacity[out]=alpha*(factor===0?.42:.92);depth[out]=z;confidence[out]=Math.min(1,alpha*.65+bone.confidence*.35);out++;}}
  return {count,position,scale,rotation,color,opacity,depth,confidence};
}
