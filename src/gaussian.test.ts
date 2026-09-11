import { describe, expect, it } from 'vitest';
import { imageToCloud } from './gaussian';
import { exportPly, exportSplat } from './exporters';

const landmarks=Array.from({length:33},(_,i)=>({x:.25+(i%2)*.5,y:.1+(i%5)*.2,z:(i%3)*.05,visibility:1}));
const pixels=new Uint8ClampedArray([255,255,255,255,20,40,80,255,0,0,0,0,200,100,50,255]);
const pose=(mask:Float32Array)=>({landmarks,worldLandmarks:landmarks,mask,maskWidth:2,maskHeight:2});
const cloud=imageToCloud({data:pixels,width:2,height:2} as ImageData,{maxSplats:12,depthStrength:1,alphaThreshold:8},pose(new Float32Array([0,1,0,1])));

describe('pose-guided Gaussian pipeline',()=>{
  it('only emits masked person pixels and creates front, middle and rear surfaces',()=>{expect(cloud.count).toBe(6);expect([...cloud.position].every(Number.isFinite)).toBe(true);expect(cloud.position[2]).toBeGreaterThan(cloud.position[5]);expect(cloud.position[5]).toBeGreaterThan(cloud.position[8]);});
  it('never exceeds the requested splat budget',()=>{const limited=imageToCloud({data:pixels,width:2,height:2} as ImageData,{maxSplats:4,depthStrength:1,alphaThreshold:8},pose(new Float32Array([1,1,1,1])));expect(limited.count).toBeLessThanOrEqual(4);});
  it('rejects an incomplete skeleton instead of using a cylindrical fallback',()=>{expect(()=>imageToCloud({data:pixels,width:2,height:2} as ImageData,{maxSplats:12,depthStrength:1,alphaThreshold:8},{...pose(new Float32Array([1,1,1,1])),landmarks:landmarks.slice(0,10)})).toThrow('人体骨格が不完全');});
  it('writes interoperable binary exports',async()=>{expect(exportSplat(cloud).size).toBe(cloud.count*32);const ply=exportPly(cloud),text=await ply.slice(0,700).text();expect(text).toContain('property float depth');expect(text).toContain('property float confidence');});
});
