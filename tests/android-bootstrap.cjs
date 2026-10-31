const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const {spawn}=require('node:child_process');
test('Android bootstrap loads app accounts and settings, protects API and preserves upstream routes',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pocket-test-'));
 const key='test-key-'+Date.now();fs.mkdirSync(path.join(dir,'accounts'));
 const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 fs.writeFileSync(path.join(dir,'accounts','test.json'),JSON.stringify({token:'fake-token',cookie:'fake-cookie',wasmUrl:'https://example.invalid/test.wasm'}));
 fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({port,key,lan:false,sendFullHistory:true,newChatEachMessage:true,envText:'DEEPSEEK_MAX_CONCURRENT=3\nDEEPSEEK_SEND_FULL_HISTORY=0\nDEEPSEEK_NEW_CHAT_EACH_MESSAGE=0'}));
 const child=spawn(process.execPath,[path.resolve('app/src/main/assets/engine/bootstrap.js'),dir],{stdio:'pipe'});let output='';child.stderr.on('data',d=>output+=d);
 const base='http://127.0.0.1:'+port,headers={Authorization:'Bearer '+key};
 try{
  let ready=false;
  for(let i=0;i<100;i++){try{const r=await fetch(base+'/health');if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}
  assert.ok(ready,'bootstrap starts HTTP server: '+output);
  const health=await(await fetch(base+'/health',{headers})).json();assert.equal(health.config_ready,true);assert.equal(health.accounts.length,1);
  assert.equal(health.session_reuse.send_full_history,true);assert.equal(health.session_reuse.new_chat_each_message,true);
  const publicHealth=await(await fetch(base+'/health')).json();assert.equal(publicHealth.accounts,undefined);
  assert.equal((await fetch(base+'/readyz')).status,200);
  assert.equal((await fetch(base+'/v1/models')).status,401);
  const models=await(await fetch(base+'/v1/models',{headers})).json();assert.deepEqual(models.data.map(m=>m.id),['deepseek-v4.1-flash','deepseek-v4.1-flash-thinking']);
  assert.equal((await fetch(base+'/v1/models',{headers:{...headers,Origin:'https://untrusted.invalid'}})).status,403);
  assert.equal((await fetch(base+'/v1/model-capabilities',{headers})).status,200);
  assert.equal((await fetch(base+'/v1/sessions',{headers})).status,200);
  assert.equal((await fetch(base+'/reset-session?agent=all',{method:'POST',headers})).status,200);
  const logs=fs.readFileSync(path.join(dir,'proxy.log'),'utf8');assert.ok(logs.includes('Server on http://127.0.0.1:'+port));assert.ok(!logs.includes(key));assert.ok(!logs.includes('fake-token'));
 }finally{child.kill();await new Promise(r=>child.once('exit',r));fs.rmSync(dir,{recursive:true,force:true});}
});
