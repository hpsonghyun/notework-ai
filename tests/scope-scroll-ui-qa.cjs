const fs=require('fs');
const path=require('path');
const http=require('http');
const crypto=require('crypto');
const {chromium}=require(process.env.NOTEWORK_PLAYWRIGHT_PATH||'playwright');

const project=path.resolve(__dirname,'..');
const baseline=process.env.NOTEWORK_BASELINE_SOURCE?path.resolve(process.env.NOTEWORK_BASELINE_SOURCE):null;
const expectRegression=process.argv.includes('--expect-regression');
const output=process.env.NOTEWORK_QA_OUTPUT||path.join(project,'qa-output','scope-scroll');
fs.mkdirSync(output,{recursive:true});
const tracked=['src/ui.mjs','styles.css','src/controller.mjs','src/vault-search.mjs'];
const sourceFile=file=>baseline&&['src/ui.mjs','styles.css'].includes(file)?path.join(baseline,file):path.join(project,file);
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const moduleHashes=()=>Object.fromEntries(tracked.map(file=>[file,hash(sourceFile(file))]));
const report={startedAt:new Date().toISOString(),expectRegression,baselineSource:baseline,syntheticContentOnly:true,productionModules:moduleHashes(),fixtureSha256:hash(path.join(project,'tests/ui-fixture.html')),testSha256:hash(__filename),checks:[],screenshots:[],pageErrors:[],externalRequests:[],downloads:[],popups:[],limitations:['Production settings UI/controller run with synthetic dense folders, notes and tags only.','The DOM uses the Obsidian settings modal class ancestry inside Chromium; this does not prove a native Obsidian installation.','Clicks and keyboard Space use real browser input, with measurements after two animation frames. No provider requests or vault reads are performed.']};
function check(name,passed,details){report.checks.push({name,passed:!!passed,...(details===undefined?{}:{details})});}
const button=(page,name)=>page.getByRole('button',{name,exact:true});
const checkbox=(page,label)=>page.getByRole('checkbox',{name:label,exact:true});
const folderLabel=folder=>'Include folder '+folder;
const tagLabel=tag=>'Include tag '+tag;
const frames=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));

async function setup(page,origin){
  page.on('pageerror',error=>report.pageErrors.push(String(error)));
  page.on('request',request=>{if(/^https?:/i.test(request.url())&&!request.url().startsWith(origin+'/'))report.externalRequests.push(request.url());});
  page.on('download',download=>report.downloads.push(download.suggestedFilename()));
  page.on('popup',popup=>report.popups.push(popup.url()));
  await page.goto(origin+'/tests/ui-fixture.html?surface=settings');
  await page.waitForFunction(()=>window.fixtureReady);
  await page.evaluate(()=>{
    const f=window.fixture;
    f.ui.destroy();
    f.files.splice(0);f.folders.splice(0);f.notes.splice(0);f.tags.clear();
    for(let number=0;number<36;number++){
      const stem='Project '+String(number).padStart(2,'0');
      const branchPaths=[stem,stem+'/Branch A',stem+'/Branch A/Deep evidence',stem+'/Branch B'];
      for(const folderPath of branchPaths)f.folders.push({path:folderPath,name:folderPath.split('/').pop(),children:[]});
      for(const [index,folderPath]of branchPaths.entries()){
        const notePath=folderPath+'/synthetic-source-'+index+'.md',content='Synthetic source for scope scroll regression '+number+' '+index;
        f.notes.push({path:notePath,content});
        f.files.push({path:notePath,name:notePath.split('/').pop(),stat:{size:content.length,mtime:1,ctime:1}});
        f.tags.set(notePath,['#topic'+String(number).padStart(2,'0'),...(index===2?['#topic'+String(number).padStart(2,'0')+'/child']:[])]);
      }
    }
    f.vault.getMarkdownFiles=()=>f.files;
    f.vault.getFiles=()=>f.files;
    f.vault.getAllLoadedFiles=()=>[...f.folders,...f.files];
    f.vault.getAbstractFileByPath=notePath=>[...f.files,...f.folders].find(file=>file.path===notePath)||null;
    const scope={mode:'all',include:[],exclude:[],tags:[],excludeTags:[]};
    f.controller.settings.scope=structuredClone(scope);
    f.controller.set({scope,status:'Synthetic scope settings are ready.'});
    document.querySelector('.fixture-notice').style.display='none';
    document.body.style.cssText='margin:0;overflow:hidden;';
    const app=document.getElementById('app');app.className='';app.removeAttribute('style');app.replaceChildren();
    const modal=document.createElement('div');modal.className='modal';modal.style.cssText='position:fixed;left:100px;top:35px;width:820px;height:680px;border:1px solid #dfdfe8;background:white;';
    const modalContent=document.createElement('div');modalContent.className='modal-content';modalContent.style.cssText='height:100%;overflow:hidden;padding:20px;box-sizing:border-box;';
    const tabs=document.createElement('div');tabs.className='vertical-tab-content-container';tabs.style.cssText='height:100%;overflow:hidden;';
    const outer=document.createElement('div');outer.className='vertical-tab-content';outer.style.cssText='height:580px;overflow:auto;scrollbar-gutter:stable;';
    const lead=document.createElement('div');lead.style.height='75px';
    const target=document.createElement('div');target.id='scope-settings-root';
    const tail=document.createElement('div');tail.style.height='180px';
    outer.append(lead,target,tail);tabs.append(outer);modalContent.append(tabs);modal.append(modalContent);app.append(modal);
    f.ui=f.mount('settings',target);f.ui.setView('scope');
  });
  await button(page,'Expand all').click();
  await frames(page);
  check('Dense PC settings fixture has real folder and tag catalogs',await page.evaluate(()=>window.fixture.files.length===144&&window.fixture.folders.length===144&&document.querySelectorAll('.nw-folder-row').length===144));
  check('Settings root uses the Obsidian modal scroll ancestry',await page.locator('#scope-settings-root').evaluate(root=>root.closest('.vertical-tab-content')?.closest('.vertical-tab-content-container')?.closest('.modal-content')?.closest('.modal')!==null));
}

