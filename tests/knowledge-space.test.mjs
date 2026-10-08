import test from 'node:test';
import assert from 'node:assert/strict';
import {createKnowledgeSpace,projectKnowledgeSpace,projectSpacePoint,hitTestKnowledgeStar,frameKnowledgeSpace,normalizeSpaceCamera,DEFAULT_SPACE_CAMERA,paintKnowledgeSpace,hierarchyLevelOf,knowledgeHierarchyLevels,knowledgeGroupColor,layoutKnowledgeSpaceLabels} from '../src/knowledge-space.mjs';
const nodes=[{id:'a',title:'One',layer:'Knowledge',categoryId:'methods'},{id:'b',title:'Two',layer:'Knowledge',categoryId:'ideas'},{id:'c',title:'Three',layer:'Reference',categoryId:'methods'}];
const index={categories:[{id:'methods',label:'Methods'},{id:'ideas',label:'Ideas'}],edges:[{source:'a',target:'c'},{source:'a',target:'outside'}]};
test('3D regions retain actual IDs and include only current indexed selection',()=>{const space=createKnowledgeSpace(index,nodes,{groupBy:'layers'});assert.deepEqual(space.stars.map(star=>star.id).sort(),['a','b','c']);assert.deepEqual(space.links.map(edge=>[edge.source,edge.target]),[['a','c']]);assert.equal(space.regions.length,2);assert.deepEqual(createKnowledgeSpace(index,nodes,{groupBy:'layers'}),space);assert.ok(space.stars.some(star=>star.position.z!==0));});
test('category layout and focused selection reflow actual stars without new model labels',()=>{const grouped=createKnowledgeSpace(index,nodes,{groupBy:'categories'});assert.deepEqual(grouped.regions.map(region=>region.label),['Ideas','Methods']);const focused=createKnowledgeSpace(index,nodes.filter(node=>node.categoryId==='methods'),{groupBy:'categories'});assert.equal(focused.regions.length,1);assert.deepEqual(focused.regions[0].center,{x:0,y:0,z:0});assert.deepEqual(focused.stars.map(star=>star.id).sort(),['a','c']);});
test('yaw and pitch independently change real depth and perspective positions',()=>{const point={x:120,y:70,z:100},viewport={width:800,height:480};const base=projectSpacePoint(point,{yaw:0,pitch:0},viewport),yaw=projectSpacePoint(point,{yaw:.7,pitch:0},viewport),pitch=projectSpacePoint(point,{yaw:0,pitch:.7},viewport);assert.notEqual(base.x,yaw.x);assert.notEqual(base.depth,yaw.depth);assert.notEqual(base.y,pitch.y);assert.notEqual(base.depth,pitch.depth);});
test('closer stars are larger and camera zoom and pan transform consistent screen geometry',()=>{const viewport={width:640,height:440},camera={yaw:0,pitch:0,zoom:1,panX:0,panY:0};const far=projectSpacePoint({x:80,y:20,z:150},camera,viewport),near=projectSpacePoint({x:80,y:20,z:-150},camera,viewport);assert.ok(near.scale>far.scale);const zoom=projectSpacePoint({x:80,y:20,z:150},{...camera,zoom:2},viewport);assert.equal(zoom.x-viewport.width/2,(far.x-viewport.width/2)*2);const pan=projectSpacePoint({x:80,y:20,z:150},{...camera,panX:40,panY:-25},viewport);assert.equal(pan.x-far.x,40);assert.equal(pan.y-far.y,-25);});
test('projected canvas hit test picks actual node and rejects empty space',()=>{const projected=projectKnowledgeSpace(createKnowledgeSpace(index,nodes,{groupBy:'layers'}),DEFAULT_SPACE_CAMERA,{width:640,height:440});const first=projected.stars[0];assert.equal(hitTestKnowledgeStar(projected,first.x,first.y).id,first.id);assert.equal(hitTestKnowledgeStar(projected,-100,-100),null);});
test('finite full-turn rotation wraps continuously while zoom and pan remain bounded',()=>{const normalized=normalizeSpaceCamera({pitch:20,zoom:100,panX:Infinity});assert.ok(Math.abs(normalized.pitch-(20-Math.PI*6))<1e-12);assert.equal(normalized.zoom,64);assert.equal(normalized.panX,0);const point={x:100,y:200,z:50},view={width:700,height:500};const before=projectSpacePoint(point,{yaw:.3,pitch:2.2},view),wrapped=projectSpacePoint(point,{yaw:.3+Math.PI*20,pitch:2.2-Math.PI*16},view);for(const axis of ['x','y','depth'])assert.ok(Math.abs(before[axis]-wrapped[axis])<1e-9);assert.ok(Math.abs(normalizeSpaceCamera({pitch:2.2}).pitch)>1.35);assert.deepEqual(normalizeSpaceCamera({yaw:NaN,pitch:Infinity}),DEFAULT_SPACE_CAMERA);assert.equal(projectSpacePoint({x:0,y:0,z:-700},{yaw:0,pitch:0},view),null);});
test('topic framing fills perspective viewport with actual regions and ignores decorative stars',()=>{const space=createKnowledgeSpace(index,nodes.filter(node=>node.categoryId==='ideas'),{groupBy:'layers'});const viewport={width:600,height:420};const framed=frameKnowledgeSpace(space,viewport);assert.ok(framed.zoom>1);assert.deepEqual(frameKnowledgeSpace({...space,background:[]},viewport),framed);const projected=projectKnowledgeSpace(space,framed,viewport);assert.ok(Math.abs(projected.regions[0].x-viewport.width/2)<1);assert.ok(Math.abs(projected.regions[0].y-viewport.height/2)<1);});

