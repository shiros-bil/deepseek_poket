const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
(async()=>{
 const output=path.resolve('artifacts/screenshots');fs.mkdirSync(output,{recursive:true});
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:1});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  await page.addInitScript(()=>{
   Object.defineProperty(Animation.prototype,'finished',{get(){return undefined;},configurable:true});
   const config={port:9655,lan:false,wakeLock:true,autoStart:false,envText:''};
   let running=false,accounts=[],preferences=JSON.parse(localStorage.getItem('test-native-preferences')||'{"language":"en","theme":"dark"}');
   window.Pocket={call(raw){const r=JSON.parse(raw);let data=true,error=null;
    switch(r.action){
     case 'state':data={config,preferences,running,accounts,addresses:['192.168.1.24'],batteryExempt:false,...(running?{health:{config_ready:true,agents:2,in_flight:0,total_messages:12,accounts:accounts.map(()=>({ready:true}))}}:{})};break;
     case 'savePreferences':preferences=r.params;localStorage.setItem('test-native-preferences',JSON.stringify(preferences));data=preferences;break;
     case 'start':if(!accounts.length)error='Добавьте аккаунт DeepSeek во вкладке «Аккаунты».';else running=true;break;
     case 'stop':running=false;break;
     case 'importAccount':if(!r.params.raw.includes('token'))error='Нужны token и cookie.';else accounts.push({id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json',name:r.params.name||'Тестовый аккаунт',ready:true});break;
     case 'deleteAccount':accounts=[];break;
     case 'saveConfig':Object.assign(config,r.params);break;
     case 'sessions':data={agents:[{agent:'test-agent',message_count:4,age_min:3,remote_chars:2100,busy:false}]};break;
     case 'copy':window.lastCopy=r.params;break;
     case 'logs':data='2026-10-29T12:00:00.000Z INFO [DS-API] Server on http://127.0.0.1:9655\n2026-10-29T12:00:01.000Z INFO [DS-API] Request accepted (openai, flash)\n2026-10-29T12:00:02.000Z INFO [chat] Response openai (tool=false, 1234ms, 80 chars)\n2026-10-29T12:00:03.000Z ERROR [DS-API] Error: HTTP 401 authentication';break;
     case 'diagnose':data={accounts:accounts.length,service:running,ready:{ready:true}};break;
     case 'capabilities':data={data:{'deepseek-v4.1-flash':{supported:true,search_enabled:true},'deepseek-v4.1-flash-thinking':{supported:true,thinking_enabled:true,search_enabled:true}}};break;
     case 'chat':window.lastChat=r.params;window.chatRequests=(window.chatRequests||[]).concat(JSON.parse(JSON.stringify(r.params)));if(window.failNextChat){error='Offline test failure';window.failNextChat=false;}else setTimeout(()=>window.nativeEvent('chunk',JSON.stringify({id:r.id,chunk:{choices:[{delta:{content:r.params.regenerate?'Regenerated reply. Привет, мир!':'Connection works. Привет, мир!'}}]}})),20);break;
    }
    setTimeout(()=>window.nativeEvent('reply',JSON.stringify({id:r.id,data,error})),r.action==='chat'?80:5);
   }};
  });
  await page.goto('file:///'+path.resolve('app/src/main/assets/ui/index.html').replace(/\\/g,'/'));
  await page.waitForFunction(()=>document.getElementById('statAccounts').textContent==='00');
  assert.equal(await page.locator('html').getAttribute('lang'),'en');assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
  assert.equal(await page.locator('svg').count(),0,'all UI icons come from downloaded SVG assets');
  assert.equal(await page.locator('footer,.privacy,.about,[data-icon="cpu"]').count(),0,'removed footer, privacy copy, settings branding and CPU icons');
  assert.equal(await page.locator('.brand-mark [data-icon="deepseek"]').count(),1);
  assert.equal(await page.locator('#prompt').evaluate(el=>getComputedStyle(el).resize),'none');
  await page.evaluate(()=>{for(const el of document.querySelectorAll('[data-icon]'))if(!el.style.getPropertyValue('--icon').includes('data:image/svg+xml;base64,'))throw new Error('Missing offline SVG: '+el.dataset.icon);});
  await page.evaluate(()=>{for(const el of document.querySelectorAll('[data-i18n]'))if(!STRINGS[el.dataset.i18n])throw new Error('Missing translation: '+el.dataset.i18n);});
  await page.screenshot({path:path.join(output,'01-overview.png'),fullPage:true,animations:'disabled'});
  await page.getByRole('button',{name:'Accounts',exact:true}).click();
  await page.getByRole('button',{name:'Paste JSON',exact:true}).click();
  await page.locator('#importName').fill('My DeepSeek');await page.locator('#importRaw').fill('{"token":"test","cookie":"test"}');
  await page.locator('#importDialog .primary').click();
  await page.waitForSelector('.account-card');await page.screenshot({path:path.join(output,'02-accounts.png'),fullPage:true,animations:'disabled'});
  await page.getByRole('button',{name:'Overview',exact:true}).click();await page.locator('#powerButton').click();
  await page.waitForFunction(()=>document.getElementById('serverBadge').textContent.includes('API ONLINE'));
  assert.equal(await page.locator('#statFlight').textContent(),'12');assert.equal(await page.locator('.feature-strip,.protocols [data-icon]').count(),0);await page.locator('.protocols>div').first().click();await page.waitForTimeout(30);assert.equal(await page.evaluate(()=>window.lastCopy.value),'http://127.0.0.1:9655/v1/chat/completions');
  await page.screenshot({path:path.join(output,'03-running.png'),fullPage:true,animations:'disabled'});
  await page.getByRole('button',{name:'Chat',exact:true}).click();
  assert.deepEqual(await page.locator('#chatModel option').evaluateAll(options=>options.map(o=>o.value)),['deepseek-v4.1-flash','deepseek-v4.1-flash-thinking']);
  await page.locator('#chatModel').selectOption('deepseek-v4.1-flash-thinking');
  await page.locator('#prompt').fill('Привет!');await page.locator('#sendButton').click();
  await page.waitForFunction(()=>document.querySelector('.bubble.assistant .message-body')?.textContent.includes('Привет, мир!'));
  assert.equal(await page.evaluate(()=>window.lastChat.model),'deepseek-v4.1-flash-thinking');
  await page.locator('#regenerateButton').click();await page.waitForFunction(()=>document.querySelector('.bubble.assistant .message-body')?.textContent.includes('Regenerated reply'));
  assert.equal(await page.evaluate(()=>window.lastChat.regenerate),true);
  assert.equal(await page.locator('.bubble.user').count(),1,'regeneration must not duplicate the user message');
  assert.equal(await page.locator('.bubble.assistant').count(),1,'regeneration replaces the previous answer');
  assert.deepEqual(await page.evaluate(()=>window.lastChat.messages.map(m=>m.role)),['user'],'the replaced assistant answer must not be sent');
  await page.evaluate(()=>window.failNextChat=true);await page.locator('#regenerateButton').click();
  await page.waitForFunction(()=>!generating);assert.ok((await page.locator('.bubble.assistant .message-body').innerText()).includes('Regenerated reply'),'failed regeneration restores the answer');
  await page.locator('#prompt').fill('Second message');await page.locator('#sendButton').click();await page.waitForFunction(()=>!generating);
  await page.locator('#regenerateButton').click();await page.waitForFunction(()=>!generating);
  assert.deepEqual(await page.evaluate(()=>window.lastChat.messages.map(m=>m.role)),['user','assistant','user'],'multi-turn regeneration keeps earlier turns');
  assert.equal(await page.locator('.bubble.user').count(),2);assert.equal(await page.locator('.bubble.assistant').count(),2);
  await page.screenshot({path:path.join(output,'04-chat.png'),fullPage:true,animations:'disabled'});
  await page.getByRole('button',{name:'Activity',exact:true}).click();await page.waitForSelector('.session-card');
  await page.getByRole('button',{name:'Logs',exact:true}).click();await page.waitForSelector('.log-event');assert.ok((await page.locator('.log-events').textContent()).includes('Reply sent · 1.2s · 80 characters'));assert.ok((await page.locator('.log-events').textContent()).includes('Sign-in expired'));assert.equal(await page.locator('details .log-output').isVisible(),false);
  await page.screenshot({path:path.join(output,'05-activity.png'),fullPage:true,animations:'disabled'});
  await page.locator('nav [data-page=settings]').click();assert.equal(await page.locator('#settingPort').isDisabled(),true);await page.evaluate(async()=>{await call('stop');await refresh();});assert.equal(await page.locator('#settingPort').isDisabled(),false);await page.locator('#settingPort').fill('9777');await page.evaluate(()=>refresh());
  assert.equal(await page.locator('#settingPort').inputValue(),'9777','polling must not overwrite edited settings');
  assert.equal(await page.locator('#newChatSetting').isVisible(),false);
  page.removeAllListeners('dialog');page.once('dialog',d=>d.dismiss());await page.locator('#settingFullHistory').click();assert.equal(await page.locator('#settingFullHistory').isChecked(),false,'cancelled warning keeps history replay off');page.on('dialog',d=>d.accept());
  await page.locator('#settingFullHistory').check();assert.equal(await page.locator('#newChatSetting').isVisible(),true);assert.equal(await page.locator('#historyWarning').isVisible(),true);
  await page.locator('#settingNewChat').check();await page.locator('#settingFullHistory').uncheck();
  assert.equal(await page.locator('#newChatSetting').isVisible(),false);assert.equal(await page.locator('#settingNewChat').isChecked(),false);
  await page.locator('#settingFullHistory').check();await page.locator('#settingNewChat').check();
  await page.evaluate(()=>saveSettings({preventDefault(){}}));
  assert.equal(await page.evaluate(()=>stateData.config.sendFullHistory),true);assert.equal(await page.evaluate(()=>stateData.config.newChatEachMessage),true);
  await page.locator('#settingPublic').check();await page.locator('#settingTunnelMode').selectOption('named');assert.equal(await page.locator('#namedSettings').isVisible(),true);await page.locator('#settingTunnelMode').selectOption('quick');assert.equal(await page.locator('#namedSettings').isVisible(),false);assert.ok((await page.locator('#quickHint').textContent()).includes('stream: false'));
  await page.locator('nav [data-page=home]').click();await page.waitForSelector('#unsavedDialog[open]');await page.evaluate(()=>handleBack());await page.waitForFunction(()=>!settingsNavigationPending);assert.equal(await page.evaluate(()=>currentPage),'settings');
  await page.locator('nav [data-page=home]').click();await page.locator('#discardChanges').click();await page.waitForFunction(()=>currentPage==='home');assert.equal(await page.evaluate(()=>settingsDirty),false);
  await page.locator('nav [data-page=settings]').click();await page.locator('#settingPort').fill('9888');await page.locator('nav [data-page=home]').click();await page.locator('#applyChanges').click();await page.waitForFunction(()=>currentPage==='home');assert.equal(await page.evaluate(()=>stateData.config.port),9888);
  await page.locator('nav [data-page=settings]').click();
  await page.screenshot({path:path.join(output,'06-settings.png'),fullPage:true,animations:'disabled'});
  await page.locator('#settingLanguage').selectOption('ru');await page.evaluate(()=>preferenceQueue);
  assert.equal(await page.locator('html').getAttribute('lang'),'ru');assert.equal(await page.locator('nav button[data-page=settings]').innerText(),'Настройки');
  await page.locator('#settingTheme').selectOption('light');await page.evaluate(()=>preferenceQueue);
  assert.equal(await page.locator('html').getAttribute('data-theme'),'light');
  await page.screenshot({path:path.join(output,'07-russian-light.png'),fullPage:true,animations:'disabled'});
  for(const language of ['en','ru'])for(const theme of ['dark','light']){
   await page.evaluate(async p=>{document.getElementById('settingLanguage').value=p.language;document.getElementById('settingTheme').value=p.theme;await changePreferences();},{language,theme});
   assert.equal(await page.locator('.brand-mark').evaluate(el=>getComputedStyle(el).color),'rgb(0, 0, 0)','DeepSeek mark stays black in either theme');
  for(const width of [320,390,600]){
   await page.setViewportSize({width,height:844});
   for(const tab of ['home','accounts','chat','activity','settings']){
    await page.evaluate(tab=>navigate(tab),tab);await page.waitForTimeout(50);
    const layout=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth,nav:document.querySelector('nav').getBoundingClientRect().bottom,height:innerHeight}));
    assert.ok(layout.scroll<=width,`${tab} overflows at ${width}: ${layout.scroll}`);
    assert.ok(Math.abs(layout.nav-layout.height)<2,'navigation stays at the bottom');
   }
  }
  }
  await page.reload();await page.waitForFunction(()=>document.documentElement.lang==='ru'&&document.documentElement.dataset.theme==='light');
  await page.evaluate(async()=>{navigate('accounts');navigate('chat');await navigate('settings');});await page.waitForTimeout(300);
  assert.equal(await page.locator('.page.active').count(),1);assert.equal(await page.locator('.page.active').getAttribute('id'),'page-settings');
  assert.deepEqual(errors,[]);console.log('UI checks passed: navigation, import, startup, SSE chat, settings, 3 viewport widths. Screenshots: '+output);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