async function prepare(page,label,listSelector,{entireVault=false}={}){
  await page.evaluate(({label,listSelector,entireVault})=>{
    const outer=document.querySelector('.vertical-tab-content'),list=document.querySelector(listSelector);
    const input=[...document.querySelectorAll('input[type=checkbox]')].find(input=>input.getAttribute('aria-label')===label||label==='Entire vault'&&input.dataset.focusId==='scope-all');
    if(!input||!list)throw Error('Synthetic checkbox or scope list is missing: '+label);
    const row=input.closest('.nw-folder-row,.nw-tag-choice')||input.closest('label');
    if(entireVault){list.scrollTop=350;outer.scrollTop+=row.getBoundingClientRect().top-(outer.getBoundingClientRect().top+95);}
    else{
      outer.scrollTop+=list.getBoundingClientRect().top-(outer.getBoundingClientRect().top+105);
      list.scrollTop+=row.getBoundingClientRect().top-(list.getBoundingClientRect().top+125);
    }
    input.focus({preventScroll:true});
  },{label,listSelector,entireVault});
  await frames(page);
  return snapshot(page,label,listSelector,true);
}

async function snapshot(page,label,listSelector,remember=false){
  return page.evaluate(({label,listSelector,remember})=>{
    const outer=document.querySelector('.vertical-tab-content'),list=document.querySelector(listSelector);
    const input=[...document.querySelectorAll('input[type=checkbox]')].find(input=>input.getAttribute('aria-label')===label||label==='Entire vault'&&input.dataset.focusId==='scope-all');
    if(!input||!list)throw Error('Synthetic checkbox or scope list is missing after update: '+label);
    const row=input.closest('.nw-folder-row,.nw-tag-choice')||input.closest('label'),rect=row.getBoundingClientRect(),inputRect=input.getBoundingClientRect(),labelRect=input.closest('label').getBoundingClientRect();
    if(remember)window.__scopeScrollRefs={input,list};
    const old=window.__scopeScrollRefs;
    return{outerTop:outer.scrollTop,listTop:list.scrollTop,rowY:rect.top,rowHeight:rect.height,checked:input.checked,partial:input.indeterminate,focused:document.activeElement===input,sameInput:old?.input===input,sameList:old?.list===list,expanded:JSON.stringify([...window.fixture.ui.folderExpanded].sort()),inputPoint:{x:inputRect.x+inputRect.width/2,y:inputRect.y+inputRect.height/2},labelPoint:{x:Math.min(labelRect.right-4,inputRect.right+45),y:labelRect.y+Math.min(labelRect.height/2,14)},inputVisible:inputRect.top>outer.getBoundingClientRect().top&&inputRect.bottom<outer.getBoundingClientRect().bottom};
  },{label,listSelector,remember});
}

function measureStability(name,before,after,{identity=true,expansion=true}={}){
  check(name+' keeps outer and nested scroll positions',Math.abs(before.outerTop-after.outerTop)<.51&&Math.abs(before.listTop-after.listTop)<.51,{before,after});
  check(name+' keeps the visible row position and height',Math.abs(before.rowY-after.rowY)<.51&&Math.abs(before.rowHeight-after.rowHeight)<.51,{before:{y:before.rowY,height:before.rowHeight},after:{y:after.rowY,height:after.rowHeight}});
  check(name+' retains checkbox focus',after.focused,{before:before.focused,after:after.focused});
  if(identity)check(name+' updates checkbox and list DOM in place',after.sameInput&&after.sameList,{sameInput:after.sameInput,sameList:after.sameList});
  if(expansion)check(name+' keeps explicit folder expansion state',before.expanded===after.expanded);
}