test('4000 eligible notes remain real points and only supplied relations become lines',()=>{const notes=Array.from({length:4000},(_,i)=>({id:'note-'+i,layer:'Group '+i%6,path:'Synthetic/'+i+'.md'}));const edges=notes.slice(1).map((note,i)=>({source:notes[i].id,target:note.id,kind:'link'}));const space=createKnowledgeSpace({edges},notes);assert.equal(space.stars.length,4000);assert.equal(space.links.length,3999);assert.equal(space.background.length,0);assert.equal(space.dust.length,0);assert.equal(space.byId.size,4000);const viewport={width:1000,height:650},projected=projectKnowledgeSpace(space,frameKnowledgeSpace(space,viewport),viewport);assert.equal(projected.stars.length,4000);assert.ok(projected.stars.every(star=>star.screenRadius<=2.4&&Number.isFinite(star.depth)));assert.deepEqual(new Set(projected.stars.map(star=>star.id)),new Set(notes.map(note=>note.id)));});

test('saved within-group links affect placement without drawing unsupported relationships',()=>{const plain=createKnowledgeSpace({},nodes,{groupBy:'layers'}),linked=createKnowledgeSpace({edges:[{source:'a',target:'b'}]},nodes,{groupBy:'layers'});const distance=space=>Math.hypot(...['x','y','z'].map(axis=>space.byId.get('a').position[axis]-space.byId.get('b').position[axis]));assert.ok(distance(linked)<distance(plain));assert.deepEqual(linked.byId.get('c').position,plain.byId.get('c').position);assert.equal(linked.links.length,1);assert.equal(plain.links.length,0);});

test('painter draws black space and saved lines; cyan evidence ring preserves group color',()=>{const space=createKnowledgeSpace(index,nodes,{groupBy:'layers'}),viewport={width:640,height:440},projected=projectKnowledgeSpace(space,frameKnowledgeSpace(space,viewport),viewport);const events=[];const context={canvas:{},fillRect(){events.push(['background',this.fillStyle]);},beginPath(){},moveTo(){events.push(['move']);},lineTo(){events.push(['line']);},stroke(){},arc(){events.push(['core',this.fillStyle]);},fill(){},strokeRect(){events.push(['selection',this.strokeStyle]);},measureText:text=>({width:text.length*6}),fillText:text=>events.push(['label',text])};paintKnowledgeSpace(context,space,projected,{...viewport,selectedIds:['a']});assert.deepEqual(events[0],['background','#000']);assert.equal(events.filter(([type])=>type==='line').length,1);assert.equal(events.filter(([type])=>type==='core').length,3);assert.ok(events.some(([type,color])=>type==='core'&&color==='rgba('+space.byId.get('a').color.join(',')+',1)'));assert.ok(events.some(([type,color])=>type==='selection'&&color==='rgba(90,224,239,.65)'));assert.ok(events.some(([type,text])=>type==='label'&&text.startsWith('Knowledge · ')));assert.ok(!events.some(([type,text])=>type==='label'&&/PERSPECTIVE|ORBIT|3D/.test(text)));});

