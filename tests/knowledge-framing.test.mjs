import test from 'node:test';
import assert from 'node:assert/strict';
import {createKnowledgeSpace,frameKnowledgeSpace,projectKnowledgeSpace,normalizeSpaceCamera,paintKnowledgeSpace} from '../src/knowledge-space.mjs';

const bounds=stars=>stars.reduce((box,star)=>({left:Math.min(box.left,star.x),right:Math.max(box.right,star.x),top:Math.min(box.top,star.y),bottom:Math.max(box.bottom,star.y)}),{left:Infinity,right:-Infinity,top:Infinity,bottom:-Infinity});
function assertFit(space,viewport,orientation={yaw:.42,pitch:-.24}) {
  const camera=frameKnowledgeSpace(space,viewport,{...orientation,zoom:2.2,panX:145,panY:-94});
  assert.equal(camera.yaw,orientation.yaw);assert.equal(camera.pitch,orientation.pitch);assert.ok(Object.values(camera).every(Number.isFinite));
  const stars=projectKnowledgeSpace({...space,regions:space.regions||[]},camera,viewport).stars;assert.equal(stars.length,space.stars.length);const box=bounds(stars);
  assert.ok(box.left>=13&&box.top>=13&&box.right<=viewport.width-13&&box.bottom<=viewport.height-13,JSON.stringify({viewport,camera,box}));
  assert.ok(Math.abs((box.left+box.right)/2-viewport.width/2)<1e-7);assert.ok(Math.abs((box.top+box.bottom)/2-viewport.height/2)<1e-7);return {camera,box};
}
function notes(count){return Array.from({length:count},(_,i)=>({id:'synthetic-'+i,path:'Synthetic/'+i+'.md',categoryId:'topic-'+i%6,layer:'role-'+i%4,hierarchyLevel:['overview','topic','detail','unassigned'][Math.floor(i/6)%4]}));}

test('hierarchy framing uses only displayed note positions, regardless of guide extents',()=>{
  const list=notes(30),space=createKnowledgeSpace({categories:[]},list),viewport={width:800,height:620};
  const camera=frameKnowledgeSpace(space,viewport);const guides={...space,regions:space.regions.map(region=>({...region,radius:1_000_000,center:{x:1_000_000,y:1_000_000,z:0}})),bands:[{corners:[{x:-1_000_000,y:1_000_000,z:0}],labelPoint:{x:1_000_000,y:-1_000_000,z:0}}]};
  assert.deepEqual(frameKnowledgeSpace(guides,viewport),camera);assertFit(space,viewport);
});
test('single related hierarchy note centers after the final bounded zoom',()=>{
  const list=[{id:'single',categoryId:'one',hierarchyLevel:'detail'}],space=createKnowledgeSpace({},list),viewport={width:600,height:420};
  const {camera}=assertFit(space,viewport);assert.ok(camera.zoom>5&&camera.zoom<64);const star=projectKnowledgeSpace({...space,regions:space.regions||[]},camera,viewport).stars[0];assert.ok(star.screenRadius>=2);
});
test('small real clusters can fill the viewport beyond the former five-times limit',()=>{
  const space={stars:[{id:'a',position:{x:80,y:70,z:0},radius:1},{id:'b',position:{x:120,y:90,z:0},radius:1}],regions:[],bands:[]},viewport={width:800,height:500};
  const {camera,box}=assertFit(space,viewport,{yaw:0,pitch:0});assert.ok(camera.zoom>5);assert.ok((box.right-box.left)/viewport.width>.85);
});
test('coincident and nearly coincident notes stay centered with finite bounded cameras',()=>{
  for(const delta of [0,1e-9,.001]){const space={stars:[{id:'a',position:{x:200,y:180,z:90},radius:1},{id:'b',position:{x:200+delta,y:180,z:90},radius:1}]};for(const viewport of [{width:390,height:600},{width:1200,height:900}]){const {camera}=assertFit(space,viewport);assert.ok(camera.zoom>=.35&&camera.zoom<=64);}}
});
test('actual note outliers participate in the fit while all IDs remain projected',()=>{
  const list=notes(100),space=createKnowledgeSpace({},list);space.stars[0].position={x:310,y:-240,z:90};space.stars.at(-1).position={x:-310,y:240,z:-90};const {box}=assertFit(space,{width:710,height:530});assert.ok(Math.max((box.right-box.left)/710,(box.bottom-box.top)/530)>.85);
});
test('708 and 4000 note graphs fill both desktop and phone viewports at retained orientations',()=>{
  for(const count of [708,4000]){const list=notes(count),space=createKnowledgeSpace({},list);for(const viewport of [{width:1030,height:710},{width:390,height:660},{width:650,height:190}])for(const orientation of [{yaw:.42,pitch:-.24},{yaw:-1.8,pitch:2.4}]){const {box}=assertFit(space,viewport,orientation);assert.ok(Math.max((box.right-box.left)/viewport.width,(box.bottom-box.top)/viewport.height)>.78);}}
});
test('viewport changes reframe the same subset without resetting yaw or pitch',()=>{
  const space=createKnowledgeSpace({},notes(80)),wide={width:1000,height:700},narrow={width:340,height:700};const first=frameKnowledgeSpace(space,wide,{yaw:.61,pitch:.23,panX:240,panY:-80});const next=frameKnowledgeSpace(space,narrow,first);assert.equal(next.yaw,first.yaw);assert.equal(next.pitch,first.pitch);assertFit(space,narrow,{yaw:first.yaw,pitch:first.pitch});assert.notEqual(next.panX,first.panX);
});
test('empty or entirely behind-camera subsets preserve the finite manual camera',()=>{
  const camera=normalizeSpaceCamera({yaw:0,pitch:0,zoom:8,panX:115,panY:-92});assert.deepEqual(frameKnowledgeSpace({stars:[]},{width:700,height:450},camera),camera);assert.deepEqual(frameKnowledgeSpace({stars:[{position:{x:1,y:1,z:-800}}]},{width:700,height:450},camera),camera);
});
test('bounded zoom is applied before centering a very tight off-center cluster',()=>{
  const space={stars:[{id:'a',radius:1,position:{x:240,y:220,z:0}},{id:'b',radius:1,position:{x:240.01,y:220.01,z:0}}]};const {camera}=assertFit(space,{width:900,height:640},{yaw:0,pitch:0});assert.equal(camera.zoom,64);assert.ok(Math.abs(camera.panX)>3000&&Math.abs(camera.panY)>3000);
});

test('fitting a small cluster enlarges painted star cores within the existing projected limit',()=>{
  const list=[{id:'a',categoryId:'one',hierarchyLevel:'detail'},{id:'b',categoryId:'one',hierarchyLevel:'detail'}],space=createKnowledgeSpace({},list),viewport={width:700,height:500};
  const radii=camera=>{const values=[],context={canvas:{},fillRect(){},beginPath(){},closePath(){},moveTo(){},lineTo(){},stroke(){},arc(x,y,r){values.push(r);},fill(){},strokeRect(){},measureText:text=>({width:text.length*6}),fillText(){}};paintKnowledgeSpace(context,space,projectKnowledgeSpace(space,camera,viewport),viewport);return values;};
  const normal=radii({zoom:1}),fitted=radii(frameKnowledgeSpace(space,viewport));assert.equal(fitted.length,2);assert.ok(fitted.every(radius=>radius>1.45&&radius<=2.4));assert.ok(fitted.every((radius,i)=>radius>normal[i]));
});
