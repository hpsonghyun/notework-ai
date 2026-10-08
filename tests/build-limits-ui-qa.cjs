const fs=require('fs');
const path=require('path');
const http=require('http');
const crypto=require('crypto');
const {chromium}=require(process.env.NOTEWORK_PLAYWRIGHT_PATH||'playwright');

const project=path.resolve(__dirname,'..');
const output=process.env.NOTEWORK_QA_OUTPUT||path.join(project,'qa-output','build-limits');
fs.mkdirSync(output,{recursive:true});
const tracked=['src/ui.mjs','styles.css','src/controller.mjs','src/runtime-storage.mjs','src/vault-search.mjs'];
const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(path.join(project,file))).digest('hex');
const moduleHashes=()=>Object.fromEntries(tracked.map(file=>[file,digest(file)]));
const report={startedAt:new Date().toISOString(),syntheticContentOnly:true,productionModules:moduleHashes(),testSha256:digest('tests/build-limits-ui-qa.cjs'),checks:[],screenshots:[],pageErrors:[],externalRequests:[],limitations:['Production settings UI, controller settings normalization and saved scope selection are exercised with synthetic notes.','Build execution is replaced with a capture adapter: this test verifies UI configuration, not engine indexing coverage or actual paid requests.','Mobile checks use Chromium with production sync-only UI, not a physical phone. No providers or real vault notes are used.']};
function check(name,value,details){report.checks.push({name,passed:!!value,...(details===undefined?{}:{details})});if(!value)throw Error(name+': '+JSON.stringify(details));}
const button=(page,name)=>page.getByRole('button',{name,exact:true});
const checkbox=(page,name)=>name==='Limit text chunks'?page.locator('[data-focus-id="knowledge-limitChunks"]'):page.getByRole('checkbox',{name,exact:true});
const input=(page,name)=>page.locator('[data-focus-id="knowledge-max-'+name+'"]');
const summary=page=>page.locator('.nw-build-scope').innerText();
const frames=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));

async function setup(page,origin){
  page.on('pageerror',error=>report.pageErrors.push(String(error)));
  page.on('request',request=>{if(/^https?:/i.test(request.url())&&!request.url().startsWith(origin+'/'))report.externalRequests.push(request.url());});
  await page.goto(origin+'/tests/ui-fixture.html?surface=settings');await page.waitForFunction(()=>window.fixtureReady);
  await page.evaluate(()=>{
    const f=window.fixture;f.files.splice(0);f.notes.splice(0);f.folders.splice(0);f.tags.clear();
    f.folders.push({path:'Synthetic',name:'Synthetic',children:[]});
    for(let number=0;number<320;number++){
      const notePath='Synthetic/note-'+String(number).padStart(4,'0')+'.md',content='Invented build limit source '+number;
      f.notes.push({path:notePath,content});f.files.push({path:notePath,name:notePath.split('/').pop(),stat:{size:content.length,mtime:1,ctime:1}});f.tags.set(notePath,[]);
    }
    f.controller.buildKnowledge=async input=>{f.trace.buildCaptures??=[];f.trace.buildCaptures.push({input,settings:structuredClone(f.controller.settings.knowledge),scopePaths:f.controller.scopeFiles().map(file=>file.path)});};
    f.ui.setView('build');
  });await frames(page);
}

