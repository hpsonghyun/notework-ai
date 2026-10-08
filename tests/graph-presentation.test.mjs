import test from 'node:test';
import assert from 'node:assert/strict';
import {buildGraphHoverDetails,renderGraphHoverCard,buildGraphOverview,renderGraphOverview} from '../src/graph-presentation.mjs';

const node={id:'a',title:'Research methods',path:'Research/Methods.md',category:'method',layer:'reference',hierarchyLevel:'detail',contentHash:'saved-hash',summary:'The saved summary describes the method.',chunkIds:['chunk-a'],evidence:{status:'classified',route:'jev',model:'saved-model',chunks:[{path:'Research/Methods.md',contentHash:'saved-hash',quote:'The original saved excerpt describes the evidence.'}]}};
function index(){return{nodes:[node,{id:'b',category:'concept'},{id:'c',category:'method'}],categories:[{id:'method',label:'Methods'},{id:'concept',label:'Concepts'}],layers:[{id:'reference',label:'Reference'}],hierarchyLevels:[{id:'detail',label:'Level 3 · Detail'}],edges:[{source:'a',target:'b',kind:'topic'},{source:'b',target:'a',kind:'supports'},{source:'a',target:'c',kind:'extends'},{source:'a',target:'outside'},{source:'a',target:'a'}],chunks:[{id:'chunk-a',path:node.path,contentHash:'saved-hash',text:'The saved chunk text.'}]};}

test('hover resolves actual saved topic, note type, level and scoped relation counts',()=>{
  const details=buildGraphHoverDetails(node,index());assert.equal(details.title,node.title);assert.equal(details.path,node.path);assert.equal(details.category,'Methods');assert.equal(details.role,'Reference');assert.equal(details.level,'Level 3 · Detail');assert.equal(details.relationCount,3);assert.equal(details.neighborCount,2);assert.equal(details.summary,node.summary);assert.equal(details.excerpt,node.evidence.chunks[0].quote);assert.equal(details.classification,'Saved AI labels');assert.equal(details.analysis,'jev / saved-model');
});
test('missing labels remain Unassigned and local labels are not presented as AI analysis',()=>{
  const details=buildGraphHoverDetails({id:'a',path:node.path,evidence:{status:'local'}},{nodes:[{id:'a'}]});assert.equal(details.category,'Unassigned');assert.equal(details.role,'Unassigned');assert.equal(details.level,'Unassigned');assert.equal(details.classification,'Local labels');assert.equal(details.analysis,'');assert.equal(details.excerpt,'');assert.equal(details.summary,'');assert.equal(details.relationCount,0);assert.equal(buildGraphHoverDetails(null,null).classification,'');
});
test('hover only uses saved excerpts belonging to the same path, hash and chunk IDs',()=>{
  const saved=index(),mismatch={...node,evidence:{chunks:[{path:'Outside/Private.md',quote:'Wrong path'},{path:node.path,contentHash:'changed-hash',quote:'Wrong hash'}]}};assert.equal(buildGraphHoverDetails(mismatch,saved).excerpt,'The saved chunk text.');const wrongIndex={...saved,chunks:[{id:'chunk-a',path:node.path,contentHash:'different',text:'Wrong source'},{id:'unrelated',path:node.path,contentHash:'saved-hash',text:'Wrong chunk'}]};assert.equal(buildGraphHoverDetails(mismatch,wrongIndex).excerpt,'');
});
test('huge saved text is bounded and truncated Unicode does not expose a dangling surrogate',()=>{
  const huge='x'.repeat(1000000),details=buildGraphHoverDetails({...node,title:'x'.repeat(139)+'😀',path:huge,summary:huge,evidence:{chunks:[{quote:huge}]}},index());assert.ok(details.title.length<=140&&!/[\uD800-\uDBFF]$/.test(details.title));assert.ok(details.path.length<=200);assert.ok(details.summary.length<=220);assert.ok(details.excerpt.length<=280);
});
test('relation metadata is cached for immutable saved indexes instead of scanned on every hover',()=>{
  const saved=index(),original=saved.edges;let scans=0;saved.edges=new Proxy(original,{get(target,property,receiver){if(property===Symbol.iterator)scans++;return Reflect.get(target,property,receiver);}});for(let i=0;i<200;i++)assert.equal(buildGraphHoverDetails(node,saved).relationCount,3);assert.equal(scans,1);
});
test('overview counts only visible note IDs and saved in-view connections',()=>{
  const saved=index(),details=buildGraphOverview(saved,[node,saved.nodes[1],node],{scopeNotes:9,matchingNotes:4,evidenceNotes:1,selectedIds:['a','outside']});assert.equal(details.visibleNotes,2);assert.equal(details.scopeNotes,9);assert.equal(details.indexedNotes,3);assert.equal(details.topics,2);assert.equal(details.relations,2);assert.equal(details.selectedNotes,1);assert.equal(details.matchingNotes,4);assert.equal(details.evidenceNotes,1);assert.equal(buildGraphOverview(saved,[]).visibleNotes,0);assert.equal(buildGraphOverview(saved,[],{scopeNotes:-1}).scopeNotes,null);
});
test('overview colors come only from real region colors and the displayed key is bounded',()=>{
  const regions=Array.from({length:10},(_,i)=>({id:'r'+i,label:'Topic '+i,color:[120+i,180,200],count:2}));regions.push({id:'unsafe',label:'Wrong color',color:'url(https://example.invalid)'});const details=buildGraphOverview(index(),[node],{regions,groupBy:'layers'});assert.equal(details.legend.length,6);assert.equal(details.additionalGroups,4);assert.equal(details.legend[0].color,'rgb(120, 180, 200)');assert.equal(details.legendName,'Note type colors');
});
test('hierarchy repetition cannot consume legend slots while distinct same-color topics remain visible',()=>{
  const regions=[...Array.from({length:12},(_,i)=>({id:'level-'+i,label:i%2?' Methods ':'methods',color:[100,180,200],count:1})),{id:'other-topic',label:'Questions',color:[100,180,200],count:2},...Array.from({length:5},(_,i)=>({id:'other-'+i,label:'Topic '+i,color:[130,190,210],count:1}))];const details=buildGraphOverview(index(),[node],{regions});assert.equal(details.legend.length,6);assert.equal(details.additionalGroups,1);assert.equal(details.legend[0].count,12);assert.equal(details.legend[0].label,'methods');assert.equal(details.legend[1].label,'Questions');assert.equal(details.legend[0].color,details.legend[1].color);assert.deepEqual(details.legend.slice(2).map(item=>item.label),['Topic 0','Topic 1','Topic 2','Topic 3']);
});