test('hierarchy defaults to ordered nonoverlapping bands independent of semantic roles',()=>{const levels=['overview','topic','detail','unassigned'];const notes=Array.from({length:4000},(_,i)=>({id:'hierarchy-'+i,categoryId:i%2?'methods':'ideas',layer:'knowledge',hierarchyLevel:levels[Math.floor(i/1000)]}));const edges=[{source:notes[0].id,target:notes[1000].id}];const space=createKnowledgeSpace({...index,edges},notes);assert.deepEqual(space.bands.map(band=>band.id),levels);assert.deepEqual(space.bands.map(band=>band.depth),[0,1,2,3]);assert.equal(space.stars.length,4000);assert.equal(space.links.length,1);assert.equal(space.regions.length,8);let previousMax=-Infinity;for(const level of levels){const points=space.stars.filter(star=>hierarchyLevelOf(star.node)===level);const min=Math.min(...points.map(star=>star.position.y)),max=Math.max(...points.map(star=>star.position.y));assert.ok(min>previousMax);const radius=space.regions.find(region=>region.levelId===level).radius;assert.ok(max-min>radius*1.5);previousMax=max;}assert.equal(new Set(space.stars.map(star=>star.node.layer)).size,1);assert.ok(space.regions.every(region=>['Ideas','Methods'].includes(region.label)));assert.deepEqual(space.background,[]);const viewport={width:1000,height:650},projected=projectKnowledgeSpace(space,frameKnowledgeSpace(space,viewport),viewport);assert.equal(projected.stars.length,4000);assert.equal(projected.bands.length,4);assert.ok(projected.bands.every(band=>typeof band.label==='string'&&band.corners.every(point=>Number.isFinite(point.x))));});

test('legacy and inconclusive nodes stay unassigned without invented classified levels',()=>{const notes=[{id:'legacy',layer:'knowledge',categoryId:'methods'},{id:'invalid',hierarchyLevel:'fabricated',categoryId:'methods'},{id:'inconclusive',hierarchyLevel:'unassigned',categoryId:'methods'}],space=createKnowledgeSpace(index,notes);assert.deepEqual(space.bands.map(band=>band.id),['unassigned']);assert.ok(space.stars.every(star=>hierarchyLevelOf(star.node)==='unassigned'));assert.deepEqual(knowledgeHierarchyLevels(index,notes).map(level=>level.count),[0,0,0,3]);assert.equal(space.links.length,0);});

function cloudAxisMetrics(space,region){
  const points=space.stars.filter(star=>star.regionId===region.id);
  return ['x','y','z'].map(axis=>{
    const values=points.map(star=>star.position[axis]-region.center[axis]),mean=values.reduce((a,b)=>a+b,0)/values.length;
    return{variance:values.reduce((sum,value)=>sum+(value-mean)**2,0)/values.length,span:Math.max(...values)-Math.min(...values)};
  });
}

test('dense hierarchy clouds occupy an isotropic ball with both interior and outer notes',()=>{
  for(const count of [128,500]){
    const notes=Array.from({length:count},(_,i)=>({id:'sphere-'+i,categoryId:'round-topic',hierarchyLevel:'topic'})),space=createKnowledgeSpace({},notes),region=space.regions[0];
    const metrics=cloudAxisMetrics(space,region),variances=metrics.map(item=>item.variance),spans=metrics.map(item=>item.span);
    assert.ok(Math.max(...variances)/Math.min(...variances)<1.2,'Axis variance must not flatten one direction.');
    assert.ok(Math.min(...spans)>region.radius*1.5,'All axes must expose the cloud diameter.');
    const distances=space.stars.map(star=>Math.hypot(...['x','y','z'].map(axis=>star.position[axis]-region.center[axis])));
    assert.ok(distances.every(distance=>distance<=region.radius));
    assert.ok(distances.some(distance=>distance<region.radius*.45));
    assert.ok(distances.some(distance=>distance>region.radius*.85));
  }
});

