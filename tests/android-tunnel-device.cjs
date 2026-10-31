const assert=require('node:assert/strict'),{execFileSync}=require('node:child_process'),path=require('node:path');
const adb=path.resolve('.tools/android-test-sdk/platform-tools/adb.exe');
const shell=(...args)=>execFileSync(adb,args,{encoding:'utf8',timeout:10000});
(async()=>{
 let status;for(let i=0;i<20;i++){status=JSON.parse(shell('shell','cat /data/user/0/ai.freedeepseek.pocket/files/tunnel-status.json'));if(status.state==='connected')break;await new Promise(r=>setTimeout(r,1000));}assert.equal(status.state,'connected');
 const local=await(await fetch('http://127.0.0.1:19655/health')).json();assert.equal(local.session_reuse.send_full_history,false);assert.equal(local.session_reuse.new_chat_each_message,false);assert.ok(!JSON.stringify(local).includes('watermark'));console.log('PASS: APK starts API and packaged cloudflared automatically; saved history flags off.');
 const remote=status.url,headers={Origin:'https://website.example'};
 const models=await fetch(remote+'/v1/models',{headers,signal:AbortSignal.timeout(25000)});assert.equal(models.status,200);assert.equal(models.headers.get('access-control-allow-origin'),headers.Origin);assert.equal((await models.json()).data.length,2);console.log('PASS: public HTTPS /v1/models works without API key, browser CORS reflected.');
 const pre=await fetch(remote+'/v1/chat/completions',{method:'OPTIONS',headers:{...headers,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type,x-stainless-lang'},signal:AbortSignal.timeout(25000)});assert.equal(pre.status,204);assert.ok(pre.headers.get('access-control-allow-headers').includes('x-stainless-lang'));console.log('PASS: public browser preflight accepts client SDK headers.');
 shell('shell','input keyevent 3');await new Promise(r=>setTimeout(r,1500));assert.equal((await fetch(remote+'/v1/models',{signal:AbortSignal.timeout(15000)})).status,200);console.log('PASS: HTTPS API continues while the app is in the background.');
 shell('shell','am start -n ai.freedeepseek.pocket/.MainActivity');shell('shell','uiautomator dump /sdcard/pocket-test.xml');shell('shell','input tap 150 392');
 for(let i=0;i<30;i++){try{await fetch('http://127.0.0.1:19655/health',{signal:AbortSignal.timeout(300)});}catch{break;}await new Promise(r=>setTimeout(r,300));}
 let closed=false;try{await fetch('http://127.0.0.1:19655/health',{signal:AbortSignal.timeout(500)});}catch{closed=true;}assert.ok(closed,'stopping the app server closes its port');
 status=JSON.parse(shell('shell','cat /data/user/0/ai.freedeepseek.pocket/files/tunnel-status.json'));assert.equal(status.state,'stopped');assert.equal(status.url,'');const processes=shell('shell','ps -A');assert.ok(!processes.includes('libcloudflared'));console.log('PASS: Stop kills cloudflared, clears the public URL and closes local API.');
})().catch(e=>{console.error(e);process.exitCode=1;});
