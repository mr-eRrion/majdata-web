import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {chromium} from '@playwright/test';
import {clickTimeline} from './timeline-browser-helpers.mjs';
const scene=JSON.parse(await readFile(new URL('../fixtures/visual-maimai/rendering.json',import.meta.url),'utf8'));
const parameters=JSON.parse(await readFile(new URL('../apps/web/src/skin/parameters.json',import.meta.url),'utf8'));
const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE});
const page=await browser.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:1});
page.setDefaultTimeout(15000);page.on('dialog',d=>void d.accept());
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const tool=name=>page.getByRole('button',{name,exact:true}).click();
const version=n=>page.locator('.document-heading .status').filter({hasText:`v${n} ·`}).waitFor();
const picker=page.getByRole('dialog');
const snapshots=()=>page.evaluate(()=>window.__paintResponses.findLast(m=>m.ok&&m.type==='snapshot').snapshot);
const notes=async()=>(await snapshots()).charts.find(c=>c.difficulty===1).notes;
let imports=0;
async function openPicker(){
 const name=`paint-${++imports}.txt`;
 await page.getByLabel('谱面文件',{exact:true}).setInputFiles({name,mimeType:'text/plain',buffer:Buffer.from('&first=0\n&inote_1=(120){4},,,,,,,,E\n')});
 await page.locator('.document-heading').getByText(name,{exact:true}).waitFor();await version(0);
 await tool('Slide');await clickTimeline(page,.5,1);await clickTimeline(page,1.5,5);
 await picker.locator('[data-skin-ready="true"]').waitFor();
}
function sourcePath(command,start,end){
 const actual=start>=3&&start<=6?(command==='<'?'>':command==='>'?'<':command):command;
 const info=scene.slide_types.commands.find(t=>t.command===actual).infos.find(i=>i.distance===(end-start+8)%8);
 assert(info,`${command} ${start} ${end}`);
 const path=scene.slide_types.paths[info.path.path_id];
 const a=-(start-1)*Math.PI/4;
 return [...path.points].reverse().map(([x,y])=>[x*Math.cos(a)-y*Math.sin(a),x*Math.sin(a)+y*Math.cos(a)]);
}
async function toScreen(points){
 const b=await picker.locator('.slide-picker-preview').boundingBox();
 const radius=Math.hypot(...parameters.tracks[0].position.slice(0,2));
 const scale=Math.min(b.width,b.height)*.36/radius;
 return points.map(([x,y])=>({x:b.x+b.width/2+x*scale,y:b.y+b.height/2+4-y*scale}));
}
async function draw(points,{cancel=false}={}){
 const screen=await toScreen(points);
 await page.mouse.move(screen[0].x,screen[0].y);await page.mouse.down();
 for(const p of screen.slice(1))await page.mouse.move(p.x,p.y);
 if(cancel)await page.keyboard.press('Escape');
 await page.mouse.up();
}
async function exportReopen(){
 const expected=(await notes()).map(({id,order,sourceRange,...n})=>n);
 const download=page.waitForEvent('download');await tool('导出 maidata.txt');
 const bytes=await readFile(await(await download).path());
 const name=`reopen-${imports}.txt`;
 await page.getByLabel('谱面文件',{exact:true}).setInputFiles({name,mimeType:'text/plain',buffer:bytes});
 await page.locator('.document-heading').getByText(name,{exact:true}).waitFor();await version(0);
 assert.deepEqual((await notes()).map(({id,order,sourceRange,...n})=>n),expected);
}
const flows=[];
try{
 await page.addInitScript(()=>{
  window.__paintResponses=[];const NativeWorker=window.Worker;
  window.Worker=class extends NativeWorker{constructor(url,options){super(url,options);if(/chart\.worker/i.test(String(url)))this.addEventListener('message',e=>window.__paintResponses.push(e.data));}};
 });
 await page.goto(process.argv[2]??'http://127.0.0.1:4173/');
 for(const [command,start,end] of [['-',2,6],['<',3,7],['>',8,2]]){
  await openPicker();await draw(sourcePath(command,start,end));await version(1);await picker.waitFor({state:'hidden'});
  const n=(await notes())[0];assert.equal(n.position,start);assert.equal(n.slide.endPosition,end);assert.equal(n.slide.command,command);
  assert.equal(n.startSeconds,.5);assert.equal(n.moveStartSeconds,1);assert.equal(n.endSeconds,1.5);
  await tool('撤销 ⌘Z');await version(2);assert.equal((await notes()).length,0);
  await tool('重做 ⇧⌘Z');await version(3);await exportReopen();flows.push(`draw ${start}${command}${end}, auto-commit once, undo/redo/export/reopen`);
 }
 await openPicker();await draw(sourcePath('p',1,4));
 await picker.getByRole('status').filter({hasText:'尚未开放编辑'}).waitFor();
 assert.equal((await snapshots()).version,0);assert.equal((await notes()).length,0);
 await page.screenshot({path:'/tmp/maijdata-slide-paint-unsupported.png'});
 await draw(sourcePath('-',1,5));await version(1);assert.equal((await notes())[0].slide.command,'-');
 flows.push('unsupported full-candidate winner rejected without fallback, then valid redraw');
 await openPicker();await draw([[0,0],[1,1],[2,2],[3,3]]);assert.equal((await snapshots()).version,0);
 await draw(sourcePath('-',1,5),{cancel:true});await picker.waitFor({state:'hidden'});assert.equal((await snapshots()).version,0);
 flows.push('center start ignored and Escape during drawing cancels without history');
 assert.deepEqual(errors,[]);
 const report={browser:browser.version(),flows,errors};await writeFile('/tmp/maijdata-slide-paint.json',JSON.stringify(report,null,2));console.log(report);
}finally{await browser.close();}
