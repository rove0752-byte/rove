import {spawn} from 'node:child_process';
import {launchBrowser} from '../agent/lib/browser.ts';
import assert from 'node:assert/strict';
const child=spawn(process.execPath,['--experimental-strip-types','scripts/preview.ts'],{stdio:['ignore','pipe','inherit']});
await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Preview startup timeout')),15000);child.stdout.on('data',data=>{if(data.toString().includes('Rove preview:')){clearTimeout(timer);resolve();}});child.on('exit',code=>reject(new Error('Preview exited: '+code)));});
let browser;
try {
 const health=await fetch('http://127.0.0.1:4310/v1/health').then(r=>r.json());assert.equal(health.browserInstalled,true);
 browser=await launchBrowser();const page=await browser.newPage({viewport:{width:1440,height:960}});await page.goto('http://127.0.0.1:4310');await page.locator('#url').fill('http://127.0.0.1');await page.locator('#extract').click();await page.getByText('Private and reserved network targets are blocked.').waitFor();assert.equal(await page.locator('#run').isEnabled(),true);
 await page.screenshot({path:'preview.png',fullPage:true});await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
 const ai=await fetch('http://127.0.0.1:4310/v1/agent/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:'https://example.com',task:'Summarise'})});assert.equal(ai.status,503);
 console.log('PASS: browser launch, desktop UI, mobile overflow, blocked target, recovery and AI setup error.');
} finally {if(browser)await browser.close();child.kill();}
