const PALETTE=[[119,188,239],[119,214,185],[237,185,112],[187,160,236],[239,155,170],[169,210,130],[221,170,225],[130,207,225]];
const ROLE_COLORS={knowledge:PALETTE[0],reference:PALETTE[3],action:PALETTE[1],decision:PALETTE[2],other:[168,193,207]};
const CYAN=[90,224,239];
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
function seed(text){let value=2166136261;for(const character of String(text)){value^=character.codePointAt(0);value=Math.imul(value,16777619);}return value>>>0;}
/** A saved topic or role keeps its color when its position, scope or level changes. */
export function knowledgeGroupColor(id,{label=id,kind='category'}={}){
  const identity=String(label||id||'Notes').normalize('NFC').trim().replace(/\s+/g,' ').toLocaleLowerCase();
  const role=String(id||identity).toLocaleLowerCase();
  if(kind==='role'&&ROLE_COLORS[role])return [...ROLE_COLORS[role]];
  // Hash hue continuously: a short palette repeats unrelated saved categories.
  const hue=random(kind+'\u001f'+identity)()*6,saturation=.58,lightness=.70,chroma=(1-Math.abs(2*lightness-1))*saturation,secondary=chroma*(1-Math.abs(hue%2-1)),offset=lightness-chroma/2;
  const channels=hue<1?[chroma,secondary,0]:hue<2?[secondary,chroma,0]:hue<3?[0,chroma,secondary]:hue<4?[0,secondary,chroma]:hue<5?[secondary,0,chroma]:[chroma,0,secondary];
  return channels.map(value=>Math.round((value+offset)*255));
}
function random(text){let value=seed(text)||1;return()=>{value^=value<<13;value^=value>>>17;value^=value<<5;return(value>>>0)/4294967296;};}
const GOLDEN_ANGLE=2.399963229728653;
function sphereOffset(at,count,key,radius){
  // With fewer than four notes a full volume is impossible. Balanced shapes
  // still expose depth on every axis instead of an accidentally flat sample.
  const small=count===2?[[1,1,1],[-1,-1,-1]]:count===3?[[1,-1,0],[0,1,-1],[-1,0,1]]:count===4?[[1,1,1],[1,-1,-1],[-1,1,-1],[-1,-1,1]]:null;
  if(small){const point=small[at],scale=radius*.82/Math.hypot(...point);return{x:point[0]*scale,y:point[1]*scale,z:point[2]*scale};}
  if(count===1)return{x:0,y:0,z:0};
  const phase=seed(key)/4294967296,y=1-2*(at+.5)/count,theta=at*GOLDEN_ANGLE+phase*Math.PI*2,ring=Math.sqrt(Math.max(0,1-y*y));
  // Independent low-discrepancy radial ranks fill the ball, not just its shell.
  const radial=(at*.7548776662466927+phase)%1,distance=radius*(.12+.82*Math.cbrt(radial));
  return{x:ring*Math.cos(theta)*distance,y:y*distance,z:ring*Math.sin(theta)*distance};
}
function layer(node){return String(node.layer?.label??node.layer??'Notes');}
function category(node){return String(node.categoryId??node.category??'Notes');}
const LEVELS=[{id:'overview',label:'Level 1 · Overview',depth:0},{id:'topic',label:'Level 2 · Topic',depth:1},{id:'detail',label:'Level 3 · Detail',depth:2},{id:'unassigned',label:'Unassigned',depth:3}];
export function hierarchyLevelOf(node){return LEVELS.some(level=>level.id===node.hierarchyLevel)?node.hierarchyLevel:'unassigned';}
export function knowledgeHierarchyLevels(index,nodes=index.nodes||[]){return LEVELS.map(level=>{const saved=(index.hierarchyLevels||[]).find(item=>item.id===level.id);return{...level,description:saved?.description||'',count:nodes.filter(node=>hierarchyLevelOf(node)===level.id).length};});}
const angle=value=>value>=-Math.PI&&value<Math.PI?value:((value+Math.PI)%(Math.PI*2)+Math.PI*2)%(Math.PI*2)-Math.PI;
export const DEFAULT_SPACE_CAMERA=Object.freeze({yaw:-.18,pitch:.16,zoom:1,panX:0,panY:0});
export function normalizeSpaceCamera(value={}){const read=(key,fallback)=>Number.isFinite(value[key])?value[key]:fallback;return{yaw:angle(read('yaw',DEFAULT_SPACE_CAMERA.yaw)),pitch:angle(read('pitch',DEFAULT_SPACE_CAMERA.pitch)),zoom:clamp(read('zoom',1),.35,64),panX:clamp(read('panX',0),-100000,100000),panY:clamp(read('panY',0),-100000,100000)};}
/** Stable 3D regions and stars derived solely from the actual selected index. */
export function createKnowledgeSpace(index,nodes,{groupBy='hierarchy'}={}){
  const labels=new Map((groupBy==='categories'?index.categories||[]:index.layers||[]).map(item=>[String(item.id),String(item.label||item.id)]));const groups=new Map();
  const hierarchical=groupBy==='hierarchy',levels=knowledgeHierarchyLevels(index,nodes).filter(level=>level.count),topicLabels=new Map((index.categories||[]).map(item=>[String(item.id),String(item.label||item.id)]));
  for(const node of nodes){const key=hierarchical?hierarchyLevelOf(node)+'\u001f'+category(node):groupBy==='categories'?category(node):layer(node);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(node);}
  const keys=[...groups.keys()].sort((a,b)=>a.localeCompare(b));const regions=[];const stars=[];const dust=[];const bands=[];const byId=new Map();
  const radii=new Map(keys.map(key=>[key,hierarchical?Math.min(64,32+Math.sqrt(groups.get(key).length)*1.8):58+Math.min(88,Math.sqrt(groups.get(key).length)*4.4)]));
  const maxRadius=hierarchical?[...radii.values()].reduce((max,value)=>Math.max(max,value),32):0,levelSpacing=maxRadius*2+80;
  for(const level of hierarchical?levels:[]){
    const topicKeys=keys.filter(key=>key.startsWith(level.id+'\u001f')),radius=topicKeys.reduce((max,key)=>Math.max(max,radii.get(key)),32),columns=Math.max(1,Math.ceil(topicKeys.length/Math.min(5,Math.ceil(Math.sqrt(topicKeys.length))))),rows=Math.ceil(topicKeys.length/columns),spacing=radius*2+26,y=(level.depth-1.5)*levelSpacing;
    const halfX=(columns-1)*spacing/2+radius+28,halfZ=(rows-1)*spacing/2+radius+28;
    bands.push({...level,center:{x:0,y,z:0},corners:[{x:-halfX,y,z:-halfZ},{x:halfX,y,z:-halfZ},{x:halfX,y,z:halfZ},{x:-halfX,y,z:halfZ}],labelPoint:{x:-halfX,y:y-radius-23,z:-halfZ},topicKeys,columns,rows,spacing});
  }
  const bandById=new Map(bands.map(band=>[band.id,band])),slotByKey=new Map(bands.flatMap(band=>band.topicKeys.map((key,slot)=>[key,slot])));
  for(let at=0;at<keys.length;at++){
    const key=keys[at],members=groups.get(key).sort((a,b)=>String(a.id).localeCompare(String(b.id)));const orbit=-2.65+at*GOLDEN_ANGLE,ring=keys.length>6?225:185;const levelId=hierarchyLevelOf(members[0]),band=bandById.get(levelId),slot=slotByKey.get(key)||0;const center=hierarchical?{x:band.columns===1?0:(slot%band.columns-(band.columns-1)/2)*band.spacing,y:band.center.y,z:band.rows===1?0:(Math.floor(slot/band.columns)-(band.rows-1)/2)*band.spacing}:keys.length===1?{x:0,y:0,z:0}:{x:Math.cos(orbit)*ring*(.85+(at%3)*.11),y:Math.sin(orbit)*ring*.67,z:Math.sin(at*1.71+.4)*115};const label=hierarchical?topicLabels.get(category(members[0]))||category(members[0]):labels.get(key)||key,colorKind=groupBy==='layers'?'role':'category',colorKey=hierarchical?category(members[0]):key,color=knowledgeGroupColor(colorKey,{label,kind:colorKind}),radius=radii.get(key);regions.push({id:key,label,levelId:hierarchical?levelId:undefined,center,color,colorKey,colorKind,radius,count:members.length});
    for(let memberAt=0;memberAt<members.length;memberAt++){const node=members[memberAt],rng=random(node.id),theta=rng()*Math.PI*2,phi=Math.acos(rng()*2-1),distance=members.length===1?0:radius*(.1+Math.cbrt(rng())*.85),offset=hierarchical?sphereOffset(memberAt,members.length,key,radius):{x:Math.sin(phi)*Math.cos(theta)*distance,y:Math.sin(phi)*Math.sin(theta)*distance*.83,z:Math.cos(phi)*distance*.9};const position={x:center.x+offset.x,y:center.y+offset.y,z:center.z+offset.z};const star={id:String(node.id),node,regionId:key,color,position,radius:.65+rng()*.35};stars.push(star);byId.set(star.id,star);}
  }
  const links=(index.edges||[]).filter(edge=>byId.has(String(edge.source))&&byId.has(String(edge.target))).map(edge=>({source:String(edge.source),target:String(edge.target),kind:edge.kind,label:edge.label,weight:Number.isFinite(edge.weight)?clamp(edge.weight,0,1):.5}));
  // One bounded O(E) pass brings saved relations closer within their actual group.
  const sums=new Map();for(const link of links){const a=byId.get(link.source),b=byId.get(link.target);if(a.regionId!==b.regionId)continue;for(const [star,other]of [[a,b],[b,a]]){let sum=sums.get(star.id);if(!sum){sum={x:0,y:0,z:0,count:0};sums.set(star.id,sum);}for(const axis of ['x','y','z'])sum[axis]+=other.position[axis];sum.count++;}}
  for(const [id,sum]of sums){const point=byId.get(id).position;for(const axis of ['x','y','z'])point[axis]=point[axis]*.82+sum[axis]/sum.count*.18;}
  if(hierarchical){
    // The camera orbits at a fixed distance of 650. Uniform scene scaling keeps
    // even many-category layouts in front of its near plane at every rotation;
    // it preserves spherical clouds and all topic/level clearances.
    let extent=0;const size=point=>Math.hypot(point.x,point.y,point.z);
    for(const region of regions)extent=Math.max(extent,size(region.center)+region.radius);
    for(const band of bands)for(const point of [...band.corners,band.labelPoint])extent=Math.max(extent,size(point));
    const scale=extent>440?440/extent:1;
    if(scale<1){
      const shrink=point=>{point.x*=scale;point.y*=scale;point.z*=scale;};
      for(const region of regions){shrink(region.center);region.radius*=scale;}
      for(const star of stars){shrink(star.position);star.radius*=scale;}
      for(const band of bands){shrink(band.center);for(const point of band.corners)shrink(point);shrink(band.labelPoint);band.spacing*=scale;}
    }
  }
  return{regions,stars,links,bands,dust,background:[],byId,groupBy};
}
/** Perspective projection after two independent camera rotations. */
export function projectSpacePoint(point,camera,viewport){
  return spaceProjector(camera,viewport)(point);
}
function spaceProjector(camera,viewport){camera=normalizeSpaceCamera(camera);const width=Math.max(1,viewport.width),height=Math.max(1,viewport.height),cy=Math.cos(camera.yaw),sy=Math.sin(camera.yaw),cp=Math.cos(camera.pitch),sp=Math.sin(camera.pitch),factor=Math.min(width,height)*1.46*camera.zoom;return point=>{const x=point.x*cy+point.z*sy,z=-point.x*sy+point.z*cy,y=point.y*cp-z*sp,depth=650+point.y*sp+z*cp;if(depth<65)return null;const scale=factor/depth;return{x:width/2+x*scale+camera.panX,y:height/2+y*scale+camera.panY,depth,scale};};}
export function projectKnowledgeSpace(space,camera,viewport){
  const project=spaceProjector(camera,viewport),stars=[],regions=[],bands=[],byId=new Map();for(const star of space.stars){const point=project(star.position);if(!point)continue;const next={...star,...point,screenRadius:clamp(star.radius*point.scale,.55,2.4)};stars.push(next);byId.set(star.id,next);}for(const region of space.regions){const point=project(region.center);if(point)regions.push({...region,...point,screenRadius:region.radius*point.scale});}for(const band of space.bands||[]){const corners=band.corners.map(project),label=project(band.labelPoint);if(label&&corners.every(Boolean))bands.push({...band,corners,labelPosition:label});}return{stars,regions,bands,dust:[],background:[],byId};
}
/** Fit actual visible note centers; region mist and hierarchy guides do not set the zoom. */
export function frameKnowledgeSpace(space,viewport,camera=DEFAULT_SPACE_CAMERA){
  const width=Math.max(1,Number.isFinite(viewport.width)?viewport.width:1),height=Math.max(1,Number.isFinite(viewport.height)?viewport.height:1);
  const base=normalizeSpaceCamera({...camera,zoom:1,panX:0,panY:0}),project=spaceProjector(base,{width,height});let left=Infinity,right=-Infinity,top=Infinity,bottom=-Infinity,scale=0,count=0;
  for(const star of space.stars||[]){const point=project(star.position);if(!point||!Number.isFinite(point.x)||!Number.isFinite(point.y))continue;left=Math.min(left,point.x);right=Math.max(right,point.x);top=Math.min(top,point.y);bottom=Math.max(bottom,point.y);scale+=point.scale;count++;}
  if(!count)return normalizeSpaceCamera(camera);
  let spanX=right-left,spanY=bottom-top;
  // A single point has no extent to fit. Give its local neighborhood a finite scale.
  if(Math.max(spanX,spanY)<1e-6)spanX=spanY=Math.max(1,scale/count*48);
  const padding=Math.min(32,Math.max(14,Math.min(width,height)*.06));
  const zoom=normalizeSpaceCamera({...base,zoom:Math.min(Math.max(1,width-padding*2)/Math.max(1e-6,spanX),Math.max(1,height-padding*2)/Math.max(1e-6,spanY))}).zoom;
  return normalizeSpaceCamera({...base,zoom,panX:(width/2-(left+right)/2)*zoom,panY:(height/2-(top+bottom)/2)*zoom});
}
/** Clicks are resolved against the same projected positions used for drawing. */
export function hitTestKnowledgeStar(projected,x,y,{radius=13}={}){let match=null,distance=Infinity;for(const star of projected.stars){const next=(star.x-x)**2+(star.y-y)**2;if(next<=Math.max(radius,star.screenRadius+6)**2&&(next<distance-.01||(Math.abs(next-distance)<.01&&star.depth<(match?.depth??Infinity)))){match=star;distance=next;}}return match;}

