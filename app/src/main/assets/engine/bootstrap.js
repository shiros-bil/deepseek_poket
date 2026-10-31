'use strict';
// Android adapter. server.js uses the Android edition's two-model policy;
// upstream lib/*.js remains unchanged.
const fs = require('fs');
const path = require('path');
const util = require('util');
const root = process.argv[2];
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const logFile = path.join(root, 'proxy.log');
const secrets = [config.key];
for (const name of fs.readdirSync(path.join(root, 'accounts'))) {
  if (!name.endsWith('.json')) continue;
  const a = JSON.parse(fs.readFileSync(path.join(root, 'accounts', name), 'utf8'));
  secrets.push(a.token, a.cookie, a.hif_dliq, a.hif_leim);
}
for (const level of ['log','info','warn','error']) {
  console[level] = (...args) => {
    let line = util.format(...args);
    for (const secret of secrets.filter(Boolean)) line = line.split(secret).join('[REDACTED]');
    line = line.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]');
    try {
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > 512 * 1024) {
        fs.writeFileSync(logFile, fs.readFileSync(logFile).subarray(-128 * 1024), {mode:0o600});
      }
      fs.appendFileSync(logFile, `${new Date().toISOString()} ${level.toUpperCase()} ${line.slice(0,8000)}\n`, {mode:0o600});
    } catch (_) {}
  };
}
// Same .env parser as the desktop version, including quoted values.
fs.writeFileSync(path.join(root, 'android.env'), config.envText || '', {mode:0o600});
require('./lib/env').loadDotEnv(path.join(root, 'android.env'));
Object.assign(process.env, {
  PORT: String(config.port), HOST: config.lan ? '0.0.0.0' : '127.0.0.1',
  PROXY_API_KEY: config.key||'', REQUIRE_PROXY_API_KEY:'0',
  POCKET_STATS_FILE:path.join(root,'message-stats.json'),
  DEEPSEEK_AUTH_DIR: path.join(root, 'accounts'), NON_INTERACTIVE:'1', SKIP_ACCOUNT_MENU:'1',
  DEEPSEEK_SEND_FULL_HISTORY:config.sendFullHistory?'1':'0',
  DEEPSEEK_NEW_CHAT_EACH_MESSAGE:config.sendFullHistory&&config.newChatEachMessage?'1':'0',
  PROXY_CORS_ALLOW_ANY:config.publicEnabled&&config.tunnelAllowAnyOrigin!==false?'1':'0',
  PROXY_CORS_ORIGINS:config.tunnelOrigins||''
});
// Mobile V8 builds may disable WASM tiering threads. The solver still uses the
// normal WebAssembly API and the upstream challenge format without changes.
process.chdir(__dirname);
process.argv = [process.argv[0], path.join(__dirname, 'server.js')];
require('module').runMain(process.argv[1]);
