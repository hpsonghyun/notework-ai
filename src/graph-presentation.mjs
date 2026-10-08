// Graph previews use the saved index only. They never read notes or call a provider.
const PREVIEW_LIMITS=Object.freeze({title:140,path:200,label:100,summary:220,excerpt:280});
const graphMetadata=new WeakMap();
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=(value,max)=>{if(typeof value!=='string')return '';let preview=value.slice(0,max);if(/[\uD800-\uDBFF]$/.test(preview))preview=preview.slice(0,-1);return preview.trim();};
const key=value=>typeof value==='string'||typeof value==='number'&&Number.isFinite(value)?String(value):'';
const items=value=>Array.isArray(value)?value:[];
const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
function metadata(index){
  if(!record(index))return{nodes:new Map(),categories:new Map(),roles:new Map(),levels:new Map(),relations:new Map(),neighbors:new Map()};
  const cached=graphMetadata.get(index);if(cached)return cached;
  const labels=values=>new Map(items(values).filter(record).map(item=>[key(item.id),text(item.label,PREVIEW_LIMITS.label)]));
  const value={nodes:new Map(items(index.nodes).filter(node=>record(node)&&key(node.id)).map(node=>[key(node.id),node])),categories:labels(index.categories),roles:labels(index.layers),levels:labels(index.hierarchyLevels),relations:new Map(),neighbors:new Map()};
  for(const edge of items(index.edges)){
    if(!record(edge))continue;const source=key(edge.source),target=key(edge.target);if(!source||source===target||!value.nodes.has(source)||!value.nodes.has(target))continue;
    for(const [id,other]of [[source,target],[target,source]]){value.relations.set(id,(value.relations.get(id)||0)+1);let neighbors=value.neighbors.get(id);if(!neighbors){neighbors=new Set();value.neighbors.set(id,neighbors);}neighbors.add(other);}
  }
  graphMetadata.set(index,value);return value;
}
function savedLabel(value,labels){
  const id=key(record(value)?value.id:value);return text(labels.get(id)|| (record(value)?value.label:'') ||id,PREVIEW_LIMITS.label)||'Unassigned';
}
function savedExcerpt(node,index){
  const path=text(node.path,4096),hash=text(node.contentHash||node.evidence?.contentHash,256);
  for(const chunk of items(node.evidence?.chunks)){
    if(!record(chunk)||chunk.path&&chunk.path!==path||hash&&chunk.contentHash&&chunk.contentHash!==hash)continue;
    const quote=text(chunk.quote,PREVIEW_LIMITS.excerpt);if(quote)return quote;
  }
  const ids=new Set(items(node.chunkIds).map(key));
  for(const chunk of items(index?.chunks)){
    if(!record(chunk)||!ids.has(key(chunk.id))||chunk.path!==path||hash&&chunk.contentHash!==hash)continue;
    const excerpt=text(chunk.text,PREVIEW_LIMITS.excerpt);if(excerpt)return excerpt;
  }
  return '';
}
/** Bounded display data from a node's saved labels, summary and original excerpts. */
export function buildGraphHoverDetails(node,index){
  node=record(node)?node:{};const saved=metadata(index),id=key(node.id);const classified=node.evidence?.status==='classified';
  return{
    id,title:text(node.title,PREVIEW_LIMITS.title)||text(node.path,PREVIEW_LIMITS.title)||'Untitled note',path:text(node.path,PREVIEW_LIMITS.path),
    category:savedLabel(node.categoryId??node.category,saved.categories),role:savedLabel(node.layer??node.type,saved.roles),level:savedLabel(node.hierarchyLevel,saved.levels),
    relationCount:saved.relations.get(id)||0,neighborCount:saved.neighbors.get(id)?.size||0,
    summary:text(node.summary,PREVIEW_LIMITS.summary),excerpt:savedExcerpt(node,index),
    classification:classified?'Saved AI labels':node.evidence?.status==='local'?'Local labels':'',analysis:classified?[text(node.evidence?.route,48),text(node.evidence?.model,100)].filter(Boolean).join(' / '):'',
  };
}
function element(container,tag,content,className){const node=container.ownerDocument.createElement(tag);if(content!==undefined)node.textContent=String(content);if(className)node.className=className;return node;}
function displayCount(value,singular,plural=singular+'s'){return value+' '+(value===1?singular:plural);}
/** Passive card: parent positions it inside the graph and controls hidden state. */
export function renderGraphHoverCard(container,details){
  container.replaceChildren();container.classList.add('nw-graph-hover-card');container.setAttribute('role','tooltip');container.setAttribute('aria-label','Saved note details');
  container.append(element(container,'strong',details.title,'nw-graph-hover-title'));
  if(details.path)container.append(element(container,'div',details.path,'nw-graph-hover-path'));
  const labels=element(container,'dl',undefined,'nw-graph-hover-labels');
  for(const [name,value]of [['Topic',details.category],['Type',details.role],['Level',details.level]]){const pair=element(container,'div');pair.append(element(container,'dt',name),element(container,'dd',value));labels.append(pair);}container.append(labels);
  container.append(element(container,'div',displayCount(details.relationCount,'connection')+' / '+displayCount(details.neighborCount,'neighbor'),'nw-graph-hover-connections'));
  if(details.summary){const block=element(container,'div',undefined,'nw-graph-hover-summary');block.append(element(container,'span','Saved summary'),element(container,'p',details.summary));container.append(block);}
  if(details.excerpt){const block=element(container,'div',undefined,'nw-graph-hover-excerpt');block.append(element(container,'span','Saved excerpt'),element(container,'p',details.excerpt));container.append(block);}
  if(!details.summary&&!details.excerpt)container.append(element(container,'p','No saved preview','nw-graph-hover-empty'));return container;
}
function regionColor(value){
  if(!Array.isArray(value)||value.length!==3||!value.every(number=>Number.isFinite(number)&&number>=0&&number<=255))return null;
  return 'rgb('+value.map(Math.round).join(', ')+')';
}
/** Overview counts the current visible selection, never substitutes index-wide category counts. */
export function buildGraphOverview(index,nodes,options={}){
  const saved=metadata(index),visible=items(nodes).filter(node=>record(node)&&key(node.id)),ids=new Set(visible.map(node=>key(node.id))),topics=new Set(visible.map(node=>key(node.categoryId??node.category)).filter(Boolean));
  let relations=0;for(const edge of items(index?.edges))if(record(edge)&&key(edge.source)!==key(edge.target)&&ids.has(key(edge.source))&&ids.has(key(edge.target)))relations++;
  const selected=new Set(items(options.selectedIds).map(key));const legend=[];const colorGroups=new Map();for(const region of items(options.regions)){if(!record(region))continue;const color=regionColor(region.color),label=text(region.label,PREVIEW_LIMITS.label);if(!color||!label)continue;const identity=label.normalize('NFC').toLocaleLowerCase()+'\u001f'+color;const existing=colorGroups.get(identity),level=text(saved.levels.get(key(region.levelId)),PREVIEW_LIMITS.label),members=count(region.count);if(existing){existing.count=existing.count!==null&&members!==null?existing.count+members:null;if(existing.level!==level)existing.level='';continue;}const entry={id:key(region.id),label,color,count:members,level};colorGroups.set(identity,entry);legend.push(entry);}
  return{visibleNotes:ids.size,scopeNotes:count(options.scopeNotes),indexedNotes:count(options.indexedNotes)??saved.nodes.size,topics:topics.size,relations,selectedNotes:[...selected].filter(id=>ids.has(id)).length,matchingNotes:count(options.matchingNotes),evidenceNotes:count(options.evidenceNotes),legend:legend.slice(0,6),additionalGroups:Math.max(0,legend.length-6),legendName:options.groupBy==='layers'?'Note type colors':'Topic colors'};
}
/** Quiet graph strip; informational only, with no pointer targets or inferred colors. */
export function renderGraphOverview(container,details){
  container.replaceChildren();container.classList.add('nw-graph-overview');container.setAttribute('aria-label','Visible graph information');
  const counts=element(container,'div',undefined,'nw-graph-overview-counts');counts.append(element(container,'span',displayCount(details.visibleNotes,'visible note')));if(details.scopeNotes!==null)counts.append(element(container,'span',displayCount(details.scopeNotes,'note in scope','notes in scope')));counts.append(element(container,'span',displayCount(details.topics,'topic')),element(container,'span',displayCount(details.relations,'connection')));if(details.evidenceNotes!==null)counts.append(element(container,'span',displayCount(details.evidenceNotes,'evidence note')));container.append(counts);
  if(details.legend.length){const legend=element(container,'div',undefined,'nw-graph-color-key');legend.setAttribute('aria-label',details.legendName);for(const item of details.legend){const entry=element(container,'span',undefined,'nw-graph-color-entry');const dot=element(container,'i');dot.setAttribute('aria-hidden','true');dot.style.setProperty('--nw-region-color',item.color);entry.append(dot,element(container,'span',item.label));legend.append(entry);}if(details.additionalGroups)legend.append(element(container,'span','+'+details.additionalGroups+' groups','nw-graph-color-more'));container.append(legend);}return container;
}