test('two to four note topics expose balanced depth on every axis and are deterministic',()=>{
  for(const count of [2,3,4]){
    const notes=Array.from({length:count},(_,i)=>({id:'small-'+i,categoryId:'small-topic',hierarchyLevel:'detail'})),space=createKnowledgeSpace({},notes),region=space.regions[0],metrics=cloudAxisMetrics(space,region);
    assert.ok(metrics.every(item=>item.span>region.radius*.8));
    assert.ok(Math.max(...metrics.map(item=>item.variance))/Math.min(...metrics.map(item=>item.variance))<1.01);
    const reordered=createKnowledgeSpace({},[...notes].reverse());
    assert.deepEqual(reordered.stars.map(star=>[star.id,star.position]),space.stars.map(star=>[star.id,star.position]));
    if(count===4){
      const p=space.stars.map(star=>star.position),a=['x','y','z'].map(axis=>p[1][axis]-p[0][axis]),b=['x','y','z'].map(axis=>p[2][axis]-p[0][axis]),c=['x','y','z'].map(axis=>p[3][axis]-p[0][axis]);
      const volume=Math.abs(a[0]*(b[1]*c[2]-b[2]*c[1])-a[1]*(b[0]*c[2]-b[2]*c[0])+a[2]*(b[0]*c[1]-b[1]*c[0]));
      assert.ok(volume>region.radius**3,'Four notes must span real 3D volume.');
    }
  }
});

test('many topics keep spherical region clearance and all 4000 notes visible through full rotations',()=>{
  const levels=['overview','topic','detail','unassigned'],notes=Array.from({length:4000},(_,i)=>({id:'many-'+i,categoryId:'topic-'+Math.floor(i/20),hierarchyLevel:levels[Math.floor(i/1000)]}));
  const space=createKnowledgeSpace({},notes),viewport={width:1000,height:650};
  assert.equal(space.regions.length,200);assert.equal(space.stars.length,4000);
  for(let i=0;i<space.regions.length;i++)for(let j=i+1;j<space.regions.length;j++){
    const a=space.regions[i],b=space.regions[j],distance=Math.hypot(...['x','y','z'].map(axis=>a.center[axis]-b.center[axis]));
    assert.ok(distance>a.radius+b.radius,'Topic spheres and hierarchy layers must not intersect.');
  }
  for(const star of space.stars){const region=space.regions.find(item=>item.id===star.regionId);assert.ok(Math.hypot(...['x','y','z'].map(axis=>star.position[axis]-region.center[axis]))<=region.radius+1e-9);}
  for(let step=0;step<=8;step++)for(const rotation of [{yaw:step*Math.PI/4,pitch:.16},{yaw:-.18,pitch:step*Math.PI/4}]){
    const projected=projectKnowledgeSpace(space,rotation,viewport);
    assert.equal(projected.stars.length,4000,'Uniform scene bounds must prevent near-plane culling.');assert.equal(projected.bands.length,4);
    assert.ok(projected.stars.every(star=>star.depth>=210-1e-9));
  }
});

test('hierarchy painter labels saved levels and real topics with no fabricated parent edges',()=>{const notes=[{id:'overview',categoryId:'methods',hierarchyLevel:'overview'},{id:'detail',categoryId:'ideas',hierarchyLevel:'detail'}],space=createKnowledgeSpace({},notes),viewport={width:800,height:600},projected=projectKnowledgeSpace(space,frameKnowledgeSpace(space,viewport),viewport),labels=[],lines=[];const context={canvas:{},fillRect(){},beginPath(){},closePath(){},moveTo(){},lineTo(){lines.push(1);},stroke(){},arc(){},fill(){},strokeRect(){},measureText:text=>({width:text.length*6}),fillText:text=>labels.push(text)};paintKnowledgeSpace(context,space,projected,viewport);assert.ok(labels.includes('Level 1 · Overview')&&labels.includes('Level 3 · Detail'));assert.ok(labels.includes('methods · 1')&&labels.includes('ideas · 1'));assert.equal(space.links.length,0);assert.equal(lines.length,6);});

