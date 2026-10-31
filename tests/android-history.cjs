const assert=require('node:assert/strict');
const http=require('node:http');

async function scenario(full,fresh){
 const calls=[];let chatCounter=0;
 const mock=http.createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
  const body=raw?JSON.parse(raw):{};const json=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
  if(req.url==='/api/v0/chat/create_pow_challenge')return json({data:{biz_data:{challenge:{challenge:'test',salt:'s',expire_at:1,difficulty:1}}}});
  if(req.url==='/api/v0/chat_session/create')return json({data:{biz_data:{id:'remote-'+(++chatCounter)}}});
  if(req.url!=='/api/v0/chat/completion'){res.writeHead(404);res.end();return;}
  calls.push(body);const answer='ANSWER_'+calls.length,request=(body.parent_message_id||0)+1,response=request+1;
  res.writeHead(200,{'Content-Type':'text/event-stream'});const event=v=>res.write('data: '+JSON.stringify(v)+'\n\n');
  event({request_message_id:request,response_message_id:response});event({v:{response:{message_id:response,parent_id:request,fragments:[],status:'WIP'}}});
  event({p:'response/fragments',o:'APPEND',v:[{type:'RESPONSE',content:answer}]});event({p:'response/status',o:'SET',v:'FINISHED'});res.end();
 });});
 await new Promise(r=>mock.listen(0,'127.0.0.1',r));
 process.env.DEEPSEEK_BASE_URL='http://127.0.0.1:'+mock.address().port;
 process.env.PROXY_API_KEY='test-key';process.env.DEEPSEEK_SEND_FULL_HISTORY=full?'1':'0';process.env.DEEPSEEK_NEW_CHAT_EACH_MESSAGE=fresh?'1':'0';
 const modulePath=require.resolve('../app/src/main/assets/engine/lib/pow.js');require.cache[modulePath]={id:modulePath,filename:modulePath,loaded:true,exports:{solvePOW:async()=>1}};
 const core=require('../app/src/main/assets/engine/server.js').__test;
 core.accounts.push({id:'test',config:{token:'offline',cookie:'offline',wasmUrl:'https://example.invalid'},headers:{'Content-Type':'application/json'},cooldownUntil:0,failures:0,lastUsedAt:0});
 await new Promise(r=>core.server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+core.server.address().port,headers={Authorization:'Bearer test-key','Content-Type':'application/json'};
 async function send(endpoint,user,messages,regenerate=false){
  const body={model:'deepseek-v4.1-flash',user,messages,regenerate};
  if(endpoint==='/v1/responses'){body.input=messages;delete body.messages;}
  const r=await fetch(base+endpoint,{method:'POST',headers,body:JSON.stringify(body)});const answer=await r.json();assert.equal(r.status,200,JSON.stringify(answer));
  return 'ANSWER_'+calls.length;
 }
 try{
  const health=await(await fetch(base+'/health',{headers})).json();assert.equal(health.session_reuse.send_full_history,full);assert.equal(health.session_reuse.new_chat_each_message,full&&fresh);
  for(const endpoint of ['/v1/chat/completions','/v1/messages','/v1/responses']){
   const user=endpoint,initial=[{role:'system',content:'SYSTEM_ALWAYS_Z'},{role:'user',content:'ROOT_REQUEST_Z'}];
   const a1=await send(endpoint,user,initial),first=calls.at(-1);
   const second=[...initial,{role:'assistant',content:a1},{role:'user',content:'NEXT_REQUEST_Y'}];
   const a2=await send(endpoint,user,second),next=calls.at(-1);
   assert.equal(next.prompt.includes('ROOT_REQUEST_Z'),full,'full replay versus delta');assert.ok(next.prompt.includes('NEXT_REQUEST_Y'));assert.ok(next.prompt.includes('SYSTEM_ALWAYS_Z'),'system instructions accompany every turn');
   assert.equal(next.chat_session_id===first.chat_session_id,!(full&&fresh),'fresh chat only when both settings are enabled');
   const a3=await send(endpoint,user,second,true),regenerated=calls.at(-1);
   assert.notEqual(regenerated.chat_session_id,next.chat_session_id,'regeneration cannot continue the replaced answer chain');
   assert.ok(regenerated.prompt.includes('ROOT_REQUEST_Z'));assert.ok(regenerated.prompt.includes('NEXT_REQUEST_Y'));assert.ok(regenerated.prompt.includes(a1));assert.ok(!regenerated.prompt.includes(a2));
   assert.equal(core.sessions.get(user).history.length,2,'replace the recovery entry rather than append a rejected answer');
   assert.equal(core.sessions.get(user).history.at(-1).assistant,a3);
   await send(endpoint,user,[...second,{role:'assistant',content:a3},{role:'user',content:'THIRD_REQUEST_X'}]);
   assert.equal(calls.at(-1).prompt.includes('ROOT_REQUEST_Z'),full);assert.ok(!calls.at(-1).prompt.includes(a2));
  }
  // A reused app/user ID must not leak an old character's hidden context.
  for(const user of ['shared-user',undefined]){
   const first=[{role:'system',content:'ROLE_ONE'},{role:'user',content:'SECRET_OLD_CHARACTER'}];
   await send('/v1/chat/completions',user,first);const previous=calls.at(-1).chat_session_id;
   await send('/v1/chat/completions',user,[{role:'system',content:'ROLE_TWO'},{role:'user',content:'NEW_CHARACTER'}]);
   assert.notEqual(calls.at(-1).chat_session_id,previous);assert.ok(!calls.at(-1).prompt.includes('SECRET_OLD_CHARACTER'));
  }
  const branch=[{role:'user',content:'SAME_GREETING'}];
  await send('/v1/chat/completions','shared-branch',branch);const oldBranch=calls.at(-1).chat_session_id;
  await send('/v1/chat/completions','shared-branch',[...branch,{role:'assistant',content:'DIFFERENT_CHARACTER_REPLY'},{role:'user',content:'CONTINUE'}]);
  assert.notEqual(calls.at(-1).chat_session_id,oldBranch,'same first message with another assistant is a separate branch');
  const initial=[{role:'user',content:'FIRST_ONLY'}],old=await send('/v1/chat/completions','first-regeneration',initial);
  await send('/v1/chat/completions','first-regeneration',initial,true);assert.ok(!calls.at(-1).prompt.includes(old),'first-turn regeneration excludes stale recovery history');assert.equal(core.sessions.get('first-regeneration').history.length,1);
  const finalHealth=await(await fetch(base+'/health',{headers})).json();assert.equal(finalHealth.total_messages,calls.length);assert.ok(!JSON.stringify(finalHealth).includes('watermark'));
 }finally{await Promise.all([new Promise(r=>{core.server.closeAllConnections();core.server.close(r);}),new Promise(r=>{mock.closeAllConnections();mock.close(r);})]);}
}

if(process.argv[2]==='scenario'){
 console.log=()=>{};
 scenario(process.argv[3]==='1',process.argv[4]==='1').then(()=>process.stdout.write('history scenario passed\n')).catch(e=>{console.error(e);process.exitCode=1;});
}else{
 const test=require('node:test'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
 for(const [full,fresh]of [[false,false],[true,false],[true,true],[false,true]]){
  test(`History full=${full}, newChat=${fresh}: follow-up and regeneration in all three APIs`,async()=>{
   const result=await promisify(execFile)(process.execPath,[__filename,'scenario',full?'1':'0',fresh?'1':'0'],{timeout:30000});assert.ok(result.stdout.includes('history scenario passed'));
  });
 }
}
