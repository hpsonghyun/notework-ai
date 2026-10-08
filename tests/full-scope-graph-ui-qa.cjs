const fs=require('fs');
const path=require('path');
const http=require('http');
const crypto=require('crypto');
const {chromium}=require(process.env.NOTEWORK_PLAYWRIGHT_PATH||'playwright');
const {attachKnowledgeBridge}=require('./ui-qa.cjs');

const project=path.resolve(__dirname,'..');
const output=process.env.NOTEWORK_QA_OUTPUT||path.join(project,'qa-output','full-scope-graph');
fs.mkdirSync(output,{recursive:true});
const tracked=['src/ui.mjs','styles.css','src/controller.mjs','src/knowledge-space.mjs','src/knowledge-engine.mjs','src/vault-search.mjs'];
const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(path.join(project,file))).digest('hex');
const moduleHashes=()=>Object.fromEntries(tracked.map(file=>[file,digest(file)]));
const report={startedAt:new Date().toISOString(),syntheticContentOnly:true,productionModules:moduleHashes(),checks:[],screenshots:[],pageErrors:[],externalRequests:[],limitations:['707 synthetic Markdown notes are indexed through the production controller and KnowledgeEngine using explicit local keyword indexing.','Category and layer labels are assigned synthetic metadata for UI filtering tests; they do not assert model analysis quality.','Provider replies and account state are synthetic; no live authentication, billing, or real vault content is used.','Chromium UI verification is separate from actual desktop Obsidian installation.']};
function check(name,value,details){report.checks.push({name,passed:!!value,...(details===undefined?{}:{details})});if(!value)throw Error(name+': '+JSON.stringify(details));}
const button=(page,name)=>page.getByRole('button',{name,exact:true});
const frames=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
const settled=page=>page.waitForFunction(()=>window.fixtureReady&&!window.fixture.controller.state.busy);
async function counts(page){return page.locator('.nw-space-count').evaluate(node=>({text:node.textContent,shown:Number(node.dataset.visibleNotes),scoped:Number(node.dataset.scopeNotes),indexed:Number(node.dataset.indexedNotes),current:Number(node.dataset.currentScopeNotes),missing:Number(node.dataset.unindexedNotes)}));}
async function projection(page){return page.locator('.nw-space-canvas').evaluate(canvas=>{const points=JSON.parse(canvas.dataset.projection),box=canvas.getBoundingClientRect();return{count:Number(canvas.dataset.stars),unique:new Set(points.map(point=>point.id)).size,inViewport:points.filter(point=>point.x>=0&&point.y>=0&&point.x<=box.width&&point.y<=box.height).length,ids:points.map(point=>point.id),camera:JSON.parse(canvas.dataset.camera)};});}
async function choose(page,id){await page.locator('.nw-star-control[data-node-id="'+id+'"]').focus();await page.keyboard.press('Enter');await frames(page);}

