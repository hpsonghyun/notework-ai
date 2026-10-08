import {normalizeSpaceCamera} from './knowledge-space.mjs';

const finite=(value,fallback=0)=>Number.isFinite(value)?value:fallback;
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));

export function wheelZoomDelta(event,viewport){
  const raw=finite(event.deltaY);
  if(!raw)return 0;
  const pixels=raw*(event.deltaMode===1?16:event.deltaMode===2?Math.max(1,finite(viewport.height,440)):1);
  return clamp(-pixels*.0016,-.55,.55);
}

/** Perspective projection is linear in zoom after rotation: compensate its screen pan
 * so the point beneath the cursor remains stationary at every animation frame. */
export function zoomSpaceCameraAt(camera,nextZoom,anchor,viewport){
  const previous=normalizeSpaceCamera(camera),next=normalizeSpaceCamera({...previous,zoom:nextZoom});
  const x=finite(anchor?.x,viewport.width/2)-viewport.width/2;
  const y=finite(anchor?.y,viewport.height/2)-viewport.height/2;
  const ratio=next.zoom/previous.zoom;
  return normalizeSpaceCamera({...next,panX:x-(x-previous.panX)*ratio,panY:y-(y-previous.panY)*ratio});
}

export function queueSpaceWheelZoom(camera,pending,event,anchor,viewport,{reducedMotion=false}={}){
  const delta=wheelZoomDelta(event,viewport);
  if(!delta)return pending;
  const current=normalizeSpaceCamera(camera);
  const targetZoom=normalizeSpaceCamera({...current,zoom:(pending?.targetZoom??current.zoom)*Math.exp(delta)}).zoom;
  if(Math.abs(Math.log(targetZoom/current.zoom))<1e-8)return null;
  return{targetZoom,anchor:{x:anchor.x,y:anchor.y},viewport:{width:viewport.width,height:viewport.height},lastTime:pending?.lastTime??null,reducedMotion};
}

export function advanceSpaceWheelZoom(camera,pending,time){
  if(!pending)return{camera:normalizeSpaceCamera(camera),pending:null};
  const current=normalizeSpaceCamera(camera),distance=Math.log(pending.targetZoom/current.zoom);
  const elapsed=pending.lastTime===null?1000/60:clamp(finite(time-pending.lastTime,1000/60),1,50);
  const done=pending.reducedMotion||Math.abs(distance)<.0005;
  const zoom=done?pending.targetZoom:current.zoom*Math.exp(distance*(1-Math.exp(-elapsed/65)));
  return{camera:zoomSpaceCameraAt(current,zoom,pending.anchor,pending.viewport),pending:done?null:{...pending,lastTime:time}};
}
