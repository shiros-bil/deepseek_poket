const {execFileSync}=require('node:child_process');
const assert=require('node:assert/strict');
const path=require('node:path');
const adb=path.resolve('.tools/android-test-sdk/platform-tools/adb.exe');
const run=(...args)=>execFileSync(adb,['-s','emulator-5554',...args],{encoding:'utf8'}).trim();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 run('forward','tcp:19655','tcp:9655');
 const config=JSON.parse(process.env.POCKET_RELEASE_TEST==='1'
  ? run('shell','cat','/data/user/0/ai.freedeepseek.pocket/files/config.json')
  : run('shell','run-as','ai.freedeepseek.pocket','cat','files/config.json'));
 const base='http://127.0.0.1:19655',headers={Authorization:'Bearer '+config.key};
 const health=await(await fetch(base+'/health',{headers})).json();assert.equal(health.config_ready,true);
 assert.equal(health.session_reuse.send_full_history,!!config.sendFullHistory);
 assert.equal(health.session_reuse.new_chat_each_message,!!config.sendFullHistory&&!!config.newChatEachMessage);
 assert.equal((await fetch(base+'/v1/models')).status,config.key?401:200);
 const models=await(await fetch(base+'/v1/models',{headers})).json();assert.deepEqual(models.data.map(m=>m.id),['deepseek-v4.1-flash','deepseek-v4.1-flash-thinking']);
 assert.equal((await fetch(base+'/v1/sessions',{headers})).status,200);
 run('shell','input','keyevent','3');await sleep(2500);
 assert.equal((await fetch(base+'/health',{headers})).status,200,'foreground service survives UI backgrounding');
 run('shell','am','start','-n','ai.freedeepseek.pocket/.MainActivity');await sleep(1000);
 run('shell','input','tap','155','392');await sleep(1000);
 let stopped=false;try{await fetch(base+'/health',{signal:AbortSignal.timeout(1500)});}catch{stopped=true;}
 assert.ok(stopped,'Stop button terminates the server');
 run('shell','input','tap','155','392');await sleep(1700);
 assert.equal((await fetch(base+'/health',{headers})).status,200,'Node can restart in a new service process');
 console.log('Android 11 x86_64 smoke checks passed: native UI start, auth, models, sessions, background service, stop and restart. No real DeepSeek generation was requested.');
})().catch(e=>{console.error(e);process.exitCode=1;});
