import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
const browser=await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
try {
 const page=await browser.newPage();
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(process.argv[2] ?? 'http://127.0.0.1:5175/');
 const images=await page.evaluate(async()=>{
  const skinSource=await (await fetch('/src/skin/pixi.ts')).text();
  const pixiUrl=skinSource.match(/from ["']([^"']*pixi__js[^"']*)["']/)[1];
  const {Application}=await import(pixiUrl);
  const {PixiNoteLayer,preloadNoteTextures}=await import('/src/skin/pixi.ts');
  const {iconFrame}=await import('/src/skin/composition.ts');
  const app=new Application();await app.init({width:400,height:400,autoStart:false,backgroundColor:0x202020,preference:'webgl'});
  document.body.appendChild(app.canvas);
  const layer=new PixiNoteLayer();app.stage.addChild(layer.container);
  const note={id:'hold',kind:'touchHold',touchArea:'C',position:0,beat:{numerator:0,denominator:1},order:0,modifiers:{break:false,ex:false},startSeconds:0,endSeconds:2,bpm:120};
  await preloadNoteTextures([note]);
  const output=[];
  for(const progress of [0,.25,.5,1,.25]) {
   layer.render([{note,frame:{...iconFrame,progress,visible:true,beatlineAlpha:1},placement:{x:0,y:0,rotation:0,scale:1}}],200,200,130);
   app.render();output.push(app.canvas.toDataURL());
  }
  app.destroy(true,{children:true,texture:false,textureSource:false});
  return output;
 });
 for(let i=0;i<images.length;i++)await writeFile(`/tmp/maijdata-touchhold-${i}.png`,Buffer.from(images[i].split(',')[1],'base64'));
 const quadrants = await page.evaluate(async (images) => {
  const pixels = await Promise.all(images.map(async (url) => {
   const image = new Image(); image.src = url; await image.decode();
   const canvas = document.createElement('canvas'); canvas.width = canvas.height = 400;
   const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
   return ctx.getImageData(0, 0, 400, 400).data;
  }));
  return pixels.slice(1, 4).map((frame) => {
   const counts = [0, 0, 0, 0];
   for (let y = 0; y < 400; y++) for (let x = 0; x < 400; x++) {
    const i = (y * 400 + x) * 4;
    if (Math.max(...[0, 1, 2].map(c => Math.abs(frame[i+c] - pixels[0][i+c]))) > 10)
     counts[y < 200 ? (x >= 200 ? 0 : 3) : (x >= 200 ? 1 : 2)]++;
   }
   return counts;
  });
 }, images);
 assert(quadrants[0][0] > 100);
 assert.deepEqual(quadrants[0].slice(1), [0, 0, 0], 'quarter progress must fill only the upper right');
 assert(quadrants[1][0] > 100 && quadrants[1][1] > 100);
 assert.deepEqual(quadrants[1].slice(2), [0, 0], 'half progress must fill only the right half');
 assert(quadrants[2].every(n => n > 100));
 assert.equal(images[1], images[4], 'backward seek must reproduce identical pixels');
 assert.deepEqual(errors, []);
 const report = { browser: browser.version(), quadrants, backwardSeekIdentical: true, errors };
 await writeFile('/tmp/maijdata-touchhold-results.json', JSON.stringify(report, null, 2));
 console.log(JSON.stringify(report));
}finally{await browser.close()}