test('saved topic colors survive hierarchy, filtering, reorder and unrelated category insertion',()=>{
  const categories=[{id:'actual-type-a',label:'Methods'},{id:'actual-type-b',label:'Ideas'}],notes=['overview','topic','detail'].map((hierarchyLevel,i)=>({id:'saved-'+i,category:'actual-type-a',layer:'reference',hierarchyLevel,title:'Saved note '+i}));
  const full=createKnowledgeSpace({categories},notes),filtered=createKnowledgeSpace({categories:[{id:'new-first',label:'New independent topic'},...categories].reverse()},[...notes].reverse().slice(1));
  const expected=knowledgeGroupColor('actual-type-a',{label:'Methods'});
  assert.ok(full.stars.every(star=>JSON.stringify(star.color)===JSON.stringify(expected)));
  assert.ok(full.regions.every(region=>region.colorKey==='actual-type-a'&&region.colorKind==='category'));
  assert.ok(filtered.stars.every(star=>JSON.stringify(star.color)===JSON.stringify(expected)));
  assert.deepEqual(createKnowledgeSpace({categories},notes,{groupBy:'categories'}).stars[0].color,expected);
  assert.deepEqual(knowledgeGroupColor('different-saved-id',{label:'  METHODS  '}),expected);
  assert.deepEqual(knowledgeGroupColor('one',{label:'Café'}),knowledgeGroupColor('two',{label:'Cafe\u0301'}));
});

test('role colors follow only saved roles, independently from arbitrary topic and hierarchy IDs',()=>{
  const roles=['knowledge','reference','action','decision','other'],notes=roles.map((layer,i)=>({id:'role-'+i,category:'shared-topic',layer,hierarchyLevel:'detail'}));
  const space=createKnowledgeSpace({categories:[{id:'shared-topic',label:'A saved topic'}],layers:roles.map(id=>({id,label:id[0].toUpperCase()+id.slice(1)}))},notes,{groupBy:'layers'});
  for(const star of space.stars)assert.deepEqual(star.color,knowledgeGroupColor(star.node.layer,{kind:'role'}));
  assert.equal(new Set(space.stars.map(star=>star.color.join(','))).size,5);
  assert.deepEqual(knowledgeGroupColor('knowledge',{kind:'role',label:'Localized display label'}),knowledgeGroupColor('knowledge',{kind:'role'}));
  assert.ok(space.regions.every(region=>region.colorKind==='role'));
  assert.ok(createKnowledgeSpace({},[{id:'unknown',category:'Unclassified',layer:'other'}]).stars.every(star=>star.node.hierarchyLevel===undefined));
});

test('the six saved usability topics have distinct pastel hues without a repeating palette',()=>{
  const labels=['Aurora science','Boreal methods','Cedar evidence','Delta projects','Estuary questions','Forest decisions'],categories=labels.map((label,i)=>({id:'actual-topic-'+i,label})),notes=categories.flatMap((category,i)=>['overview','topic','detail'].map(level=>({id:'color-'+i+'-'+level,category:category.id,hierarchyLevel:level}))),space=createKnowledgeSpace({categories},notes);
  const colors=categories.map(category=>knowledgeGroupColor(category.id,{label:category.label}));assert.equal(new Set(colors.map(color=>color.join(','))).size,6);
  const hue=rgb=>{const [r,g,b]=rgb.map(channel=>channel/255),max=Math.max(r,g,b),min=Math.min(r,g,b),delta=max-min;let h=max===r?(g-b)/delta:max===g?(b-r)/delta+2:(r-g)/delta+4;return(h*60+360)%360;};
  for(let i=0;i<colors.length;i++){
    const color=colors[i],max=Math.max(...color)/255,min=Math.min(...color)/255,lightness=(max+min)/2,saturation=(max-min)/(1-Math.abs(2*lightness-1));
    assert.ok(Math.abs(lightness-.70)<.005&&Math.abs(saturation-.58)<.01,'Topic families share a muted saturation and lightness.');
    assert.ok(space.stars.filter(star=>star.node.category===categories[i].id).every(star=>star.color.join(',')===color.join(',')));
    for(let j=i+1;j<colors.length;j++){const raw=Math.abs(hue(color)-hue(colors[j]));assert.ok(Math.min(raw,360-raw)>15,'This actual fixture must not leave near-identical hue families.');assert.ok(Math.hypot(...color.map((channel,at)=>channel-colors[j][at]))>20);}
  }
  const extra={id:'unrelated-extra',label:'An independently saved extra category'},filtered=createKnowledgeSpace({categories:[extra,...categories].reverse()},[...notes].reverse().filter(note=>note.hierarchyLevel==='topic'));
  for(const star of filtered.stars)assert.deepEqual(star.color,colors[categories.findIndex(category=>category.id===star.node.category)]);
});