async function toggle(page,label,listSelector,method,name,{entireVault=false}={}){
  const before=await prepare(page,label,listSelector,{entireVault});
  if(!before.inputVisible)throw Error('Synthetic target is not visible before browser input: '+label);
  if(method==='keyboard')await page.keyboard.press('Space');
  else{const point=method==='label'?before.labelPoint:before.inputPoint;await page.mouse.click(point.x,point.y);}
  await frames(page);
  const after=await snapshot(page,label,listSelector);
  check(name+' changes the requested checked state',before.partial?after.checked&&!after.partial:after.checked!==before.checked,{before:{checked:before.checked,partial:before.partial},after:{checked:after.checked,partial:after.partial}});
  measureStability(name,before,after);
  return after;
}

async function emission(page,label,listSelector,name){
  const before=await prepare(page,label,listSelector);
  await page.evaluate(()=>window.fixture.controller.set({status:'Synthetic unrelated controller status changed.'}));
  await frames(page);
  const after=await snapshot(page,label,listSelector);
  measureStability(name,before,after,{identity:false});
  check(name+' preserves the draft selection',before.checked===after.checked&&before.partial===after.partial);
}

async function explicitBranch(page,folder,expanded){
  const label=folderLabel(folder);let before=await prepare(page,label,'.nw-folder-list');
  const action=button(page,(expanded?'Expand ':'Collapse ')+folder);
  if(!await action.count()){
    check('Explicit '+(expanded?'expand':'collapse')+' action remains available after checkbox changes',false,{folder,expanded});
    if(!expectRegression)return;
    await button(page,(expanded?'Collapse ':'Expand ')+folder).click();await frames(page);before=await prepare(page,label,'.nw-folder-list');
  }
  const box=await action.boundingBox();
  await page.mouse.click(box.x+box.width/2,box.y+box.height/2);await frames(page);
  const after=await snapshot(page,label,'.nw-folder-list');
  check('Explicit '+(expanded?'expand':'collapse')+' keeps outer and nested scroll positions',Math.abs(before.outerTop-after.outerTop)<.51&&Math.abs(before.listTop-after.listTop)<.51,{before,after});
  check('Explicit '+(expanded?'expand':'collapse')+' keeps clicked parent at the same screen position',Math.abs(before.rowY-after.rowY)<.51,{before:before.rowY,after:after.rowY});
  check('Explicit '+(expanded?'expand':'collapse')+' changes only the requested expansion',await page.evaluate(({folder,expanded})=>window.fixture.ui.folderExpanded.has(folder)===expanded,{folder,expanded}));
}