const sprites=new WeakMap();
function halo(context,rgb){let cache=sprites.get(context);if(!cache){cache=new Map();sprites.set(context,cache);}const key=rgb.join(',');if(cache.has(key))return cache.get(key);const doc=context.canvas?.ownerDocument;const canvas=doc?.createElement('canvas')||(typeof OffscreenCanvas==='function'?new OffscreenCanvas(64,64):null);if(!canvas)return null;canvas.width=canvas.height=64;const ctx=canvas.getContext('2d'),gradient=ctx.createRadialGradient(32,32,0,32,32,32);gradient.addColorStop(0,'rgba('+key+',.65)');gradient.addColorStop(.3,'rgba('+key+',.12)');gradient.addColorStop(1,'rgba('+key+',0)');ctx.fillStyle=gradient;ctx.fillRect(0,0,64,64);cache.set(key,canvas);return canvas;}
const rgba=(rgb,alpha)=>'rgba('+rgb.join(',')+','+alpha+')';
const coreStyles=new WeakMap();
function coreStyle(rgb,alpha){let styles=coreStyles.get(rgb);if(!styles){styles=new Map();coreStyles.set(rgb,styles);}if(!styles.has(alpha))styles.set(alpha,rgba(rgb,alpha));return styles.get(alpha);}

