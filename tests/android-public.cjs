'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),{spawn}=require('node:child_process');
for(const [key,publicEnabled,any,origin,status] of [['',false,true,'https://site.test',403],['',true,true,'https://site.test',200],['',true,false,'https://allowed.test',200],['manual-key',true,true,'https://site.test',200]]){
 test(`API key=${!!key}, public=${publicEnabled}, anyOrigin=${any}: CORS, auth and saved history-off`,async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pocket-public-'));fs.mkdirSync(path.join(dir,'accounts'));
  fs.writeFileSync(path.join(dir,'accounts/test.json'),JSON.stringify({token:'offline',cookie:'offline',wasmUrl:'https://example.invalid'}));
  const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({port,key,publicEnabled,tunnelAllowAnyOrigin:any,tunnelOrigins:'https://allowed.test',sendFullHistory:false,newChatEachMessage:false,envText:'DEEPSEEK_SEND_FULL_HISTORY=1\nDEEPSEEK_NEW_CHAT_EACH_MESSAGE=1'}));
  fs.writeFileSync(path.join(dir,'message-stats.json'),JSON.stringify({totalMessages:17}));
  const child=spawn(process.execPath,[path.resolve('app/src/main/assets/engine/bootstrap.js'),dir],{stdio:'pipe'});const base='http://127.0.0.1:'+port;
  try{
   let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,40));}assert.ok(ready);
   const headers=key?{Authorization:'Bearer '+key}:{};
   const health=await(await fetch(base+'/health',{headers})).json();assert.equal(health.session_reuse.send_full_history,false);assert.equal(health.session_reuse.new_chat_each_message,false);
   const result=await fetch(base+'/v1/models',{headers:{...headers,Origin:origin}});assert.equal(result.status,status);
   assert.equal((await fetch(base+'/v1/models')).status,key?401:200);
   if(status===200){assert.equal(result.headers.get('access-control-allow-origin'),origin);const preflight=await fetch(base+'/v1/chat/completions',{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Headers':'authorization,x-stainless-lang,x-custom-client'}});assert.equal(preflight.status,204);assert.ok(preflight.headers.get('access-control-allow-headers').includes('x-custom-client'));}
   assert.ok(!JSON.stringify(health).includes('watermark'));assert.equal(health.service,'DeepSeek Pocket');assert.equal(health.total_messages,17,'message count survives process restart');
  }finally{if(child.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r));}fs.rmSync(dir,{recursive:true,force:true});}
 });
}
