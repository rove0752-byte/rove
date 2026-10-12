// Local, model-free preview. The eve runtime provides the AI task routes.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { inspectPage,launchBrowser } from '../agent/lib/browser.ts';
let ready=false;
try {const browser=await launchBrowser();await browser.close();ready=true;}catch(e){console.error('Browser setup:',e instanceof Error?e.message:e);}
let busy=false;
const server=createServer(async(req,res)=>{
  const json=(status:number,data:unknown)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
  if(req.method==='GET'&&req.url==='/'){res.writeHead(200,{'Content-Type':'text/html'});return res.end(readFileSync('public/index.html'));}
  if(req.method==='GET'&&req.url==='/v1/health')return json(200,{service:'rove',browserInstalled:ready,aiConfigured:false,previewOnly:true});
  if(req.method==='POST'&&req.url==='/v1/agent/run')return json(503,{error:'AI tasks need the eve runtime and an AI Gateway credential. This local preview supports Inspect page.'});
  if(req.method==='POST'&&req.url==='/v1/extract'){
    if(busy)return json(429,{error:'An extraction is already running'});
    busy=true;
    try {let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>10000)throw new Error('Request too large');}const input=JSON.parse(raw);if(typeof input.url!=='string')throw new Error('URL is required');return json(200,await inspectPage(input.url));}
    catch(e){return json(422,{error:e instanceof Error?e.message:'Extraction failed'});}finally{busy=false;}
  }
  json(404,{error:'Not found'});
});
server.listen(4310,'127.0.0.1',()=>console.log('Rove preview: http://127.0.0.1:4310'));