async function run(page,origin){
  page.on('pageerror',error=>report.pageErrors.push(String(error)));page.on('request',request=>{if(/^https?:/i.test(request.url())&&!request.url().startsWith(origin+'/'))report.externalRequests.push(request.url());});
  await page.goto(origin+'/tests/ui-fixture.html?surface=settings');await page.waitForFunction(()=>window.fixtureReady);
  await page.evaluate(async()=>{
    const f=window.fixture;f.files.splice(0);f.notes.splice(0);f.folders.splice(0);f.tags.clear();f.folders.push({path:'Synthetic',name:'Synthetic',children:[]});
    for(let number=0;number<707;number++){
      const notePath='Synthetic/note-'+String(number).padStart(4,'0')+'.md',content='# Synthetic note '+number+'\n\nSynthetic knowledge evidence '+number+' provides a local backend source.\n\nEND_SYNTHETIC_SOURCE_'+number;
      f.notes.push({path:notePath,content});f.files.push({path:notePath,name:notePath.split('/').pop(),stat:{size:content.length,mtime:1,ctime:1}});f.tags.set(notePath,[]);
    }
    f.controller.setScope({mode:'folders',include:['Synthetic'],exclude:[],tags:[],excludeTags:[]});await f.controller.configureKnowledge({embeddingRoute:'lexical',semanticRoute:'none',limitNotes:false,limitCalls:false,limitChunks:false});await f.controller.buildKnowledge({consent:true});
    f.control.fullGraphIndex=structuredClone(f.controller.state.knowledge.index);
  });await settled(page);
  const built=await page.evaluate(()=>({phase:window.fixture.controller.state.knowledge.phase,nodes:window.fixture.controller.state.knowledge.index?.nodes.length,stats:window.fixture.controller.state.knowledge.index?.stats}));
  check('Full selected scope produces707 indexed source notes',built.phase==='ready'&&built.nodes===707&&built.stats.selectedNotes===707&&built.stats.indexedNotes===707&&built.stats.limitedNotes===0&&built.stats.truncatedNotes===0,built);
  await page.evaluate(()=>{
    const f=window.fixture,index=f.controller.state.knowledge.index;index.categories=Array.from({length:7},(_,i)=>({id:'topic-'+i,label:'Synthetic topic '+i}));index.layers=[{id:'reference',label:'Reference'},{id:'knowledge',label:'Knowledge'},{id:'action',label:'Action'}];index.nodes.forEach((node,number)=>{node.category='topic-'+Math.floor(number/101);node.layer=['reference','knowledge','action'][number%3];});f.control.fullGraphIndex=structuredClone(index);
    f.ui.destroy();const app=document.getElementById('app');app.className='';app.replaceChildren();app.style.cssText='height:calc(100vh - 35px);width:100%;margin:0';f.ui=f.mount('workspace',app);f.controller.set({models:f.catalogs.chatgpt,model:f.catalogs.chatgpt[0].id,verified:true,connection:'connected'});
  });await frames(page);
  let count=await counts(page),points=await projection(page);
  check('Full graph exposes707 stars and707 accessible source controls',count.shown===707&&count.scoped===707&&count.indexed===707&&count.current===707&&count.missing===0&&points.count===707&&points.unique===707&&await page.locator('.nw-star-control').count()===707,{count,projection:{count:points.count,unique:points.unique,inViewport:points.inViewport}});
  check('Initial full graph automatically fits all707 stars into the viewport',points.inViewport===707,{count:points.count,inViewport:points.inViewport,camera:points.camera});
  check('A complete index has no missing-coverage or retained-failure warning',await page.locator('.nw-index-coverage').count()===0);
  const baseCamera=JSON.stringify(points.camera);await page.locator('.nw-space-canvas').focus();await page.keyboard.press('ArrowRight');await page.keyboard.press('+');
  const moved=(await projection(page)).camera;await page.evaluate(()=>window.fixture.controller.set({status:'Synthetic status refresh'}));await frames(page);
  check('Ordinary status refresh preserves manually positioned full graph',JSON.stringify((await projection(page)).camera)===JSON.stringify(moved));
  await button(page,'Reset camera').click();check('Reset camera restores the fit of all707 actual stars',(await projection(page)).inViewport===707&&JSON.stringify((await projection(page)).camera)===baseCamera);
  await button(page,'Synthetic topic 0 (101)').click();await frames(page);count=await counts(page);points=await projection(page);
  check('Topic filtering explains101 shown versus707 scope-indexed notes',count.shown===101&&count.scoped===707&&count.current===707&&count.text.includes('Category: Synthetic topic 0')&&points.count===101&&points.inViewport===101,count);
  await page.locator('.nw-layer-regions [data-layer="reference"]').click();await frames(page);count=await counts(page);points=await projection(page);
  check('Layer filtering explains its precise subset without losing total coverage',count.shown===34&&count.scoped===707&&count.text.includes('Layer: Reference')&&points.count===34,count);
  await button(page,'All layers').click();await frames(page);check('All layers restores every note of the selected category',(await counts(page)).shown===101&&(await projection(page)).count===101);
  await button(page,'All notes (707)').click();await frames(page);check('All notes removes category/layer filters and refits the complete index',(await counts(page)).shown===707&&(await projection(page)).inViewport===707);
  const lastId=await page.evaluate(()=>window.fixture.controller.state.knowledge.index.nodes[706].id);await choose(page,lastId);await page.waitForFunction(()=>document.querySelector('.nw-note-preview-content')?.textContent.includes('END_SYNTHETIC_SOURCE_706'));
  check('A source after former60/200 ceilings opens its complete local preview',(await page.locator('.nw-note-preview-content').innerText()).includes('END_SYNTHETIC_SOURCE_706')&&await page.evaluate(id=>window.fixture.controller.state.knowledge.selectedNodeIds.join('|')===id,lastId));
  await button(page,'Chat with this selection').click();await page.locator('[data-focus-id="question"]').fill('Explain this synthetic knowledge evidence');await page.locator('.nw-chat-composer input[type="checkbox"]').check();await button(page,'Send question').click();await settled(page);
  check('Last indexed note remains the actual selected chat retrieval boundary',await page.evaluate(id=>{const c=window.fixture.controller,node=c.state.knowledge.index.nodes.find(node=>node.id===id);return c.state.sources.length>0&&c.state.sources.every(source=>source.path===node.path)&&c.state.knowledge.selectedNodeIds.join('|')===id;},lastId));
  await button(page,'All notes (707)').click();await frames(page);const screenshot=path.join(output,'full-scope-707-stars.png');await page.screenshot({path:screenshot,fullPage:false});report.screenshots.push(screenshot);
  await page.evaluate(()=>{
    const f=window.fixture,full=structuredClone(f.control.fullGraphIndex),retained={...full,id:'synthetic-retained-old-index',nodes:full.nodes.slice(0,65),edges:[]};f.controller.set({knowledge:{...f.controller.state.knowledge,index:retained,phase:'failed',lastBuildError:'Synthetic read failure prevented the latest build.',selectedCategory:'all',selectedNodeIds:[],selectedNodesActive:false}});
  });await frames(page);count=await counts(page);
  check('Retained small index distinguishes65 stars from707 current scope notes',count.shown===65&&count.scoped===65&&count.current===707&&count.missing===642&&count.indexed===65&&await button(page,'All notes (65)').count()===1,count);
  check('Failed latest build visibly explains previous index retention and missing notes',(await page.locator('.nw-index-coverage').innerText()).includes('The last build failed. The previously saved index is still in use.')&&(await page.locator('.nw-index-coverage').innerText()).includes('642 of 707 current scope notes are not present in this index.')&&(await page.locator('.nw-index-coverage').innerText()).includes('Synthetic read failure'));
  await button(page,'Open build settings').click();check('Retained-index notice opens actual build settings entry point',await page.evaluate(()=>window.fixture.trace.opened.some(value=>value.surface==='settings'&&value.view==='build')));
  await page.evaluate(()=>window.fixture.controller.setScope({mode:'folders',include:['Synthetic'],exclude:[],tags:[],excludeTags:[]}));await frames(page);
  check('Scope status updates do not conceal a retained last-build error',(await page.locator('.nw-index-coverage').innerText()).includes('Synthetic read failure'));
  await page.evaluate(()=>{const f=window.fixture;f.controller.set({knowledge:{...f.controller.state.knowledge,index:structuredClone(f.control.fullGraphIndex),phase:'ready',lastBuildError:'',selectedCategory:'all',selectedNodeIds:[],selectedNodesActive:false}});});await frames(page);
  check('Successful replacement removes retained-error notice and restores all707 graph nodes',await page.locator('.nw-index-coverage').count()===0&&(await counts(page)).shown===707&&(await projection(page)).count===707);
  await page.evaluate(()=>window.fixture.controller.setScope({mode:'folders',include:['Synthetic'],exclude:['Synthetic/note-0706.md'],tags:[],excludeTags:[]}));await frames(page);count=await counts(page);
  check('Live scope exclusions remain enforced while saved-index count stays visible',count.shown===706&&count.scoped===706&&count.indexed===707&&count.current===706&&count.missing===0&&count.text.includes('707 in the saved build')&&(await projection(page)).ids.every(id=>id!==lastId),count);
  check('Full-scope graph UI has no browser errors or external requests',report.pageErrors.length===0&&report.externalRequests.length===0,{pageErrors:report.pageErrors,externalRequests:report.externalRequests});
}

