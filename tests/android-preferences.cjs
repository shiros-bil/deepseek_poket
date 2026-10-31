const {execFileSync}=require('node:child_process');
const assert=require('node:assert/strict'),path=require('node:path');
const adb=path.resolve('.tools/android-test-sdk/platform-tools/adb.exe');
const run=(...args)=>execFileSync(adb,['-s','emulator-5554',...args],{encoding:'utf8'}).trim();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const prefs=()=>JSON.parse(run('shell','cat','/data/user/0/ai.freedeepseek.pocket/files/ui-preferences.json'));
(async()=>{
 const pid=run('shell','pidof','ai.freedeepseek.pocket:proxy');assert.ok(pid);
 run('shell','input','tap','155','364');await sleep(800);assert.equal(prefs().language,'ru');
 run('shell','input','tap','155','446');await sleep(400);
 run('shell','input','tap','155','364');await sleep(800);assert.deepEqual(prefs(),{language:'ru',theme:'light'});
 assert.equal(run('shell','pidof','ai.freedeepseek.pocket:proxy'),pid,'appearance changes must not restart the API');
 run('shell','screencap','-p','/sdcard/pocket-ru-light.png');run('pull','/sdcard/pocket-ru-light.png','artifacts/screenshots/android-1.1-ru-light.png');
 run('shell','am','force-stop','ai.freedeepseek.pocket');run('shell','am','start','-n','ai.freedeepseek.pocket/.MainActivity');await sleep(1300);
 assert.deepEqual(prefs(),{language:'ru',theme:'light'});
 run('shell','screencap','-p','/sdcard/pocket-persisted.png');run('pull','/sdcard/pocket-persisted.png','artifacts/screenshots/android-1.1-persisted.png');
 console.log('Release APK: language/theme changes persisted, applied while the API stayed in the same process, and survived app force-stop/relaunch.');
})().catch(e=>{console.error(e);process.exitCode=1;});
