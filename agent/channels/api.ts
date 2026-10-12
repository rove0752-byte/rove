import { defineChannel, GET, POST } from 'eve/channels';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { z } from 'zod';
import { inspectPage } from '../lib/browser';
import { validateUrl } from '../lib/policy';
const runSchema=z.object({url:z.string().url().max(2048),task:z.string().min(3).max(3000),outputFormat:z.string().max(2000).optional()}).strict();
function authorized(req:Request){
  const key=process.env.ROVE_API_KEY;
  if(!key) return process.env.NODE_ENV!=='production'&&['localhost','127.0.0.1','[::1]'].includes(new URL(req.url).hostname);
  const actual=Buffer.from(req.headers.get('authorization')??''); const expected=Buffer.from(`Bearer ${key}`);
  return actual.length===expected.length&&timingSafeEqual(actual,expected);
}
async function body(req:Request){const raw=await req.text(); if(Buffer.byteLength(raw)>10000)throw new Error('Request too large');return JSON.parse(raw);}
const denied=()=>Response.json({error:'API key required'},{status:401});
let extracting=false;
export default defineChannel({
  routes:[
    GET('/v1/health',async req=>{if(!authorized(req))return denied();return Response.json({service:'rove',version:'0.1.0',browserInstalled:(existsSync(chromium.executablePath())||process.platform==='linux'),aiConfigured:!!(process.env.AI_GATEWAY_API_KEY||process.env.VERCEL_OIDC_TOKEN),mode:'read_only_no_javascript'});}),
    POST('/v1/extract',async req=>{
      if(!authorized(req))return denied(); if(extracting)return Response.json({error:'An extraction is running. Try again shortly.'},{status:429});
      try {const input=z.object({url:z.string().url().max(2048)}).strict().parse(await body(req)); extracting=true;return Response.json(await inspectPage(input.url));}
      catch(e){return Response.json({error:e instanceof Error?e.message:'Extraction failed'},{status:422});} finally {extracting=false;}
    }),
    POST('/v1/agent/run',async(req,{from})=>{
      if(!authorized(req))return denied();
      if(!process.env.AI_GATEWAY_API_KEY&&!process.env.VERCEL_OIDC_TOKEN)return Response.json({error:'Configure AI_GATEWAY_API_KEY to enable AI tasks.'},{status:503});
      if(!(existsSync(chromium.executablePath())||process.platform==='linux'))return Response.json({error:'Install the browser with npx playwright install chromium.'},{status:503});
      try {
        const input=runSchema.parse(await body(req)); await validateUrl(input.url);const runId=randomUUID();
        const session=await from(runId).send(JSON.stringify({task:input.task,startUrl:input.url,outputFormat:input.outputFormat??'JSON'}),{auth:null});
        return Response.json({runId,sessionId:session.id,status:'accepted',streamUrl:`/v1/agent/runs/${session.id}/stream`},{status:202});
      } catch(e){return Response.json({error:e instanceof Error?e.message:'Invalid task'},{status:422});}
    }),
    GET('/v1/agent/runs/:id/stream',async(req,{attachSession,params})=>{
      if(!authorized(req))return denied();
      return new Response(await attachSession(params.id).getEventStream(),{headers:{'content-type':'application/x-ndjson; charset=utf-8'}});
    }),
  ],
});