(async()=>{
  let browser,server;
  try{
    const allowed=new Set(['tests/ui-fixture.html','styles.css',...fs.readdirSync(path.join(project,'src')).filter(file=>file.endsWith('.mjs')).map(file=>'src/'+file),'src/providers/claude-login-url.mjs']);server=http.createServer((request,response)=>{const file=new URL(request.url,'http://127.0.0.1').pathname.slice(1);if(!allowed.has(file)){response.writeHead(404);response.end();return;}response.setHeader('Cache-Control','no-store');response.setHeader('Content-Type',file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8');response.end(fs.readFileSync(path.join(project,file)));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
    browser=await chromium.launch({headless:true,executablePath:process.env.NOTEWORK_CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--disable-gpu']});const context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage();await attachKnowledgeBridge(page);await run(page,origin);
  }catch(error){report.failure=String(error);}
  finally{
    if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));report.finishedAt=new Date().toISOString();report.productionModulesAtEnd=moduleHashes();report.sourceChangedDuringRun=JSON.stringify(report.productionModules)!==JSON.stringify(report.productionModulesAtEnd);report.passed=!report.failure&&!report.sourceChangedDuringRun&&report.checks.every(check=>check.passed);if(!report.passed)process.exitCode=1;const reportPath=path.join(output,'full-scope-graph-ui-report.json');fs.writeFileSync(reportPath,JSON.stringify(report,null,2));process.stdout.write(JSON.stringify({passed:report.passed,checks:report.checks.length,failedChecks:report.checks.filter(check=>!check.passed).map(check=>check.name),failure:report.failure,sourceChangedDuringRun:report.sourceChangedDuringRun,report:reportPath},null,2));
  }
})();