async function run(page,origin){
  await setup(page,origin);check('Build settings expose no manual Test buttons',await page.getByRole('button',{name:/test/i}).count()===0);
  check('Saved scope above the former ceiling is shown in full',(await summary(page)).startsWith('All 320 notes in your saved scope.'));
  check('Default summary declares no user AI or chunk ceiling',(await summary(page)).includes('No user-set AI request limit.')&&(await summary(page)).includes('No user-set text chunk limit.'));
  for(const [label,key]of [['Limit notes','notes'],['Limit AI requests','calls'],['Limit text chunks','chunks']]){
    check(label+' is opt-in and its numeric field is disabled',!await checkbox(page,label).isChecked()&&await input(page,key).isDisabled());
    check(key+' number field has no artificial maximum',await input(page,key).getAttribute('max')===null);
  }
  const defaultScreen=path.join(output,'build-default-all-320-notes.png');await page.screenshot({path:defaultScreen,fullPage:true});report.screenshots.push(defaultScreen);
  check('Full-scope build is authorized by explicit Build action without mandatory checkbox',await button(page,'Build knowledge').isEnabled()&&await checkbox(page,'Allow this knowledge build').count()===0);
  await button(page,'Build knowledge').click();await page.waitForFunction(()=>window.fixture.trace.buildCaptures?.length===1);
  const full=await page.evaluate(()=>window.fixture.trace.buildCaptures.at(-1));
  check('Default UI configuration keeps every saved scope note',full.input.consent===true&&full.scopePaths.length===320&&!full.settings.limitNotes&&!full.settings.limitCalls&&!full.settings.limitChunks&&full.settings.buildLimitVersion===2,full.settings);
  await checkbox(page,'Limit notes').check();
  check('Optional note limit enables its numeric control without a mandatory checkbox',!await input(page,'notes').isDisabled()&&await checkbox(page,'Allow this knowledge build').count()===0);
  await input(page,'notes').fill('501');
  check('User note limits above 500 are accepted and summarized',(await summary(page)).startsWith('Up to 501 of 320 notes in your saved scope.')&&await input(page,'notes').evaluate(node=>node.validity.valid));
  await checkbox(page,'Limit AI requests').check();await input(page,'calls').fill('2001');
  check('User AI request limits above 200 are accepted and summarized',(await summary(page)).includes('AI request limit: 2001.')&&await input(page,'calls').evaluate(node=>node.validity.valid));
  await page.locator('.nw-build-advanced summary').click();await checkbox(page,'Limit text chunks').check();await input(page,'chunks').fill('10001');
  check('User chunk limits above the previous ceiling are accepted',(await summary(page)).includes('Text chunk limit: 10001.')&&await input(page,'chunks').evaluate(node=>node.validity.valid));
  await input(page,'notes').fill('0');
  check('Invalid enabled note limit is explained and blocks build',await button(page,'Build knowledge').isDisabled()&&await page.locator('.nw-build-limit-error').isVisible()&&await checkbox(page,'Allow this knowledge build').count()===0);
  await input(page,'notes').fill('205');await input(page,'calls').fill('1.5');
  check('Fractional enabled request limits block build',await button(page,'Build knowledge').isDisabled());
  await input(page,'calls').fill('0');
  check('Zero AI requests is a valid explicit budget',!await button(page,'Build knowledge').isDisabled()&&(await summary(page)).includes('AI request limit: 0.'));
  await input(page,'calls').fill('2001');await checkbox(page,'Limit AI requests').uncheck();
  check('Removing a user cap restores unlimited requests without losing its remembered number',(await summary(page)).includes('No user-set AI request limit.')&&await input(page,'calls').isDisabled()&&await input(page,'calls').inputValue()==='2001');
  
  await input(page,'notes').evaluate(node=>window.__buildLimitNode=node);
  await input(page,'notes').fill('310');
  check('Editing a cap preserves its input and updates the build summary',await input(page,'notes').evaluate(node=>node===window.__buildLimitNode)&&(await summary(page)).startsWith('Up to 310'));
  await page.locator('.nw-tabs').getByRole('button',{name:'Connections',exact:true}).click();await page.locator('.nw-tabs').getByRole('button',{name:'Build',exact:true}).click();
  check('Navigating settings preserves unsaved cap choices',await checkbox(page,'Limit notes').isChecked()&&await input(page,'notes').inputValue()==='310'&&!await checkbox(page,'Limit AI requests').isChecked()&&await input(page,'calls').inputValue()==='2001'&&await checkbox(page,'Limit text chunks').isChecked());
  await button(page,'Build knowledge').click();await page.waitForFunction(()=>window.fixture.trace.buildCaptures?.length===2);
  const bounded=await page.evaluate(()=>window.fixture.trace.buildCaptures.at(-1));
  check('Configured optional caps reach the controller only through explicit switches',bounded.input.consent===true&&bounded.settings.limitNotes===true&&bounded.settings.maxNotes===310&&bounded.settings.limitCalls===false&&bounded.settings.maxCalls===2001&&bounded.settings.limitChunks===true&&bounded.settings.maxChunks===10001,bounded.settings);
  for(const label of ['Limit notes','Limit text chunks']){
    if(label==='Limit text chunks'&&!await checkbox(page,label).isVisible())await page.locator('.nw-build-advanced summary').click();
    await checkbox(page,label).uncheck();
  }
  check('Switching off every cap restores all saved notes',(await summary(page)).startsWith('All 320 notes in your saved scope.')&&(await summary(page)).includes('No user-set text chunk limit.'));
  await page.evaluate(async()=>{
    const {normalizeKnowledgeSettings}=await import('/src/runtime-storage.mjs');const f=window.fixture;
    f.controller.settings.knowledge=normalizeKnowledgeSettings({embeddingRoute:'lexical',semanticRoute:'none',maxNotes:200,maxCalls:200,maxChunks:1000});f.ui.knowledgeDraft=null;f.ui.render(f.controller.state);
  });
  check('Legacy default 200 settings migrate to the full saved scope',!await checkbox(page,'Limit notes').isChecked()&&!await checkbox(page,'Limit AI requests').isChecked()&&!await checkbox(page,'Limit text chunks').isChecked()&&(await summary(page)).startsWith('All 320 notes in your saved scope.'));
  await page.evaluate(async()=>{
    const {normalizeKnowledgeSettings}=await import('/src/runtime-storage.mjs');const f=window.fixture;
    f.controller.settings.knowledge=normalizeKnowledgeSettings({buildLimitVersion:2,limitNotes:true,maxNotes:37,limitCalls:true,maxCalls:11,limitChunks:true,maxChunks:93});f.ui.knowledgeDraft=null;f.ui.render(f.controller.state);
  });
  check('Saved explicit cap choices are restored across reopened settings',await checkbox(page,'Limit notes').isChecked()&&await input(page,'notes').inputValue()==='37'&&await checkbox(page,'Limit AI requests').isChecked()&&await input(page,'calls').inputValue()==='11'&&await checkbox(page,'Limit text chunks').isChecked()&&await input(page,'chunks').inputValue()==='93');
  await page.evaluate(()=>{window.fixture.controller.setScope({mode:'folders',include:['Synthetic/note-0000.md','Synthetic/note-0001.md'],exclude:[],tags:[],excludeTags:[]});});
  check('Summary uses accepted saved scope rather than total vault count',(await summary(page)).includes('of 2 notes in your saved scope.'));
  await checkbox(page,'Limit notes').uncheck();check('All notes summary follows a changed saved scope',(await summary(page)).startsWith('All 2 notes in your saved scope.'));
  const screen=path.join(output,'build-explicit-optional-limits.png');await page.screenshot({path:screen,fullPage:true});report.screenshots.push(screen);
  await page.setViewportSize({width:390,height:844});await frames(page);
  check('Narrow build settings have no horizontal overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  check('Build settings show only English application text',await page.locator('.notework-root').evaluate(root=>!/[\uac00-\ud7a3]/u.test(root.textContent)));
  check('UI build controls make no provider calls or note reads',await page.evaluate(()=>window.fixture.trace.calls.length===0&&window.fixture.trace.reads.length===0));
  await page.goto(origin+'/tests/ui-fixture.html?surface=settings&mobile=1');await page.waitForFunction(()=>window.fixtureReady);await page.evaluate(()=>window.fixture.ui.setView('build'));
  check('Mobile retains PC synchronization prerequisite',(await page.locator('.nw-content').innerText()).includes('Mobile requires a knowledge index built in Obsidian on your computer, synced together with its original notes.'));
  check('Mobile never exposes build caps or local build execution',await page.locator('.nw-build-budgets,[data-focus-id=knowledge-max-notes]').count()===0&&await button(page,'Build knowledge').count()===0);
  check('Browser has no runtime errors or external requests',report.pageErrors.length===0&&report.externalRequests.length===0,{pageErrors:report.pageErrors,externalRequests:report.externalRequests});
}

(async()=>{
  let browser,server;
  try{
    const allowed=new Set(['tests/ui-fixture.html','styles.css',...fs.readdirSync(path.join(project,'src')).filter(file=>file.endsWith('.mjs')).map(file=>'src/'+file),'src/providers/claude-login-url.mjs','src/providers/codex-login-url.mjs','src/providers/ollama-embeddings.mjs','src/providers/jev.mjs']);
    server=http.createServer((request,response)=>{const file=new URL(request.url,'http://127.0.0.1').pathname.slice(1);if(!allowed.has(file)){response.writeHead(404);response.end();return;}response.setHeader('Cache-Control','no-store');response.setHeader('Content-Type',file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8');response.end(fs.readFileSync(path.join(project,file)));});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
    browser=await chromium.launch({headless:true,executablePath:process.env.NOTEWORK_BROWSER_PATH||process.env.NOTEWORK_CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--disable-gpu']});
    const context=await browser.newContext({viewport:{width:1040,height:900}}),page=await context.newPage();await run(page,origin);
  }catch(error){report.failure=String(error);}
  finally{
    if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));
    report.finishedAt=new Date().toISOString();report.productionModulesAtEnd=moduleHashes();report.sourceChangedDuringRun=JSON.stringify(report.productionModules)!==JSON.stringify(report.productionModulesAtEnd);report.passed=!report.failure&&!report.sourceChangedDuringRun&&report.checks.every(check=>check.passed);
    if(!report.passed)process.exitCode=1;const reportPath=path.join(output,'build-limits-ui-report.json');fs.writeFileSync(reportPath,JSON.stringify(report,null,2));process.stdout.write(JSON.stringify({passed:report.passed,checks:report.checks.length,failedChecks:report.checks.filter(check=>!check.passed).map(check=>check.name),failure:report.failure,sourceChangedDuringRun:report.sourceChangedDuringRun,report:reportPath},null,2));
  }
})();
