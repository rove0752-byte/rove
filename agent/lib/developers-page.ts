// Developer page: API example + API key check. The home page never asks for or sends a key.
export const DEVELOPERS_PAGE_HTML = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rove — API</title><style>
*{box-sizing:border-box}:root{--bg:#FAF9F7;--ink:#1F1E1C;--mute:#6B6862;--faint:#8F8B84;--line:#E7E4DE;--acc:#8A5E45}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}header{padding:22px 28px}header a{font-size:22px;font-weight:700;letter-spacing:-1px;color:var(--ink);text-decoration:none}header a span{color:var(--acc)}main{max-width:680px;margin:0 auto;padding:32px 24px 64px}h1{font-size:28px;font-weight:600;letter-spacing:-.6px;margin:0 0 8px}h2{font-size:16px;font-weight:600;margin:36px 0 8px}p{color:var(--mute);margin:0 0 12px}pre{white-space:pre-wrap;font:12px/1.55 ui-monospace,Menlo,monospace;background:#F5F3EF;border:1px solid var(--line);border-radius:12px;padding:16px;margin:0}input{width:100%;border:1px solid var(--line);border-radius:10px;padding:10px 12px;font:inherit;background:#fff;color:var(--ink);outline:0}input:focus{box-shadow:0 0 0 3px rgba(138,94,69,.12)}button{font:inherit;font-size:13px;border:0;border-radius:10px;padding:9px 16px;background:var(--acc);color:#fff;cursor:pointer;margin-top:10px}.status{font-size:13px;color:var(--mute);margin-top:10px}footer{text-align:center;padding:18px;font-size:12px;color:var(--faint)}footer a{color:var(--faint)}</style>
<header><a href="/">rove<span>.</span></a></header><main><h1>Rove API</h1><p>Call Rove from your own code with an API key. The website itself needs no key.</p><h2>Example</h2><pre>POST /v1/agent/run
Authorization: Bearer YOUR_API_KEY
Content-Type: application/json

{
  "url": "https://example.com",
  "task": "Summarise this page with sources",
  "outputFormat": "JSON"
}</pre><h2>Check your key</h2><p>Your key is only sent with this check and is not stored.</p><label for="key" style="display:block;font-size:13px;margin-bottom:6px">API key</label><input id="key" type="password" autocomplete="off" placeholder="Paste your API key"><button id="check" type="button">Check setup</button><div class="status" id="health">Enter a key to check setup.</div></main><footer><a href="/">Back to Rove</a></footer><script>
const $=id=>document.getElementById(id);
async function health(){const k=$('key').value.trim();if(!k){$('health').textContent='Enter a key to check setup.';return;}$('health').textContent='Checking…';try{const r=await fetch('/v1/health',{headers:{Authorization:'Bearer '+k}});const d=await r.json();$('health').textContent=d.error||('Key accepted · Browser: '+(d.browserInstalled?'ready':'installation required')+' · AI: '+(d.aiConfigured?'configured':'credential required'));}catch{$('health').textContent='Could not check setup.';}}
$('check').onclick=health;$('key').addEventListener('keydown',e=>{if(e.key==='Enter')health();});
</script></html>
`;