function labelContext(){return{font:'',measurements:0,measureText(text){this.measurements++;return{width:[...text].reduce((sum,char)=>sum+(char.codePointAt(0)>255?12:6),0)};}};}
function assertLabelsFit(labels,view,excluded=[]){
  for(const label of labels){const r=label.rect;assert.ok(r.x>=0&&r.y>=0&&r.x+r.width<=view.width&&r.y+r.height<=view.height,JSON.stringify(label));assert.ok(label.width>0&&label.height>0&&label.fullText);}
  const all=[...excluded,...labels.map(label=>label.rect)];
  for(let i=0;i<all.length;i++)for(let j=i+1;j<all.length;j++){const a=all[i],b=all[j];assert.ok(!(a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y),'Labels and reserved overlay bounds must not overlap.');}
}

test('compact labels retain saved topic counts, levels and actual note titles with bounded density',()=>{
  const notes=Array.from({length:128},(_,i)=>({id:'named-'+i,title:'Actual source title '+i,category:'saved-topic',hierarchyLevel:'topic'})),space=createKnowledgeSpace({categories:[{id:'saved-topic',label:'Saved methods'}]},notes),view={width:900,height:700},projected=projectKnowledgeSpace(space,frameKnowledgeSpace(space,view),view),context=labelContext(),labels=layoutKnowledgeSpaceLabels(context,space,projected,view);
  assert.ok(labels.some(label=>label.kind==='level'&&label.fullText==='Level 2 · Topic'));
  assert.ok(labels.some(label=>label.kind==='topic'&&label.fullText==='Saved methods · 128'));
  assert.ok(labels.some(label=>label.kind==='note'&&notes.some(note=>note.id===label.id&&note.title===label.fullText)));
  assert.ok(labels.length<=44&&labels.filter(label=>label.kind==='note').length<=12);assertLabelsFit(labels,view);
});

test('4000 note label planning bounds measurements and never invents titles or groups',()=>{
  const categories=Array.from({length:40},(_,i)=>({id:'topic-'+i,label:'Saved topic '+i})),notes=Array.from({length:4000},(_,i)=>({id:'dense-'+i,title:'Source note '+i,category:'topic-'+(i%40),hierarchyLevel:['overview','topic','detail','unassigned'][Math.floor(i/1000)]})),space=createKnowledgeSpace({categories},notes),view={width:1000,height:650},projected=projectKnowledgeSpace(space,frameKnowledgeSpace(space,view),view),context=labelContext(),labels=layoutKnowledgeSpaceLabels(context,space,projected,view);
  assert.ok(labels.length<=40);assert.ok(labels.filter(label=>label.kind==='topic').length<=21);assert.ok(labels.filter(label=>label.kind==='note').length<=12);assert.ok(context.measurements<500,'Text work must stay bounded despite thousands of actual notes.');
  for(const label of labels)if(label.kind==='note')assert.equal(space.byId.get(label.id).node.title,label.fullText);else if(label.kind==='topic'){const region=space.regions.find(region=>region.id===label.id);assert.equal(label.fullText,region.label+' · '+region.count);}
  assertLabelsFit(labels,view);
});

test('narrow label layout reserves control bounds, fits long Unicode titles and preserves full metadata',()=>{
  const title='실제 원문 제목 '.repeat(30),notes=Array.from({length:12},(_,i)=>({id:'unicode-'+i,title:i===0?title:'Saved source '+i,category:'real',hierarchyLevel:'detail'})),space=createKnowledgeSpace({categories:[{id:'real',label:'Actual saved category with a very long descriptive label'}]},notes),view={width:390,height:300},projected=projectKnowledgeSpace(space,frameKnowledgeSpace(space,view),view),excluded=[{x:0,y:0,width:145,height:52}],context=labelContext(),labels=layoutKnowledgeSpaceLabels(context,space,projected,{...view,focusedId:'unicode-0',labelExclusionRects:excluded});
  const focused=labels.find(label=>label.id==='unicode-0');assert.ok(focused);assert.equal(focused.fullText,title.trim());assert.ok(focused.text.endsWith('…'));assert.ok(labels.length<=10);assertLabelsFit(labels,view,excluded);
  assert.deepEqual(layoutKnowledgeSpaceLabels(context,space,projected,{width:20,height:20}),[]);
});