/** Collision-limited labels use only saved group names and actual note titles. */
export function layoutKnowledgeSpaceLabels(context,space,projected,{width,height,selectedIds=[],hoveredId='',focusedId='',labelExclusionRects=[]}={}){
  if(!(width>32&&height>32))return[];
  const labels=[],occupied=labelExclusionRects.filter(rect=>rect&&['x','y','width','height'].every(key=>Number.isFinite(rect[key]))&&rect.width>0&&rect.height>0).map(rect=>({...rect}));
  const budget=Math.min(44,Math.max(10,Math.floor(width*height/16000))),active=new Set(selectedIds);if(hoveredId)active.add(hoveredId);if(focusedId)active.add(focusedId);
  const overlaps=rect=>occupied.some(other=>rect.x<other.x+other.width+3&&rect.x+rect.width+3>other.x&&rect.y<other.y+other.height+3&&rect.y+rect.height+3>other.y);
  const clean=value=>String(value||'').replace(/\s+/g,' ').trim();
  const fit=(text,max)=>{if(context.measureText(text).width<=max)return text;const chars=[...text];let low=0,high=chars.length;while(low<high){const mid=Math.ceil((low+high)/2);if(context.measureText(chars.slice(0,mid).join('')+'…').width<=max)low=mid;else high=mid-1;}return chars.slice(0,low).join('')+'…';};
  const add=({kind,id,fullText,anchors,color,size=11,maxWidth=220,alpha=.9})=>{
    if(labels.length>=budget)return false;context.font=(kind==='note'?'400 ':'500 ')+size+'px system-ui';
    const text=fit(clean(fullText),Math.min(maxWidth,width-32));if(!text||text==='…')return false;const measured=context.measureText(text).width;
    for(const point of anchors){const x=clamp(point.x,12,Math.max(12,width-measured-12)),y=clamp(point.y,size+12,height-12),rect={x:x-4,y:y-size-3,width:measured+8,height:size+8};if(overlaps(rect))continue;const label={kind,id,text,fullText:clean(fullText),x,y,width:measured,height:size,font:context.font,color,alpha,rect};labels.push(label);occupied.push(rect);return true;}return false;
  };
  for(const band of projected.bands||[])add({kind:'level',id:band.id,fullText:band.label,color:[220,235,243],size:12,maxWidth:260,anchors:[band.labelPosition,{x:band.labelPosition.x,y:band.labelPosition.y+22}]});
  const byId=projected.byId||new Map(projected.stars.map(star=>[star.id,star]));
  const noteAnchors=star=>[{x:star.x+11,y:star.y-9},{x:star.x+11,y:star.y+22},{x:star.x-175,y:star.y-9},{x:star.x-175,y:star.y+22}];
  const title=star=>star.node.title||String(star.node.path||'').split('/').at(-1)?.replace(/\.md$/i,'')||star.id;
  const visible=star=>star.x>=8&&star.x<=width-8&&star.y>=8&&star.y<=height-8;
  const priority=[hoveredId,focusedId,...active].filter((id,at,ids)=>id&&ids.indexOf(id)===at);
  let importantNotes=0;for(const id of priority){if(importantNotes>=6)break;const star=byId.get(id);if(star&&visible(star)&&add({kind:'note',id,fullText:title(star),color:CYAN,alpha:1,maxWidth:260,anchors:noteAnchors(star)}))importantNotes++;}
  const regionIds=new Set([...active].map(id=>byId.get(id)?.regionId)),regions=projected.regions.filter(region=>region.x+region.screenRadius>=8&&region.x-region.screenRadius<=width-8&&region.y+region.screenRadius>=8&&region.y-region.screenRadius<=height-8).sort((a,b)=>Number(regionIds.has(b.id))-Number(regionIds.has(a.id))||b.count-a.count||a.id.localeCompare(b.id));
  const topicBudget=Math.min(24,Math.max(4,Math.floor(width*height/30000)));let topics=0;
  for(const region of regions){if(topics>=topicBudget)break;const text=region.label+' · '+region.count;
    if(add({kind:'topic',id:region.id,fullText:text,color:region.color,size:11,alpha:.9,maxWidth:210,anchors:[{x:region.x-region.screenRadius*.45,y:region.y-region.screenRadius-12},{x:region.x-region.screenRadius*.45,y:region.y+region.screenRadius+20},{x:region.x+region.screenRadius+10,y:region.y}]}))topics++;
  }
  // At most two candidates per actual cloud keep sorting and text measurements bounded.
  const candidates=new Map();for(const star of projected.stars){if(!visible(star)||active.has(star.id))continue;let pair=candidates.get(star.regionId);if(!pair){pair=[];candidates.set(star.regionId,pair);}if(pair.length<2||star.depth<pair.at(-1).depth){pair.push(star);pair.sort((a,b)=>a.depth-b.depth||a.id.localeCompare(b.id));if(pair.length>2)pair.pop();}}
  const regionById=new Map(regions.map(region=>[region.id,region])),room=region=>region?Math.PI*region.screenRadius**2/Math.max(1,region.count):0;
  const hints=[...candidates.values()].flat().filter(star=>regionById.has(star.regionId)).sort((a,b)=>room(regionById.get(b.regionId))-room(regionById.get(a.regionId))||a.depth-b.depth||a.id.localeCompare(b.id));
  const noteBudget=Math.min(12-importantNotes,Math.max(0,Math.floor(width*height/80000)-importantNotes),regions.some(region=>room(region)>=900)?12:3);let notes=0;
  for(const star of hints){if(notes>=noteBudget||labels.length>=budget)break;if(add({kind:'note',id:star.id,fullText:title(star),color:star.color,alpha:.8,maxWidth:170,anchors:noteAnchors(star)}))notes++;}
  return labels;
}

