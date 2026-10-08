import test from 'node:test';
import assert from 'node:assert/strict';
import {projectSpacePoint,normalizeSpaceCamera} from '../src/knowledge-space.mjs';
import {wheelZoomDelta,zoomSpaceCameraAt,queueSpaceWheelZoom,advanceSpaceWheelZoom} from '../src/graph-camera.mjs';
const viewport={width:920,height:600};

test('cursor-anchored zoom preserves the same projected world point through perspective and pan',()=>{
  for(const camera of [{yaw:.4,pitch:.5,zoom:1.5,panX:70,panY:-40},{yaw:2.3,pitch:2.1,zoom:4,panX:-300,panY:200}]){
    const point={x:92,y:-37,z:58},anchor=projectSpacePoint(point,camera,viewport);
    for(const zoom of [.35,2,16,64]){
      const next=projectSpacePoint(point,zoomSpaceCameraAt(camera,zoom,anchor,viewport),viewport);
      assert.ok(Math.hypot(next.x-anchor.x,next.y-anchor.y)<1e-8);
    }
  }
});
test('pixel, line and page wheel units are normalized; zero and nonfinite deltas do not zoom',()=>{
  assert.equal(wheelZoomDelta({deltaY:16,deltaMode:0},viewport),wheelZoomDelta({deltaY:1,deltaMode:1},viewport));
  assert.equal(wheelZoomDelta({deltaY:.1,deltaMode:2},viewport),wheelZoomDelta({deltaY:60,deltaMode:0},viewport));
  assert.equal(wheelZoomDelta({deltaY:0},viewport),0);
  assert.equal(wheelZoomDelta({deltaY:NaN},viewport),0);
  assert.equal(wheelZoomDelta({deltaY:1e9},viewport),-.55);
});
test('wheel frames interpolate monotonically, preserve the anchor each frame, and stop when settled',()=>{
  let camera=normalizeSpaceCamera({yaw:.3,pitch:-.6,zoom:1.3,panX:60,panY:-30});
  const point={x:60,y:80,z:120},anchor=projectSpacePoint(point,camera,viewport),original=camera.zoom;
  let pending=queueSpaceWheelZoom(camera,null,{deltaY:-240},anchor,viewport),target=pending.targetZoom,frames=0;
  for(let time=0;pending&&time<2000;time+=1000/60){
    const before=camera.zoom,result=advanceSpaceWheelZoom(camera,pending,time);camera=result.camera;pending=result.pending;frames++;
    assert.ok(camera.zoom>=before&&camera.zoom<=target+1e-12);
    const next=projectSpacePoint(point,camera,viewport);assert.ok(Math.hypot(next.x-anchor.x,next.y-anchor.y)<1e-8);
    if(frames===1)assert.ok(camera.zoom>original&&camera.zoom<target);
  }
  assert.equal(pending,null);assert.equal(camera.zoom,target);assert.ok(frames>2&&frames<50);
});
test('rapid events accumulate a bounded target and changing pointer rebases subsequent frames',()=>{
  let camera=normalizeSpaceCamera({zoom:1}),pending=null;
  for(let i=0;i<12;i++)pending=queueSpaceWheelZoom(camera,pending,{deltaY:-40},{x:400,y:250},viewport);
  assert.ok(pending.targetZoom>1&&pending.targetZoom<64);
  ({camera,pending}=advanceSpaceWheelZoom(camera,pending,16));
  const point={x:24,y:17,z:32},anchor=projectSpacePoint(point,camera,viewport);
  pending=queueSpaceWheelZoom(camera,pending,{deltaY:-30},anchor,viewport);
  ({camera}=advanceSpaceWheelZoom(camera,pending,32));
  const next=projectSpacePoint(point,camera,viewport);assert.ok(Math.hypot(next.x-anchor.x,next.y-anchor.y)<1e-8);
  let maximum=null;for(let i=0;i<100;i++)maximum=queueSpaceWheelZoom(normalizeSpaceCamera({zoom:1}),maximum,{deltaY:-1000},anchor,viewport);
  assert.equal(maximum.targetZoom,64);
});
test('reduced motion completes the same anchored transform without an animation loop',()=>{
  const camera=normalizeSpaceCamera({zoom:2}),anchor={x:220,y:150};
  const pending=queueSpaceWheelZoom(camera,null,{deltaY:100},anchor,viewport,{reducedMotion:true});
  const result=advanceSpaceWheelZoom(camera,pending,0);
  assert.equal(result.pending,null);assert.equal(result.camera.zoom,pending.targetZoom);
  assert.deepEqual(result.camera,zoomSpaceCameraAt(camera,pending.targetZoom,anchor,viewport));
});
