import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { timelinePoint } from './timeline-browser-helpers.mjs';

const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(15000);
page.on('dialog', dialog => void dialog.accept());
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const canvas = page.locator('.timeline-canvas');
const tooltip = page.getByRole('tooltip');
const version = n => page.locator('.document-heading .status').filter({hasText:`v${n} ·`}).waitFor();
async function markers() { return canvas.evaluate(node => JSON.parse(node.dataset.warningMarkers ?? '[]')); }
async function position(key) {
  const marker = (await markers()).find(item => item.marker.key === key);
  assert(marker, `visible marker ${key}`);
  const box = await canvas.boundingBox();
  return {x:box.x+marker.x, y:box.y+marker.y, local:marker};
}
async function seek(seconds) {
  await page.getByLabel('播放位置',{exact:true}).fill(String(seconds));
  await page.getByLabel('播放位置',{exact:true}).dispatchEvent('input');
  await page.waitForFunction(value=>Math.abs(parseFloat(document.querySelector('.transport output').textContent)-value)<.001,seconds);
}
async function action(name) {
  const point=await timelinePoint(page,2.5,8);
  await page.mouse.click(point.x,point.y,{button:'right'});
  await page.getByRole('menuitem',{name,exact:true}).click();
}
try {
  await page.goto(process.argv[2] ?? 'http://127.0.0.1:4173/');
  const text='&first=0\n&inote_1=(120){4}1!-3[0##1]*-5[0##1]*-7[0##1],1/1/2/A1,(240)1/2/3,E\n&inote_2=(120){4}1,E\n';
  await page.getByLabel('谱面文件',{exact:true}).setInputFiles({name:'warning-track.txt',mimeType:'text/plain',buffer:Buffer.from(text)});
  await version(0);
  await canvas.evaluate(node=>node.setAttribute('data-measure-warnings',''));
  // The instrumentation is read during paint; pointer movement schedules one.
  await canvas.hover({position:{x:2,y:2}});
  await page.waitForFunction(()=>JSON.parse(document.querySelector('.timeline-canvas').dataset.warningMarkers ?? '[]').length===3);
  const initial=await markers();
  assert.deepEqual(initial.map(item=>item.marker.key),['0/1','1/1','2/1']);
  assert.deepEqual(initial[0].marker.codes,[3]);
  assert.equal(initial[0].marker.severity,'warning');
  assert.deepEqual(initial[1].marker.codes.slice(0,4),[7,8,0,1]);
  assert.equal(initial[1].marker.severity,'bad');
  assert.deepEqual(initial.map(item=>item.x),[60,60,60]);
  assert.equal(await canvas.getAttribute('data-grid-left'),'80');
  const pixels=await canvas.evaluate(node=>{
    const data=JSON.parse(node.dataset.warningMarkers);const ctx=node.getContext('2d');
    return data.slice(0,2).map(item=>{
      const pixels=ctx.getImageData(item.x-20,item.y-20,40,40).data;let red=0,yellow=0;
      for(let n=0;n<pixels.length;n+=4){if(pixels[n]>200&&pixels[n+1]<130&&pixels[n+2]<130)red++;if(pixels[n]>180&&pixels[n+1]>160&&pixels[n+2]<120)yellow++;}
      return {red,yellow};
    });
  });
  assert(pixels[0].yellow>40); assert(pixels[1].red>40);
  const warning=await position('0/1');
  await page.mouse.move(warning.x,warning.y);
  await tooltip.waitFor();
  assert.match(await tooltip.innerText(), /\[警告\] 三支 Slide/);
  const bad=await position('1/1');
  await page.mouse.move(bad.x,bad.y);
  await tooltip.getByText('[冲突] 同轨音符重叠',{exact:true}).waitFor();
  assert.equal(await tooltip.locator(':scope > div').count(),initial[1].marker.codes.length);
  await page.screenshot({path:'/tmp/maijdata-warning-track-hover.png'});
  await page.mouse.click(bad.x,bad.y);
  await page.mouse.dblclick(bad.x,bad.y);
  await page.mouse.click(bad.x,bad.y,{button:'right'});
  await version(0);
  assert.equal(await page.getByRole('menu',{name:'时间轴编辑菜单'}).count(),0);
  assert(Math.abs(parseFloat(await page.locator('.transport output').textContent()))<.001);
  await page.mouse.move(bad.x+180,bad.y);
  await tooltip.waitFor({state:'hidden'});
  await seek(.5);
  const atHead=await position('1/1');
  assert(Math.abs(atHead.local.y-Number(await canvas.getAttribute('data-playhead-y')))<.01);
  await page.mouse.move(atHead.x,atHead.y);
  await page.keyboard.down('Control'); await page.mouse.wheel(0,200); await page.keyboard.up('Control');
  await page.waitForFunction(()=>Number(document.querySelector('.timeline-canvas').dataset.pixelsPerSecond)<300);
  const zoomed=await markers();
  assert(zoomed.every(item=>item.x===60));
  await page.getByLabel('当前难度',{exact:true}).selectOption('2');
  await page.waitForFunction(()=>document.querySelector('.timeline-canvas').dataset.warningCount==='0');
  await tooltip.waitFor({state:'hidden'});
  await page.getByLabel('当前难度',{exact:true}).selectOption('1');
  await page.waitForFunction(()=>document.querySelector('.timeline-canvas').dataset.warningCount==='3');
  await action('全选'); await action('删除'); await version(1);
  assert.equal(await canvas.getAttribute('data-warning-count'),'0');
  await action('撤销'); await version(2);
  assert.equal(await canvas.getAttribute('data-warning-count'),'3');
  await page.getByLabel('谱面文件',{exact:true}).setInputFiles({name:'readonly.txt',mimeType:'text/plain',buffer:Buffer.from('&inote_1=(120){4}1p4[4:1],E\n')});
  await page.locator('.document-heading').getByText('readonly.txt',{exact:true}).waitFor();
  await version(0);
  assert.equal(await canvas.getAttribute('data-warning-count'),'0');
  assert.deepEqual(errors,[]);
  const report={browser:browser.version(),flows:['source-gutter-and-sprite-pixels','same-beat-source-order-and-bad-priority','hover-all-reasons','marker-clicks-do-not-edit-or-seek','seek-and-zoom-alignment','difficulty-switch','edit-and-undo','readonly-clears-markers'],initial,pixels,errors};
  await writeFile('/tmp/maijdata-warning-track.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
} catch(error) {
  await page.screenshot({path:'/tmp/maijdata-warning-track-failure.png'});
  console.error((await page.locator('body').innerText()).slice(-2500));
  throw error;
} finally {await browser.close();}