/** One canvas pass: only indexed notes, saved relations and real group names. */
export function paintKnowledgeSpace(context,space,projected,{width,height,selectedIds=[],hoveredId='',focusedId='',focusRegions=false,labelExclusionRects=[]}={}){
  const selected=selectedIds instanceof Set?selectedIds:new Set(selectedIds),activeIds=new Set(selected);if(hoveredId)activeIds.add(hoveredId);if(focusedId)activeIds.add(focusedId);
  const near=new Set(activeIds),regionIds=new Set(),byId=projected.byId||new Map(projected.stars.map(star=>[star.id,star]));
  for(const id of activeIds){const star=byId.get(id);if(star)regionIds.add(star.regionId);}for(const link of space.links){if(activeIds.has(link.source))near.add(link.target);if(activeIds.has(link.target))near.add(link.source);}
  context.globalCompositeOperation='source-over';context.globalAlpha=1;context.fillStyle='#000';context.fillRect(0,0,width,height);
  for(const band of projected.bands||[]){context.beginPath();band.corners.forEach((point,at)=>at?context.lineTo(point.x,point.y):context.moveTo(point.x,point.y));context.closePath?.();context.fillStyle='rgba(171,207,221,.018)';context.fill();context.lineWidth=.5;context.strokeStyle=focusRegions?'rgba(90,224,239,.20)':'rgba(171,207,221,.11)';context.stroke();}
  // A faint cached mist locates a knowledge cloud without turning it into a bubble.
  for(const region of space.groupBy==='hierarchy'?[]:projected.regions){const active=focusRegions||regionIds.has(region.id),sprite=halo(context,active?CYAN:region.color);if(sprite){const radius=region.screenRadius*1.3;context.globalAlpha=active?.055:.022;context.drawImage(sprite,region.x-radius,region.y-radius,radius*2,radius*2);}}
  context.globalAlpha=1;
  // Three batched paths avoid allocating a pair array for every relation every frame.
  for(let at=0;at<3;at++){context.strokeStyle=at===2?'rgba(90,224,239,.42)':at===1?'rgba(176,197,214,.028)':activeIds.size?'rgba(176,197,214,.055)':space.groupBy==='hierarchy'?'rgba(176,197,214,.10)':'rgba(176,197,214,.14)';context.lineWidth=at===2?.65:.4;context.beginPath();for(const link of space.links){const a=byId.get(link.source),b=byId.get(link.target);if(!a||!b)continue;const bucket=activeIds.has(a.id)||activeIds.has(b.id)?2:space.groupBy==='hierarchy'&&hierarchyLevelOf(a.node)!==hierarchyLevelOf(b.node)?1:0;if(bucket!==at||Math.max(a.x,b.x)<0||Math.min(a.x,b.x)>width||Math.max(a.y,b.y)<0||Math.min(a.y,b.y)>height)continue;context.moveTo(a.x,a.y);context.lineTo(b.x,b.y);}context.stroke();}
  const regularHalo=halo(context,[194,213,228]),cyanHalo=halo(context,CYAN),cores=new Map(),rings=[];
  for(const star of projected.stars){if(star.x<-10||star.x>width+10||star.y<-10||star.y>height+10)continue;const active=activeIds.has(star.id),related=near.has(star.id),cyan=active,dim=activeIds.size>0&&!related;const radius=clamp(star.screenRadius,.55,2.4),sprite=cyan?cyanHalo:regularHalo;
    if(sprite&&(active||(!dim&&radius>.85&&star.radius>.89))){const haloSize=active?7:3.6;context.globalAlpha=active?.8:.28;context.drawImage(sprite,star.x-haloSize,star.y-haloSize,haloSize*2,haloSize*2);context.globalAlpha=1;}
    const alpha=dim?.33:active?1:related?.95:.83,style=coreStyle(star.color,alpha);let batch=cores.get(style);if(!batch){batch={style,alpha,stars:[]};cores.set(style,batch);}batch.stars.push(star);if(active)rings.push(star);
  }
  // Each complete circle starts its own subpath; batching cannot join star centers.
  for(const batch of [...cores.values()].sort((a,b)=>a.alpha-b.alpha)){context.fillStyle=batch.style;context.beginPath();for(const star of batch.stars){const radius=clamp(star.screenRadius,.55,2.4)+(activeIds.has(star.id)?.3:0);context.moveTo(star.x+radius,star.y);context.arc(star.x,star.y,radius,0,Math.PI*2);}context.fill();}
  context.strokeStyle='rgba(90,224,239,.65)';context.lineWidth=.65;for(const star of rings)context.strokeRect(star.x-4.5,star.y-4.5,9,9);
  const labels=layoutKnowledgeSpaceLabels(context,space,projected,{width,height,selectedIds:selected,hoveredId,focusedId,labelExclusionRects});
  for(const label of labels){context.font=label.font;context.fillStyle=rgba(label.color,label.alpha);context.fillText(label.text,label.x,label.y);}
  return{notes:projected.stars.length,relations:space.links.length,labels};
}
