const assert=require('node:assert/strict');
const http=require('node:http');

async function scenario(full,fresh){
 const calls=[];let chatCounter=0;
 const mock=http.createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
  const body=raw?JSON.parse(raw):{};const json=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
  if(req.url==='/api/v0/chat/create_pow_challenge')return json({data:{biz_data:{challenge:{challenge:'test',salt:'s',expire_at:1,difficulty:1}}}});
  if(req.url==='/api/v0/chat_session/create')return json({data:{biz_data:{id:'remote-'+(++chatCounter)}}});
  if(req.url!=='/api/v0/chat/completion'){res.writeHead(404);res.end();return;}
  calls.push(body);
  if([2,5,8].includes(calls.length)||body.prompt.includes('ALWAYS_BLOCK')){
   res.writeHead(200,{'Content-Type':'text/event-stream'});
   res.write('data: '+JSON.stringify({v:{response:{fragments:[{type:'RESPONSE',content:'CAPTURED_PARTIAL'}]}}})+'\n\n');
   res.write('data: '+JSON.stringify({finish_reason:'content_filter'})+'\n\n');res.end();return;
  }
  const answer='ANSWER_'+calls.length,request=(body.parent_message_id||0)+1,response=request+1;
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
  for(const endpoint of ['/v1/chat/completions','/v1/messages','/v1/responses']){
   const initial=[{role:'system',content:'SYSTEM_RECOVERY'},{role:'user',content:'FIRST_RECOVERY'}];
   const first=await send(endpoint,endpoint,initial);const previous=calls.at(-1).chat_session_id;
   const before=calls.length;
   await send(endpoint,endpoint,[...initial,{role:'assistant',content:first},{role:'user',content:'CURRENT_RECOVERY'}]);
   assert.equal(calls.length,before+2,'one bounded recovery call');
   assert.notEqual(calls.at(-1).chat_session_id,previous);
   assert.ok(calls.at(-1).prompt.includes('FIRST_RECOVERY'));assert.ok(calls.at(-1).prompt.includes('CURRENT_RECOVERY'));assert.ok(calls.at(-1).prompt.includes('SYSTEM_RECOVERY'));assert.ok(calls.at(-1).prompt.includes('CAPTURED_PARTIAL'));
  }
  const before=calls.length;const failure=await fetch(base+'/v1/chat/completions',{method:'POST',headers,body:JSON.stringify({model:'deepseek-v4.1-flash',messages:[{role:'user',content:'ALWAYS_BLOCK'}]})});
  assert.equal(failure.status,502);assert.equal(calls.length,before+2);assert.ok(!(await failure.text()).includes('CAPTURED_PARTIAL'));
  const streaming=await fetch(base+'/v1/chat/completions',{method:'POST',headers,body:JSON.stringify({stream:true,model:'deepseek-v4.1-flash',messages:[{role:'user',content:'ALWAYS_BLOCK'}]})});
  const events=await streaming.text();assert.ok(!events.includes('CAPTURED_PARTIAL'));assert.ok(events.includes('error'));
  assert.equal(core.isReplacementStub({content:"Sorry, that’s beyond my current scope. Let’s talk about something else."}),true);
  assert.equal(core.isReplacementStub({content:'The phrase content_filter appears in this normal explanation.'}),false);
 }finally{await Promise.all([new Promise(r=>{core.server.closeAllConnections();core.server.close(r);}),new Promise(r=>{mock.closeAllConnections();mock.close(r);})]);}
}

if(process.argv[2]==='scenario'){
 console.log=()=>{};
 scenario(process.argv[3]==='1',process.argv[4]==='1').then(()=>process.stdout.write('history scenario passed\n')).catch(e=>{console.error(e);process.exitCode=1;});
}else{
 const test=require('node:test'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
 for(const [full,fresh]of [[false,false],[true,false]]){
  test(`Replacement recovery full=${full}: all three APIs, full replay and bounded retries`,async()=>{
   const result=await promisify(execFile)(process.execPath,[__filename,'scenario',full?'1':'0',fresh?'1':'0'],{timeout:30000});assert.ok(result.stdout.includes('history scenario passed'));
  });
 }
}