async function run(page,origin){
  await setup(page,origin);
  const initialCalls=await page.evaluate(()=>window.fixture.trace.calls.length),initialReads=await page.evaluate(()=>window.fixture.trace.reads.length);
  for(const method of ['direct','label','keyboard'])for(let attempt=0;attempt<2;attempt++)await toggle(page,folderLabel('Project 10/Branch A/Deep evidence'),'.nw-folder-list',method,'Folder '+method+' toggle '+(attempt+1));
  await toggle(page,folderLabel('Project 10/Branch A/Deep evidence'),'.nw-folder-list','direct','Inherited child exclusion');
  check('Excluding an inherited child makes its parent partial',await checkbox(page,folderLabel('Project 10')).evaluate(input=>input.indeterminate&&!input.checked));
  await toggle(page,folderLabel('Project 10'),'.nw-folder-list','label','Partial parent to full selection');
  check('Checking a partial parent clears descendant exclusions',await page.evaluate(()=>!window.fixture.ui.scopeDraft.exclude.some(value=>value.startsWith('Project 10/')))&&await checkbox(page,folderLabel('Project 10/Branch A/Deep evidence')).isChecked());
  await toggle(page,folderLabel('Project 10'),'.nw-folder-list','keyboard','Parent whole-branch deselection');
  await toggle(page,folderLabel('Project 10'),'.nw-folder-list','direct','Parent whole-branch reselection');
  await explicitBranch(page,'Project 10',false);
  await toggle(page,folderLabel('Project 10'),'.nw-folder-list','label','Collapsed parent deselection');
  await toggle(page,folderLabel('Project 10'),'.nw-folder-list','direct','Collapsed parent reselection');
  check('Checking a collapsed parent does not unexpectedly open descendants',await checkbox(page,folderLabel('Project 10/Branch A')).count()===0);
  await explicitBranch(page,'Project 10',true);
  await emission(page,folderLabel('Project 10/Branch A'),'.nw-folder-list','Folder controller emission');
  const folderShot=path.join(output,'pc-scope-folders-stable.png');await page.screenshot({path:folderShot,fullPage:false});report.screenshots.push(folderShot);
  await toggle(page,'Entire vault','.nw-folder-list','direct','Entire vault clear',{entireVault:true});
  await toggle(page,'Entire vault','.nw-folder-list','keyboard','Entire vault select',{entireVault:true});
  check('Entire vault select includes all source files',await page.evaluate(()=>window.fixture.selectedFiles(window.fixture.files,window.fixture.ui.scopeDraft,{getTags:window.fixture.getTags}).length===144));
  await page.getByRole('tab',{name:'Tags',exact:true}).click();await frames(page);
  for(const method of ['direct','label','keyboard'])for(let attempt=0;attempt<2;attempt++)await toggle(page,tagLabel('#topic10'),'.nw-tag-list',method,'Tag '+method+' toggle '+(attempt+1));
  await toggle(page,tagLabel('#topic10'),'.nw-tag-list','direct','Tag parent selection');
  await toggle(page,tagLabel('#topic10/child'),'.nw-tag-list','label','Inherited tag child exclusion');
  check('Inherited tag exclusion makes parent partial',await checkbox(page,tagLabel('#topic10')).evaluate(input=>input.indeterminate&&!input.checked));
  await toggle(page,tagLabel('#topic10'),'.nw-tag-list','keyboard','Partial tag parent to full selection');
  check('Rechecking tag parent clears child exclusions',await page.evaluate(()=>!window.fixture.ui.scopeDraft.excludeTags.includes('#topic10/child'))&&await checkbox(page,tagLabel('#topic10/child')).isChecked());
  await emission(page,tagLabel('#topic10/child'),'.nw-tag-list','Tag controller emission');
  const tagShot=path.join(output,'pc-scope-tags-stable.png');await page.screenshot({path:tagShot,fullPage:false});report.screenshots.push(tagShot);
  check('Scope changes and status updates make no provider requests or note reads',await page.evaluate(()=>window.fixture.trace.calls.length)===initialCalls&&await page.evaluate(()=>window.fixture.trace.reads.length)===initialReads);
  check('Browser has no runtime errors',report.pageErrors.length===0,report.pageErrors);
  check('No external requests downloads or popups',report.externalRequests.length===0&&report.downloads.length===0&&report.popups.length===0,{externalRequests:report.externalRequests,downloads:report.downloads,popups:report.popups});
  check('Synthetic English settings UI has no donation links or hidden real notes',await page.locator('.nw-support,.nw-coffee-link,a[href*=buymeacoffee]').count()===0&&await page.locator('.notework-root').evaluate(root=>!/[\uac00-\ud7a3]/u.test(root.textContent)));
}

(async()=>{
  let server,browser;
  try{
    const allowlist=new Set(['tests/ui-fixture.html','styles.css',...fs.readdirSync(path.join(project,'src')).filter(file=>file.endsWith('.mjs')).map(file=>'src/'+file),'src/providers/claude-login-url.mjs']);
    server=http.createServer((request,response)=>{const file=new URL(request.url,'http://127.0.0.1').pathname.slice(1);if(!allowlist.has(file)){response.writeHead(404);response.end();return;}response.setHeader('Cache-Control','no-store');response.setHeader('Content-Type',file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8');response.end(fs.readFileSync(sourceFile(file)));});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin='http://127.0.0.1:'+server.address().port;
    browser=await chromium.launch({headless:true,executablePath:process.env.NOTEWORK_CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--disable-gpu']});
    const context=await browser.newContext({viewport:{width:1040,height:800}}),page=await context.newPage();
    await run(page,origin);
  }catch(error){report.failure=String(error);}
  finally{
    if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));
    report.finishedAt=new Date().toISOString();report.productionModulesAtEnd=moduleHashes();report.sourceChangedDuringRun=JSON.stringify(report.productionModules)!==JSON.stringify(report.productionModulesAtEnd);
    const failed=report.checks.filter(check=>!check.passed);report.failedChecks=failed.map(check=>check.name);
    report.regressionReproduced=failed.some(check=>/scroll positions|row position|DOM in place/.test(check.name));
    report.passed=!report.failure&&!report.sourceChangedDuringRun&&report.pageErrors.length===0&&report.externalRequests.length===0&&(expectRegression?report.regressionReproduced:failed.length===0);
    if(!report.passed)process.exitCode=1;
    const reportPath=path.join(output,expectRegression?'scope-scroll-baseline-report.json':'scope-scroll-ui-report.json');fs.writeFileSync(reportPath,JSON.stringify(report,null,2));
    process.stdout.write(JSON.stringify({passed:report.passed,expectRegression,regressionReproduced:report.regressionReproduced,checks:report.checks.length,failedChecks:report.failedChecks,failure:report.failure,sourceChangedDuringRun:report.sourceChangedDuringRun,report:reportPath},null,2));
  }
})();