class SafeDOM {
  constructor(tag,doc){this.tagName=tag.toUpperCase();this.ownerDocument=doc;this.children=[];this.attributes={};this.classes=new Set();this.classList={add:value=>this.classes.add(value)};this.style={setProperty:(name,value)=>{this.style[name]=value;}};this.textContent='';}
  set innerHTML(_){throw new Error('HTML injection is forbidden');}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.children=[...nodes];}
  setAttribute(name,value){this.attributes[name]=value;}
}
function container(){const doc={createElement:tag=>new SafeDOM(tag,doc)};return new SafeDOM('div',doc);}
const flattened=node=>node.textContent+node.children.map(flattened).join('');
test('hover renderer treats note HTML as inert text and adds no controls or provenance prose',()=>{
  const root=container(),details=buildGraphHoverDetails({...node,title:'<img src=x onerror=attack()>',summary:'<script>attack()</script>'},index());renderGraphHoverCard(root,details);assert.equal(root.attributes.role,'tooltip');assert.ok(flattened(root).includes('<img src=x onerror=attack()>'));assert.ok(flattened(root).includes('<script>attack()</script>'));assert.ok(!flattened(root).includes('jev / saved-model'));const tags=[];function visit(node){tags.push(node.tagName);node.children.forEach(visit);}visit(root);assert.ok(!tags.some(tag=>['IMG','SCRIPT','BUTTON','A','INPUT'].includes(tag)));renderGraphHoverCard(root,buildGraphHoverDetails({},{}));assert.ok(!flattened(root).includes('attack()'));assert.ok(flattened(root).includes('Unassigned'));
});
test('overview renderer exposes accurate counts and safe real color styles as a passive strip',()=>{
  const root=container(),details=buildGraphOverview(index(),[node],{scopeNotes:8,evidenceNotes:1,regions:[{id:'method',label:'<script>Topic</script>',color:[100,180,200]}]});renderGraphOverview(root,details);assert.equal(root.attributes['aria-label'],'Visible graph information');assert.ok(flattened(root).includes('1 visible note'));assert.ok(flattened(root).includes('8 notes in scope'));assert.ok(flattened(root).includes('1 evidence note'));assert.ok(flattened(root).includes('<script>Topic</script>'));const dot=root.children[1].children[0].children[0];assert.equal(dot.style['--nw-region-color'],'rgb(100, 180, 200)');assert.equal(dot.attributes['aria-hidden'],'true');
});