test('4000 real circles retain exact positions, radii and evidence opacity in a few independent fill paths',()=>{
  const categories=Array.from({length:6},(_,i)=>({id:'batch-topic-'+i,label:'Saved batch topic '+i})),notes=Array.from({length:4000},(_,i)=>({id:'batch-'+i,title:'Actual batch note '+i,category:categories[i%6].id,hierarchyLevel:['overview','topic','detail','unassigned'][Math.floor(i/1000)]})),space=createKnowledgeSpace({categories,edges:[{source:'batch-0',target:'batch-6'}]},notes),view={width:1000,height:700},projected=projectKnowledgeSpace(space,frameKnowledgeSpace(space,view),view);
  const fills=[],circles=[],rings=[];let path=[],lastMove=null;
  const context={canvas:{},fillRect(){},beginPath(){path=[];lastMove=null;},moveTo(x,y){lastMove={x,y};},lineTo(){lastMove=null;},closePath(){},stroke(){},arc(x,y,r,start,end){assert.deepEqual(lastMove,{x:x+r,y});assert.equal(start,0);assert.equal(end,Math.PI*2);const circle={x,y,r,style:this.fillStyle};path.push(circle);circles.push(circle);lastMove=null;},fill(){if(path.length)fills.push({style:this.fillStyle,circles:[...path]});},strokeRect(x,y,w,h){assert.equal(circles.length,4000,'Evidence rings paint after every core.');rings.push({x,y,w,h,color:this.strokeStyle});},measureText:text=>({width:text.length*6}),fillText(){}};
  const result=paintKnowledgeSpace(context,space,projected,{...view,selectedIds:['batch-0']});
  assert.equal(result.notes,4000);assert.equal(circles.length,4000);assert.ok(fills.length<=8,'Fill submissions depend on actual RGB/opacity groups, not note count.');assert.equal(rings.length,1);assert.equal(rings[0].color,'rgba(90,224,239,.65)');
  const actual=new Map(circles.map(circle=>[circle.x+','+circle.y,circle]));
  for(const star of projected.stars){const circle=actual.get(star.x+','+star.y);assert.ok(circle);const active=star.id==='batch-0',related=star.id==='batch-6',alpha=active?1:related?.95:.33;assert.equal(circle.r,Math.max(.55,Math.min(2.4,star.screenRadius))+(active?.3:0));assert.equal(circle.style,'rgba('+star.color.join(',')+','+alpha+')');}
  assert.equal(fills.at(-1).style,'rgba('+space.byId.get('batch-0').color.join(',')+',1)','Bright evidence cores remain on top of dim unrelated cores.');
});

test('passive halos require a visible projected core, while tiny active evidence still glows',()=>{
  const stars=[.55,.9,.55].map((screenRadius,i)=>({id:'halo-'+i,node:{title:'Actual halo note '+i},regionId:'saved',color:[150,190,220],x:100+i*100,y:100,radius:.95,screenRadius,depth:650})),projected={stars,regions:[],bands:[],byId:new Map(stars.map(star=>[star.id,star]))},space={stars,links:[],regions:[],groupBy:'hierarchy'},draws=[],cores=[];
  const ownerDocument={createElement(){return{getContext(){return{createRadialGradient(){return{addColorStop(){}};},fillRect(){}};}};}};
  const context={canvas:{ownerDocument},fillRect(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},arc(x,y,r){cores.push({x,y,r});},fill(){},strokeRect(){},drawImage(sprite,x,y,width,height){draws.push({x,y,width,height});},measureText:text=>({width:text.length*6}),fillText(){}};
  paintKnowledgeSpace(context,space,projected,{width:400,height:220,selectedIds:['halo-2']});
  assert.equal(cores.length,3);assert.equal(draws.length,1,'Dim unrelated notes have no passive mist while active evidence remains highlighted.');assert.equal(draws[0].width,14);
  draws.length=0;cores.length=0;paintKnowledgeSpace(context,space,projected,{width:400,height:220});
  assert.equal(cores.length,3);assert.equal(draws.length,1,'Only the .9px core receives a passive halo; .55px cores are still drawn.');assert.equal(draws[0].width,7.2);assert.equal(draws[0].x,200-3.6);
});
