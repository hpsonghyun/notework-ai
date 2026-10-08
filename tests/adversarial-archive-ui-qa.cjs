const fs=require('fs'),path=require('path'),http=require('http'),crypto=require('crypto');
const root=path.resolve(__dirname,'..');
const output=process.env.NOTEWORK_QA_OUTPUT||path.join(root,'qa-output','adversarial');
process.env.NOTEWORK_QA_OUTPUT=output;
const {chromium}=require(process.env.NOTEWORK_PLAYWRIGHT_PATH||'playwright');
const {attachKnowledgeBridge}=require('./ui-qa.cjs');
fs.mkdirSync(output,{recursive:true});
const tracked=['src/controller.mjs','src/ui.mjs','styles.css'];const hashes=()=>Object.fromEntries(tracked.map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')]));
const report={sourceHashes:hashes(),checks:[],pageErrors:[],externalRequests:[],limitations:['Synthetic vault, model accounts, local archive bridge only. No real authentication or network provider calls.'],sourceHash:crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'src/controller.mjs'))).digest('hex')};
function check(name,passed,detail){report.checks.push({name,passed:!!passed,detail});}
const btn=(page,name)=>page.getByRole('button',{name,exact:true});
const settled=page=>page.waitForFunction(()=>window.fixtureReady&&!window.fixture.controller.state.busy);
async function question(page,text){await page.locator('[data-focus-id=question]').fill(text);await btn(page,'Send question').click();await settled(page);}
(async()=>{let server,browser;try{
 server=http.createServer((req,res)=>{const name=new URL(req.url,'http://127.0.0.1').pathname;const target=path.resolve(root,'.'+name);if(!target.startsWith(root+path.sep)||!fs.existsSync(target)||!fs.statSync(target).isFile()){res.writeHead(404).end();return;}res.setHeader('Content-Type',target.endsWith('.html')?'text/html':target.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(target));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--disable-gpu']});const page=await browser.newPage({viewport:{width:980,height:900}});
 page.on('pageerror',error=>report.pageErrors.push(String(error)));page.on('request',request=>{if(/^https?:/.test(request.url())&&!request.url().startsWith(origin+'/'))report.externalRequests.push(request.url());});
 await attachKnowledgeBridge(page);await page.goto(origin+'/tests/ui-fixture.html?surface=settings');await settled(page);await page.locator('.nw-tabs').getByRole('button',{name:'Connections',exact:true}).click();
 await btn(page,'Continue with ChatGPT').click();await settled(page);check('Archive setup is ready after account catalog with no test generation',await page.evaluate(()=>window.fixture.controller.state.verified&&!window.fixture.trace.calls.some(call=>call.type==='generate')));check('Archive connection exposes no Test buttons',await page.getByRole('button',{name:/test/i}).count()===0);
 await page.evaluate(()=>{const f=window.fixture;f.ui.destroy();f.ui=f.mount('sidebar');});
 check('Archive sidebar exposes one Open settings gear and no Test buttons',await btn(page,'Open settings').count()===1&&await page.getByRole('button',{name:/test/i}).count()===0);
 await question(page,'How does ontology relate to source evidence?');const key=await page.evaluate(()=>window.fixture.controller.contextKey());
 await btn(page,'Save conversation').click();await page.waitForFunction(()=>window.fixture.controller.state.history.length===1);
 const afterSave=await page.evaluate(()=>window.fixture.controller.contextKey());check('Actual UI save leaves the retrieval context unchanged',key===afterSave);
 await question(page,'Compare that answer with graph methods.');const input=await page.evaluate(()=>window.fixture.trace.calls.filter(call=>call.type==='generate'&&!call.verify).at(-1).input);
 check('Actual UI next question sends the previous answer after manual save',input.includes('First part of the synthetic answer and its continuation.'));
 await page.screenshot({path:path.join(output,'archive-follow-up.png')});
 await btn(page,'New chat').click();await question(page,'Explain ontology evidence.');
 await page.evaluate(()=>{const f=window.fixture;f.originalArchiveSave=f.controller.archive.save.bind(f.controller.archive);f.controller.archive.save=async input=>{f.saveBegun=true;await new Promise(resolve=>f.releaseArchiveSave=resolve);return f.originalArchiveSave(input);};});
 await btn(page,'Save conversation').click();await page.waitForFunction(()=>window.fixture.saveBegun===true);
 check('UI permits next question while the manual archive save is pending',await btn(page,'Send question').isEnabled());
 await question(page,'Compare ontology with graph methods.');
 await page.evaluate(()=>window.fixture.releaseArchiveSave());await page.waitForFunction(()=>window.fixture.controller.state.history.length===2);
 await page.evaluate(()=>window.fixture.controller.archive.save=window.fixture.originalArchiveSave);await btn(page,'Save conversation').click();await page.waitForTimeout(300);
 check('In-flight save and next question retain one archive for the current conversation',await page.evaluate(()=>window.fixture.controller.state.history.length)===2);
 await page.screenshot({path:path.join(output,'archive-save-race.png')});
 check('No browser runtime errors',report.pageErrors.length===0,report.pageErrors);check('No external service requests',report.externalRequests.length===0,report.externalRequests);
}catch(error){report.error=String(error);process.exitCode=1;}finally{if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));report.sourceHashesAtEnd=hashes();report.sourceChangedDuringRun=JSON.stringify(report.sourceHashes)!==JSON.stringify(report.sourceHashesAtEnd);report.failed=report.checks.filter(check=>!check.passed).length;report.passed=!report.error&&!report.sourceChangedDuringRun&&report.failed===0;report.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(output,'archive-ui-report.json'),JSON.stringify(report,null,2));if(!report.passed)process.exitCode=1;process.stdout.write(JSON.stringify(report,null,2));}})();
