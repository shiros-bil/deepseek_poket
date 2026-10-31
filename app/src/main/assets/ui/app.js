'use strict';
const $=id=>document.getElementById(id),pending=new Map();
const AVAILABLE_MODELS=['deepseek-v4.1-flash','deepseek-v4.1-flash-thinking'];
let serial=0,currentPage='home',currentActivity='sessions',stateData=null,refreshing=false;
let settingsDirty=false,accountSnapshot='',messages=[],attachments=[],generating=false,activeMessage=null;
let chatSession='pocket-playground-'+Date.now().toString(36),preferencesReady=false,preferenceRevision=0,preferenceQueue=Promise.resolve();
let lastAnswer=null,navigationRevision=0,navigationAnimation=null,clearKey=false,settingsNavigationPending=false;
const pageScroll=new Map();
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function toast(message){$('toast').textContent=message;$('toast').classList.add('visible');clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').classList.remove('visible'),5000);}
function call(action,params={},timeout=12000){return new Promise((resolve,reject)=>{
 if(!window.Pocket){reject(new Error(t('nativeRequired')));return;}
 const id=String(++serial),timer=setTimeout(()=>{pending.delete(id);reject(new Error(t('timeout')));},timeout);
 pending.set(id,{resolve,reject,timer});Pocket.call(JSON.stringify({id,action,params}));
});}
async function act(action,params={}){try{const r=await call(action,params);if(['importAccount','deleteAccount','saveConfig'].includes(action))await refresh();return r;}catch(e){toast(e.message);return null;}}
window.nativeEvent=(type,raw)=>{
 if(type==='reply'){const r=JSON.parse(raw),p=pending.get(r.id);if(!p)return;clearTimeout(p.timer);pending.delete(r.id);if(r.error)p.reject(new Error(r.error));else p.resolve(r.data);}
 else if(type==='chunk'){
  const {id,chunk}=JSON.parse(raw);if(!activeMessage||!pending.has(id))return;
  if(chunk.error){activeMessage.error=typeof chunk.error==='string'?chunk.error:chunk.error.message;return;}
  const delta=chunk.choices?.[0]?.delta||{};if(delta.content)activeMessage.content+=delta.content;if(delta.reasoning_content)activeMessage.reasoning+=delta.reasoning_content;updateActiveMessage();
 }else if(type==='toast')toast(raw);
 else if(type==='import')openImport(raw);
 else if(type==='image'){if(attachments.length>=4){toast(t('maxImages'));return;}attachments.push(raw);renderAttachments();}
 else if(type==='resume')refresh();
};
function emptyChat(fresh=false){$('chatMessages').innerHTML='<div class="chat-empty">'+icon('sparkles','empty-symbol')+'<h2>'+t(fresh?'newChatTitle':'chatEmptyTitle')+'</h2><p>'+t(fresh?'firstMessage':'chatEmptyText')+'</p>'+(!fresh?'<button class="suggestion inline-link" onclick="suggest(t(\'suggestionPrompt\'))"><span>'+t('suggestion')+'</span>'+icon('arrow-up-right')+'</button>':'')+'</div>';}
function appearanceChanged(){
 translateStatic();hydrateIcons();if(stateData)renderState();else renderAccounts();modelChanged();
 if(!messages.length)emptyChat();if(activeMessage)updateActiveMessage();renderAttachments();
 $('sendButton').setAttribute('aria-label',t(generating?'stopGeneration':'send'));
 if(currentPage==='activity')loadActivity();
}
function changePreferences(){
 const previous={...preferences},next={language:$('settingLanguage').value,theme:$('settingTheme').value},revision=++preferenceRevision;
 preferencesReady=true;applyPreferences(next);appearanceChanged();
 preferenceQueue=preferenceQueue.catch(()=>{}).then(()=>call('savePreferences',next)).catch(e=>{if(revision===preferenceRevision){applyPreferences(previous);appearanceChanged();}toast(e.message);});
 return preferenceQueue;
}
function updateNavigationIndicator(){const nav=document.querySelector('nav'),button=nav.querySelector('button.active');if(button){const n=nav.getBoundingClientRect(),b=button.getBoundingClientRect();nav.style.setProperty('--nav-indicator-x',(b.left-n.left+b.width/2)+'px');}}
function waitForAnimation(animation,duration){
 if(animation.finished&&typeof animation.finished.then==='function')return animation.finished.catch(()=>{});
 return new Promise(resolve=>{let done=false;const finish=()=>{if(done)return;done=true;clearTimeout(timer);resolve();};const timer=setTimeout(finish,duration+60);animation.onfinish=finish;animation.oncancel=finish;});
}
async function navigate(page){
 if(!['home','accounts','chat','activity','settings'].includes(page))return;
 if(currentPage==='settings'&&page!=='settings'&&settingsDirty){if(settingsNavigationPending)return;settingsNavigationPending=true;const leave=await resolveUnsaved();settingsNavigationPending=false;if(!leave)return;}
 if(page===currentPage&&!navigationAnimation){refresh();return;}
 const revision=++navigationRevision,outgoing=document.querySelector('.page.active');
 pageScroll.set(currentPage,window.scrollY);if(navigationAnimation)navigationAnimation.cancel();
 document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('active',b.dataset.page===page));updateNavigationIndicator();
 const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
 if(outgoing?.animate&&!reduced){navigationAnimation=outgoing.animate([{opacity:1,transform:'translate3d(0,0,0)'},{opacity:0,transform:'translate3d(0,-5px,0)'}],{duration:90,easing:'ease-out'});await waitForAnimation(navigationAnimation,90);}
 if(revision!==navigationRevision)return;currentPage=page;
 document.querySelectorAll('.page').forEach(p=>p.classList.toggle('active',p.id==='page-'+page));
 window.scrollTo(0,pageScroll.get(page)||0);
 const incoming=$('page-'+page);
 if(incoming.animate&&!reduced){navigationAnimation=incoming.animate([{opacity:0,transform:'translate3d(0,10px,0)'},{opacity:1,transform:'translate3d(0,0,0)'}],{duration:230,easing:'cubic-bezier(.2,.7,.25,1)'});waitForAnimation(navigationAnimation,230).then(()=>{if(revision===navigationRevision)navigationAnimation=null;});}else navigationAnimation=null;
 if(page==='activity')loadActivity();if(page==='settings'&&!settingsDirty)fillSettings();if(page==='accounts')renderAccounts();refresh();
}
window.handleBack=()=>{const open=document.querySelector('dialog[open]');if(open?.id==='unsavedDialog')$('staySettings').click();else if(open)open.close();else if(currentPage!=='home')navigate('home');else toast(t('homeHint'));};
document.querySelector('.brand').addEventListener('click',e=>{e.preventDefault();navigate('home');});
async function refresh(){if(refreshing||!window.Pocket)return;refreshing=true;try{
 stateData=await call('state');if(!preferencesReady){applyPreferences(stateData.preferences||preferences);preferencesReady=true;appearanceChanged();}renderState();
}catch(e){toast(e.message);}finally{refreshing=false;}}
function renderState(){
 const s=stateData,c=s.config,h=s.health,online=!!h,starting=s.running&&!h,ready=!!h?.config_ready;
 $('serverBadge').classList.toggle('online',online);$('serverBadge').querySelector('span').textContent=t(starting?'starting':online?(ready?'online':'needsAccount'):'stopped');
 $('serverTitle').textContent=t(starting?'startingTitle':online?'onlineTitle':'readyTitle');
 $('serverDescription').textContent=starting?t('startingDescription'):online?t(ready?'onlineDescription':'notReadyDescription'):s.lastError?t('lastLaunch')+s.lastError:t(s.accounts.length?'readyDescription':'noAccountDescription');
 $('powerLabel').textContent=t(s.running?'stop':'start');$('statAccounts').textContent=String(s.accounts.length).padStart(2,'0');$('statSessions').textContent=h?String(h.agents??0).padStart(2,'0'):'—';$('statFlight').textContent=h?String(h.total_messages??s.totalMessages??0).padStart(2,'0'):String(s.totalMessages??0).padStart(2,'0');
 $('endpoint').textContent=`http://127.0.0.1:${c.port}/v1`;$('networkType').textContent=t(c.lan?'localNetwork':'phoneOnly');
 $('lanAddresses').textContent=c.lan?(s.addresses.length?t('networkPrefix')+s.addresses.map(ip=>`http://${ip}:${c.port}/v1`).join(' · '):t('networkWaiting')):'';
 $('overviewKey').hidden=!c.hasKey;renderTunnel();$('serverSettings').disabled=!!s.running;$('settingsLock').hidden=!s.running;
 $('batteryTip').hidden=s.batteryExempt||!s.running;
 const snapshot=JSON.stringify([s.accounts,h?.accounts,preferences.language]);if(snapshot!==accountSnapshot){accountSnapshot=snapshot;renderAccounts();}if(!settingsDirty)fillSettings();
}
async function toggleServer(){if(!stateData)return;const button=$('powerButton');button.disabled=true;try{
 await call(stateData.running?'stop':'start');toast(t(stateData.running?'stoppingToast':'startingToast'));setTimeout(refresh,700);setTimeout(refresh,2200);setTimeout(refresh,6000);
}catch(e){toast(e.message);if(!stateData.accounts.length)navigate('accounts');}finally{setTimeout(()=>button.disabled=false,900);}}
function copyEndpoint(){act('copy',{value:$('endpoint').textContent}).then(r=>{if(r)toast(t('addressCopied'));});}
function copyKey(){act('copy',{kind:'key'}).then(r=>{if(r)toast(t('keyCopied'));});}
function renderAccounts(){
 if(!stateData)return;const accounts=stateData.accounts;
 if(!accounts.length){$('accountsList').innerHTML='<div class="empty-state">'+icon('users','empty-symbol')+'<h2>'+t('accountEmptyTitle')+'</h2><p>'+t('accountEmptyText')+'</p></div>';return;}
 $('accountsList').innerHTML=accounts.map((a,i)=>{const live=stateData.health?.accounts?.[i],status=live?.cooldown?t('cooldown',{seconds:live.cooldown_remaining_sec}):t(a.ready?(stateData.running?'connected':'ready'):'loginRequired');
  return `<div class="panel account-card"><span class="avatar">${String(i+1).padStart(2,'0')}</span><div><h3>${esc(a.name)}</h3><p>${esc(status)}</p></div><button class="icon-button delete-account" data-id="${esc(a.id)}" aria-label="${t('deleteAccount')}">${icon('x')}</button></div>`;
 }).join('');
 document.querySelectorAll('.delete-account').forEach(b=>b.onclick=async()=>{if(stateData.running){toast(t('stopFirst'));return;}if(confirm(t('deleteConfirm')))await act('deleteAccount',{id:b.dataset.id});});
}
function openImport(raw=''){if(stateData?.running){toast(t('stopImport'));return;}$('importRaw').value=raw;$('importName').value='';$('importToken').value='';$('importDialog').showModal();}
async function importAccount(){const button=$('importDialog').querySelector('.primary');button.disabled=true;try{
 await call('importAccount',{raw:$('importRaw').value,token:$('importToken').value,name:$('importName').value});$('importDialog').close();$('importRaw').value='';$('importToken').value='';toast(t('accountAdded'));await refresh();
}catch(e){toast(e.message);}finally{button.disabled=false;}}
function updateHistorySettings(){const full=$('settingFullHistory').checked;if(!full)$('settingNewChat').checked=false;$('newChatSetting').hidden=!full;$('historyWarning').hidden=!full;}
function historySettingsChanged(master){if(master&&$('settingFullHistory').checked&&!confirm(t('historyWarningText')))$('settingFullHistory').checked=false;updateHistorySettings();settingsDirty=true;}
function fillSettings(){if(!stateData)return;const c=stateData.config;$('settingPort').value=c.port;$('settingLan').checked=c.lan;$('settingWake').checked=c.wakeLock;$('settingBoot').checked=c.autoStart;$('settingEnv').value=c.envText||'';$('settingFullHistory').checked=!!c.sendFullHistory;$('settingNewChat').checked=!!c.sendFullHistory&&!!c.newChatEachMessage;updateHistorySettings();$('settingPublic').checked=!!c.publicEnabled;$('settingTunnelMode').value=c.tunnelMode||'quick';$('settingPublicUrl').value=c.tunnelPublicUrl||'';$('settingAnyOrigin').checked=c.tunnelAllowAnyOrigin!==false;$('settingOrigins').value=c.tunnelOrigins||'';$('keyStatus').textContent=t(c.hasKey&&!clearKey?'keyOn':'keyOff');updateTunnelSettings();}
$('settingsForm').addEventListener('input',()=>settingsDirty=true);
async function saveSettings(e){e?.preventDefault();if(stateData?.running){toast(t('stopFirst'));return false;}try{
 await call('saveConfig',{port:Number($('settingPort').value),lan:$('settingLan').checked,wakeLock:$('settingWake').checked,autoStart:$('settingBoot').checked,key:$('settingKey').value,clearKey,publicEnabled:$('settingPublic').checked,tunnelMode:$('settingTunnelMode').value,tunnelToken:$('settingTunnelToken').value,tunnelPublicUrl:$('settingPublicUrl').value,tunnelAllowAnyOrigin:$('settingAnyOrigin').checked,tunnelOrigins:$('settingOrigins').value,envText:$('settingEnv').value,sendFullHistory:$('settingFullHistory').checked,newChatEachMessage:$('settingFullHistory').checked&&$('settingNewChat').checked});settingsDirty=false;clearKey=false;$('settingKey').value='';$('settingTunnelToken').value='';toast(t('settingsSaved'));await refresh();return true;
}catch(error){toast(error.message);return false;}}
function activityTab(tab,button){currentActivity=tab;document.querySelectorAll('.segmented button').forEach(b=>b.classList.toggle('selected',b===button));loadActivity();}
async function loadActivity(){
 const container=$('activityContent');container.textContent=t('loading');try{
 if(currentActivity==='logs'){
  const logs=await call('logs');container.innerHTML='<div class="activity-actions"><button class="text-button" id="refreshLogs">'+t('refresh')+'</button><button class="text-button" id="exportLogs">'+t('save')+'</button><button class="text-button" id="clearLogs">'+t('clear')+'</button></div><pre class="log-output"></pre>';container.querySelector('pre').textContent=logs;const pre=container.querySelector('pre'),details=document.createElement('details');details.innerHTML='<summary>'+t('technicalDetails')+'</summary>';pre.before(details);details.append(pre);const events=document.createElement('div');events.className='log-events';events.innerHTML=friendlyLogs(logs);details.before(events);$('refreshLogs').onclick=loadActivity;$('exportLogs').onclick=()=>act('exportLogs');$('clearLogs').onclick=async()=>{await act('clearLogs');loadActivity();};
 }else if(currentActivity==='diagnose'){
  const d=await call('diagnose');container.innerHTML='<div class="panel diagnostic"><div class="eyebrow">'+t('localDiagnostics')+'</div><pre></pre><button class="text-button inline-link" id="refreshDiagnosis">'+t('checkAgain')+icon('arrow-up-right')+'</button></div><p class="micro">'+t('diagnosticHelp')+'</p>';container.querySelector('pre').textContent=JSON.stringify(d,null,2);$('refreshDiagnosis').onclick=loadActivity;
 }else{
  if(!stateData?.health){container.innerHTML='<div class="empty-state">'+icon('server','empty-symbol')+'<h2>'+t('serverStopped')+'</h2><p>'+t('startSessions')+'</p></div>';return;}
  const data=await call('sessions');container.innerHTML='<div class="activity-actions"><button class="text-button" id="refreshSessions">'+t('refresh')+'</button><button class="text-button" id="resetAll">'+t('resetAll')+'</button></div>'+(data.agents.length?data.agents.map(s=>`<div class="panel session-card"><div class="section-head"><code>${esc(s.agent)}</code><span class="pill">${t(s.busy?'busy':'idle')}</span></div><div class="session-meta"><span>${t('messagesCount',{count:s.message_count})}</span><span>${t('minutes',{count:s.age_min})}</span><span>${t('chars',{count:s.remote_chars||0})}</span></div><button class="text-button reset-session inline-link" data-agent="${esc(s.agent)}">${t('resetSession')}${icon('arrow-up-right')}</button></div>`).join(''):'<div class="empty-state">'+icon('terminal','empty-symbol')+'<h2>'+t('quiet')+'</h2><p>'+t('sessionEmpty')+'</p></div>');
  $('refreshSessions').onclick=loadActivity;$('resetAll').onclick=async()=>{if(confirm(t('resetConfirm'))){await act('reset',{agent:'all'});loadActivity();}};container.querySelectorAll('.reset-session').forEach(b=>b.onclick=async()=>{await act('reset',{agent:b.dataset.agent});loadActivity();});
 }
 }catch(e){container.innerHTML='<div class="empty-state"><h2>'+t('loadError')+'</h2><p></p><button class="text-button inline-link" onclick="loadActivity()">'+t('retry')+icon('arrow-up-right')+'</button></div>';container.querySelector('p').textContent=e.message;}
}
function model(){const chosen=$('chatModel').value;return AVAILABLE_MODELS.includes(chosen)?chosen:AVAILABLE_MODELS[0];}
function modelChanged(){$('chatHint').textContent=t(model()===AVAILABLE_MODELS[1]?'thinking':'flash');}
function suggest(text){$('prompt').value=text;$('prompt').focus();}
function renderAttachments(){$('attachments').innerHTML=attachments.map((a,i)=>`<span class="attachment"><img alt="${t('attachment',{count:i+1})}" src="${a}"><button aria-label="${t('removeAttachment')}" data-index="${i}">${icon('x')}</button></span>`).join('');$('attachments').querySelectorAll('button').forEach(b=>b.onclick=()=>{attachments.splice(Number(b.dataset.index),1);renderAttachments();});}
function appendBubble(role,text,images=[]){
 if(!messages.length)$('chatMessages').innerHTML='';const el=document.createElement('div');el.className='bubble '+role;
 if(role==='assistant'){const label=document.createElement('span');label.className='message-label';label.textContent=t(model()===AVAILABLE_MODELS[1]?'thinking':'flash').toUpperCase();el.append(label);}
 for(const image of images){const img=document.createElement('img');img.src=image;img.alt=t('attachedImage');el.append(img);}
 const body=document.createElement('div');body.className='message-body';body.textContent=text;el.append(body);$('chatMessages').append(el);return el;
}
function updateActiveMessage(){if(!activeMessage)return;const a=activeMessage;a.el.querySelector('.message-body').textContent=a.content||t('thinkingNow');if(a.reasoning){let r=a.el.querySelector('.reasoning');if(!r){r=document.createElement('details');r.className='reasoning';r.append(document.createElement('summary'),document.createElement('div'));a.el.insertBefore(r,a.el.querySelector('.message-body'));}r.firstChild.textContent=t('reasoning');r.lastChild.textContent=a.reasoning;}}
async function sendChat(){
 if(generating){await act('cancel');return;}const text=$('prompt').value.trim();if(!text&&!attachments.length)return;if(!stateData?.health){toast(t('startBeforeChat'));return;}
 const images=[...attachments],content=images.length?[{type:'text',text:text||t('describeImage')},...images.map(url=>({type:'image_url',image_url:{url}}))]:text;
 appendBubble('user',text,images);messages.push({role:'user',content});$('prompt').value='';attachments=[];renderAttachments();await generateReply(false);
}
function updateChatActions(){$('chatActions').hidden=generating||!lastAnswer;$('regenerateButton').disabled=generating;}
async function regenerateChat(){
 if(generating||!lastAnswer)return;if(!stateData?.health){toast(t('startBeforeChat'));return;}
 const previous=lastAnswer;messages.pop();previous.el.remove();await generateReply(true,previous);
}
async function generateReply(regenerate,previous=null){
 const el=appendBubble('assistant',t('thinkingNow'));activeMessage={el,content:'',reasoning:'',error:null};generating=true;lastAnswer=null;updateChatActions();
 $('sendButton').innerHTML=icon('square');$('sendButton').setAttribute('aria-label',t('stopGeneration'));$('chatModel').disabled=true;
 try{await call('chat',{model:model(),messages,user:chatSession,regenerate},720000);if(activeMessage.error)throw new Error(activeMessage.error);if(!activeMessage.content)throw new Error(t('emptyAnswer'));const message={role:'assistant',content:activeMessage.content};messages.push(message);lastAnswer={el,message};}
 catch(e){
  if(previous){el.remove();$('chatMessages').append(previous.el);messages.push(previous.message);lastAnswer=previous;toast(t('regenerationFailed')+' '+e.message);}
  else{const error=document.createElement('div');error.className='bubble error';error.textContent=e.message;el.append(error);if(activeMessage.content){const message={role:'assistant',content:activeMessage.content};messages.push(message);lastAnswer={el,message};}else{messages.pop();el.querySelector('.message-body').textContent=t('noAnswer');}}
 }
 finally{generating=false;activeMessage=null;$('sendButton').innerHTML=icon('arrow-up');$('sendButton').setAttribute('aria-label',t('send'));$('chatModel').disabled=false;updateChatActions();refresh();}
}
async function newChat(){if(generating){toast(t('stopBeforeNewChat'));return;}if(stateData?.health){try{await call('reset',{agent:chatSession});}catch(e){if(!e.message.includes('404')){toast(e.message);return;}}}chatSession='pocket-playground-'+Date.now().toString(36);messages=[];attachments=[];lastAnswer=null;updateChatActions();renderAttachments();emptyChat(true);}
async function showModels(){
 if(!stateData?.health){toast(t('startBeforeModels'));return;}
 try{const d=await call('capabilities');$('modelsContent').innerHTML=Object.entries(d.data).filter(([id])=>AVAILABLE_MODELS.includes(id)).map(([id,c])=>'<div class="model-row"><h3>'+icon(c.thinking_enabled?'sparkles':'zap')+' '+t(c.thinking_enabled?'thinking':'flash')+'</h3><code>'+esc(id)+'</code><div class="model-badges"><span class="pill">'+icon('search')+t('webSearch')+'</span>'+(c.thinking_enabled?'<span class="pill">'+icon('sparkles')+t('reasoningCapability')+'</span>':'')+'<span class="pill">'+icon('image')+t('imagesCapability')+'</span></div></div>').join('');$('modelsDialog').showModal();}catch(e){toast(e.message);}
}
emptyChat();modelChanged();updateHistorySettings();updateNavigationIndicator();window.addEventListener('resize',updateNavigationIndicator);document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});setInterval(()=>{if(!document.hidden)refresh();},4000);refresh();

