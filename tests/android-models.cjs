const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const path=require('node:path');

test('Android model policy: only Flash and Thinking; search enabled across all API formats',async()=>{
 const upstreamCalls=[];let chats=0;
 const mock=http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{
  const input=body?JSON.parse(body):{};
  if(req.url==='/api/v0/chat/create_pow_challenge'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:{biz_data:{challenge:{challenge:'c',salt:'s',expire_at:1,difficulty:1}}}}));}
  else if(req.url==='/api/v0/chat_session/create'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:{biz_data:{id:'test-'+(++chats)}}}));}
  else if(req.url==='/api/v0/chat/completion'){
   upstreamCalls.push(input);res.writeHead(200,{'Content-Type':'text/event-stream'});
   const send=value=>res.write('data: '+JSON.stringify(value)+'\n\n');
   send({request_message_id:1,response_message_id:2});send({v:{response:{message_id:2,parent_id:1,fragments:[],status:'WIP'}}});
   if(input.thinking_enabled)send({p:'response/fragments',o:'APPEND',v:[{type:'THINK',content:'Reasoning'}]});
   send({p:'response/fragments',o:'APPEND',v:[{type:'RESPONSE',content:'Hello from Android 🖤'}]});send({p:'response/status',o:'SET',v:'FINISHED'});res.end();
  }else{res.writeHead(404);res.end();}
 });});
 await new Promise(r=>mock.listen(0,'127.0.0.1',r));
 process.env.DEEPSEEK_BASE_URL='http://127.0.0.1:'+mock.address().port;
 process.env.PROXY_API_KEY='offline-test-key';process.env.DEEPSEEK_MAX_RETRIES='0';
 const pow=require.resolve('../app/src/main/assets/engine/lib/pow.js');require.cache[pow]={id:pow,filename:pow,loaded:true,exports:{solvePOW:async()=>1}};
 const core=require('../app/src/main/assets/engine/server.js').__test;
 core.accounts.push({id:'offline',config:{token:'test',cookie:'test',wasmUrl:'https://example.invalid'},headers:{'Content-Type':'application/json'},cooldownUntil:0,failures:0,lastUsedAt:0});
 await new Promise(r=>core.server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+core.server.address().port,headers={Authorization:'Bearer offline-test-key','Content-Type':'application/json'};
 try{
  const ids=['deepseek-v4.1-flash','deepseek-v4.1-flash-thinking'];
  const models=await(await fetch(base+'/v1/models',{headers})).json();assert.deepEqual(models.data.map(m=>m.id),ids);
  const caps=await(await fetch(base+'/v1/model-capabilities',{headers})).json();assert.deepEqual(Object.keys(caps.data),ids);
  for(const id of ids){assert.equal(caps.data[id].search_enabled,true);assert.equal(caps.data[id].thinking_enabled,id.endsWith('-thinking'));}
  const health=await(await fetch(base+'/health',{headers})).json();assert.deepEqual(health.models,ids);
  for(const id of ['deepseek-chat','deepseek-reasoner','deepseek-v4-pro','deepseek-v3','deepseek-v4.1-flash-search']){
   const r=await fetch(base+'/v1/chat/completions',{method:'POST',headers,body:JSON.stringify({model:id,messages:[{role:'user',content:'test'}]})});assert.equal(r.status,400);assert.deepEqual((await r.json()).error.supported_models,ids);
  }
  for(const id of ids)for(const endpoint of ['/v1/chat/completions','/v1/messages','/v1/responses'])for(const stream of [false,true]){
   const input={model:id,stream,user:'test-'+upstreamCalls.length,messages:[{role:'user',content:'Hello'}],max_tokens:64};
   if(endpoint==='/v1/responses'){delete input.messages;input.input='Hello';}
   const r=await fetch(base+endpoint,{method:'POST',headers,body:JSON.stringify(input)});assert.equal(r.status,200);
   const text=await r.text();assert.ok(text.includes('Hello from Android'));assert.equal(upstreamCalls.at(-1).search_enabled,true);assert.equal(upstreamCalls.at(-1).thinking_enabled,id.endsWith('-thinking'));
   if(stream)assert.ok(r.headers.get('content-type').includes('text/event-stream'));else assert.equal(JSON.parse(text).model,id);
  }
  const r=await fetch(base+'/v1/chat/completions',{method:'POST',headers,body:JSON.stringify({messages:[{role:'user',content:'default'}],user:'defaults'})});assert.equal(r.status,200);assert.equal((await r.json()).model,ids[0]);assert.equal(upstreamCalls.at(-1).search_enabled,true);
  assert.equal(upstreamCalls.length,13);
 }finally{await Promise.all([new Promise(r=>{core.server.closeAllConnections();core.server.close(r);}),new Promise(r=>{mock.closeAllConnections();mock.close(r);})]);}
});