function removeKey(){clearKey=true;$('settingKey').value='';$('keyStatus').textContent=t('keyOff');settingsDirty=true;}
async function stopForSettings(){await act('stop');for(let i=0;i<30;i++){await new Promise(r=>setTimeout(r,200));await refresh();if(!stateData.running)return;}}
function updateTunnelSettings(){const enabled=$('settingPublic').checked,named=$('settingTunnelMode').value==='named';$('tunnelSettings').hidden=!enabled;$('namedSettings').hidden=!named;$('quickHint').hidden=named;$('originSettings').hidden=$('settingAnyOrigin').checked;$('namedHint').textContent=t('namedHelp',{port:$('settingPort').value||9655});}
function renderTunnel(){const c=stateData.config,status=stateData.tunnel||{state:'stopped'},connected=status.state==='connected'&&status.url;const known=['stopped','waiting','connecting','connected','reconnecting','error'];$('tunnelStatus').textContent=t('tunnel_'+(known.includes(status.state)?status.state:'stopped'));$('publicEndpoint').textContent=connected?status.url.replace(/\/$/,'')+'/v1':t('noPublicAddress');$('copyPublic').disabled=!connected;$('tunnelToggle').textContent=t(!c.publicEnabled?'configure':status.state==='stopped'?'startTunnel':'stopTunnel');$('tunnelHint').textContent=t(c.tunnelMode==='named'?'namedHelp':'quickHelp',{port:c.port});}
async function toggleTunnel(){if(!stateData.config.publicEnabled){await navigate('settings');return;}if(!stateData.running){await toggleServer();return;}await act(stateData.tunnel?.state==='stopped'?'startTunnel':'stopTunnel');setTimeout(refresh,300);}
function copyPublicEndpoint(){if(stateData.tunnel?.state==='connected')act('copy',{value:$('publicEndpoint').textContent}).then(()=>toast(t('addressCopied')));}
function resolveUnsaved(){return new Promise(resolve=>{const dialog=$('unsavedDialog');dialog.showModal();const done=value=>{dialog.close();resolve(value);};$('applyChanges').onclick=async()=>{if(await saveSettings())done(true);};$('discardChanges').onclick=()=>{settingsDirty=false;clearKey=false;$('settingKey').value='';$('settingTunnelToken').value='';fillSettings();done(true);};$('staySettings').onclick=()=>done(false);dialog.oncancel=e=>{e.preventDefault();done(false);};});}
function friendlyLogs(raw){
 const events=[];
 for(const line of raw.split('\n')){
  let key='';
  if(/Server on http/.test(line))key='logStarted';
  else if(/Request accepted/.test(line))key='logReceived';
  else if(/(?:Streamed|Response) (?:openai|anthropic|responses)/i.test(line))key='logAnswer';
  else if(/Created new session:/.test(line))key='logSession';
  else if(/Reusing session:/.test(line))key='logContinue';
  else if(/Registered tunnel connection/.test(line))key='logTunnel';
  else if(/Retrying connection|reconnect/i.test(line))key='logTunnelRetry';
  else if(/retrying|retry \d/i.test(line))key='logRetry';
  else if(/shutting down/i.test(line))key='logStopped';
  else if(/ERROR|FATAL|\[DS-API\] Error:/.test(line))key=/401|403|auth|captcha|token/i.test(line)?'logAuth':/429|rate.limit/i.test(line)?'logRate':'logError';
  if(!key)continue;
  const stamp=line.match(/\d{4}-\d\d-\d\dT[\d:.]+Z?/),date=stamp?new Date(stamp[0]):null;
  const time=date&&!isNaN(date)?date.toLocaleTimeString(preferences.language==='ru'?'ru-RU':'en-GB'):'—';
  const detail=key==='logAnswer'?line.match(/tool=(?:true|false), (\d+)ms, (\d+) chars/):null;
  const text=detail?t('logReplyDetails',{seconds:(Number(detail[1])/1000).toFixed(1),count:detail[2]}):t(key);
  events.push('<div class="log-event"><time>'+esc(time)+'</time><span>'+text+'</span></div>');
 }
 return events.slice(-100).reverse().join('')||'<p class="micro">'+t('logEmpty')+'</p>';
}
document.querySelectorAll('.protocols>div').forEach(row=>{row.tabIndex=0;row.setAttribute('role','button');const copy=()=>act('copy',{value:'http://127.0.0.1:'+stateData.config.port+row.querySelector('code').textContent}).then(()=>toast(t('addressCopied')));row.onclick=copy;row.onkeydown=e=>{if(e.key==='Enter'||e.key===' ')copy();};});
