package ai.freedeepseek.pocket;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.*;
import android.provider.Settings;
import android.webkit.*;
import android.widget.*;
import org.json.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;

public class MainActivity extends Activity {
    private WebView web;
    private Store store;
    private final ExecutorService worker = Executors.newFixedThreadPool(4);
    private volatile HttpURLConnection chat;
    private boolean destroyed;
    @Override public void onCreate(Bundle state) {
        Ui.prepare(this);super.onCreate(state);store = new Store(this);Ui.applyWindow(this);
        web = new WebView(this); web.setBackgroundColor(Ui.background(this));
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setAllowContentAccess(false);
        web.getSettings().setAllowFileAccess(false);
        web.getSettings().setAllowFileAccessFromFileURLs(false);
        web.getSettings().setAllowUniversalAccessFromFileURLs(false);
        web.getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        web.addJavascriptInterface(new Bridge(),"Pocket");
        web.setWebChromeClient(new WebChromeClient(){
            @Override public boolean onJsConfirm(WebView view,String url,String message,JsResult result){
                new AlertDialog.Builder(MainActivity.this).setTitle("DeepSeek Pocket").setMessage(message)
                    .setPositiveButton(Ui.text(MainActivity.this,"Continue","Продолжить"),(dialog,which)->result.confirm())
                    .setNegativeButton(Ui.text(MainActivity.this,"Cancel","Отмена"),(dialog,which)->result.cancel())
                    .setOnCancelListener(dialog->result.cancel()).show();
                return true;
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest r) {
                if (r.getUrl().toString().startsWith("file:///android_asset/ui/")) return false;
                if ("https".equals(r.getUrl().getScheme())) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW,r.getUrl())); } catch(Exception ignored) {}
                }
                return true;
            }
        });
        setContentView(web); web.loadUrl("file:///android_asset/ui/index.html");
    }
    private void emit(String type, Object value) {
        String encoded = JSONObject.quote(String.valueOf(value));
        runOnUiThread(() -> { if (!destroyed) web.evaluateJavascript("window.nativeEvent&&window.nativeEvent("+JSONObject.quote(type)+","+encoded+")",null); });
    }
    private void reply(String id, Object data, String error) {
        try { emit("reply",new JSONObject().put("id",id).put("data",data == null ? JSONObject.NULL : data).put("error",error == null ? JSONObject.NULL : Ui.translate(this,error))); }
        catch(Exception ignored) {}
    }
    private JSONObject state() throws Exception {
        JSONObject c = new JSONObject(store.config().toString()); c.put("hasKey",!c.optString("key").isEmpty());c.remove("key");c.put("hasTunnelToken",!c.optString("tunnelToken").isEmpty());c.remove("tunnelToken");
        JSONObject s = new JSONObject().put("config",c).put("preferences",store.preferences()).put("accounts",store.listAccounts()).put("running",store.isRunning()).put("tunnel",store.tunnelState());
        File stats=new File(store.root,"message-stats.json");
        if(stats.exists())try{s.put("totalMessages",new JSONObject(new String(java.nio.file.Files.readAllBytes(stats.toPath()),StandardCharsets.UTF_8)).optLong("totalMessages"));}catch(Exception ignored){}
        if (store.isRunning()) {
            try { s.put("health",new JSONObject(http("GET","/health",null,2000))); }
            catch(Exception e) { s.put("starting",true); }
        }
        File error = new File(store.root,"last-error.txt");
        if (error.exists()) s.put("lastError",new String(java.nio.file.Files.readAllBytes(error.toPath()),StandardCharsets.UTF_8));
        PowerManager pm = (PowerManager)getSystemService(POWER_SERVICE);
        s.put("batteryExempt",pm.isIgnoringBatteryOptimizations(getPackageName()));
        JSONArray ips = new JSONArray();
        try {
            for (NetworkInterface n : Collections.list(NetworkInterface.getNetworkInterfaces()))
                for (InetAddress ip : Collections.list(n.getInetAddresses()))
                    if (ip instanceof Inet4Address && !ip.isLoopbackAddress()) ips.put(ip.getHostAddress());
        } catch(Exception ignored) {}
        return s.put("addresses",ips);
    }
    private HttpURLConnection connection(String method, String endpoint, String body, int timeout) throws Exception {
        JSONObject c = store.config();
        HttpURLConnection conn = (HttpURLConnection)new URL("http://127.0.0.1:"+c.getInt("port")+endpoint).openConnection();
        conn.setConnectTimeout(2500); conn.setReadTimeout(timeout); conn.setRequestMethod(method);
        if(!c.optString("key").isEmpty())conn.setRequestProperty("Authorization","Bearer "+c.getString("key"));
        if (body != null) {
            conn.setRequestProperty("Content-Type","application/json"); conn.setDoOutput(true);
            try(OutputStream out = conn.getOutputStream()) { out.write(body.getBytes(StandardCharsets.UTF_8)); }
        }
        return conn;
    }
    private static byte[] readLimit(InputStream in, int limit) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream(); byte[] buffer = new byte[8192]; int n;
        while((n=in.read(buffer))!=-1) { if (out.size()+n>limit) throw new IOException("Файл или ответ слишком большой."); out.write(buffer,0,n); }
        return out.toByteArray();
    }
    private String http(String method, String endpoint, String body, int timeout) throws Exception {
        HttpURLConnection c = connection(method,endpoint,body,timeout);
        try {
            int code = c.getResponseCode();
            InputStream input = code>=400 ? c.getErrorStream() : c.getInputStream();
            String text;
            try(InputStream in = input) { text = in==null ? "" : new String(readLimit(in,2*1024*1024),StandardCharsets.UTF_8); }
            if(code>=400) throw new IOException("HTTP "+code+": "+text);
            return text;
        } finally { c.disconnect(); }
    }
    final class Bridge {
        @JavascriptInterface public void call(String raw) {
            worker.execute(() -> {
                String id="";
                try {
                    JSONObject request = new JSONObject(raw); id=request.getString("id");
                    String action=request.getString("action"); JSONObject p=request.optJSONObject("params");
                    if(p==null) p=new JSONObject();
                    Object data=true;
                    switch(action) {
                        case "state": data=state(); break;
                        case "savePreferences":
                            data=store.savePreferences(p);
                            runOnUiThread(()->{Ui.applyWindow(MainActivity.this);web.setBackgroundColor(Ui.background(MainActivity.this));});
                            if(store.isRunning())startService(new Intent(MainActivity.this,ProxyService.class).setAction(ProxyService.REFRESH));
                            break;
                        case "start":
                            if(store.listAccounts().length()==0) throw new Exception("Добавьте аккаунт DeepSeek во вкладке «Аккаунты».");
                            new File(store.root,"last-error.txt").delete();
                            runOnUiThread(() -> {
                                if(Build.VERSION.SDK_INT>=33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED)
                                    requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},44);
                                startForegroundService(new Intent(MainActivity.this,ProxyService.class));
                            }); break;
                        case "stop":
                            if(store.isRunning()) startService(new Intent(MainActivity.this,ProxyService.class).setAction(ProxyService.STOP)); break;
                        case "saveConfig": store.saveConfig(p); break;
                        case "startTunnel":
                            if(!store.isRunning())throw new Exception(Ui.text(MainActivity.this,"Start the API server first.","Сначала запустите API-сервер."));
                            if(!store.config().optBoolean("publicEnabled"))throw new Exception(Ui.text(MainActivity.this,"Enable public API in Settings, save, and restart the server.","Включите публичный API в настройках, сохраните и перезапустите сервер."));
                            startService(new Intent(MainActivity.this,ProxyService.class).setAction(ProxyService.START_TUNNEL));break;
                        case "stopTunnel":
                            if(store.isRunning())startService(new Intent(MainActivity.this,ProxyService.class).setAction(ProxyService.STOP_TUNNEL));break;
                        case "importAccount": store.addAccount(p.getString("raw"),p.optString("token"),p.optString("name")); break;
                        case "deleteAccount": store.deleteAccount(p.getString("id")); break;
                        case "login": store.ensureStopped(); runOnUiThread(() -> startActivity(new Intent(MainActivity.this,AuthActivity.class))); break;
                        case "pickAccount": store.ensureStopped(); runOnUiThread(() -> startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE),11)); break;
                        case "pickImage": runOnUiThread(() -> startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("image/*").addCategory(Intent.CATEGORY_OPENABLE),12)); break;
                        case "models": data=new JSONObject(http("GET","/v1/models",null,3000)); break;
                        case "capabilities": data=new JSONObject(http("GET","/v1/model-capabilities",null,3000)); break;
                        case "sessions": data=new JSONObject(http("GET","/v1/sessions",null,3000)); break;
                        case "reset": data=new JSONObject(http("POST","/reset-session?agent="+URLEncoder.encode(p.optString("agent","all"),"UTF-8"),"{}",3000)); break;
                        case "logs": data=store.logs(); break;
                        case "clearLogs": Store.write(new File(store.root,"proxy.log"),"");Store.write(new File(store.root,"tunnel.log"),"");break;
                        case "exportLogs": runOnUiThread(() -> startActivityForResult(new Intent(Intent.ACTION_CREATE_DOCUMENT).setType("text/plain").putExtra(Intent.EXTRA_TITLE,"deepseek-pocket.log").addCategory(Intent.CATEGORY_OPENABLE),13)); break;
                        case "battery": runOnUiThread(() -> {
                            try { startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,Uri.parse("package:"+getPackageName()))); }
                            catch(Exception e) { startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)); }
                        }); break;
                        case "copy":
                            String value=p.optString("value");
                            if("key".equals(p.optString("kind"))) value=store.config().getString("key");
                            final String copied=value;
                            runOnUiThread(() -> ((android.content.ClipboardManager)getSystemService(CLIPBOARD_SERVICE)).setPrimaryClip(ClipData.newPlainText("DeepSeek Pocket",copied))); break;
                        case "chat": stream(id,p); return;
                        case "cancel": if(chat!=null) chat.disconnect(); break;
                        case "diagnose":
                            JSONObject d=new JSONObject().put("accounts",store.listAccounts().length()).put("service",store.isRunning());
                            try { d.put("health",new JSONObject(http("GET","/health",null,2500))); d.put("ready",new JSONObject(http("GET","/readyz",null,2500))); }
                            catch(Exception e) { d.put("error",e.getMessage()); }
                            data=d; break;
                        default: throw new Exception("Неизвестная команда.");
                    }
                    reply(id,data,null);
                } catch(Exception e) { reply(id,null,e.getMessage()==null ? e.getClass().getSimpleName() : e.getMessage()); }
            });
        }
    }
    private void stream(String id, JSONObject p) throws Exception {
        if(chat!=null) throw new Exception("Дождитесь ответа или остановите текущую генерацию.");
        String user=p.optString("user","pocket-playground");
        if(!user.matches("pocket-playground-[a-z0-9-]{1,64}")) user="pocket-playground";
        p.put("stream",true).put("user",user);
        HttpURLConnection c=connection("POST","/v1/chat/completions",p.toString(),700000); chat=c;
        try {
            int code=c.getResponseCode();
            if(code>=400) {
                try(InputStream in=c.getErrorStream()) { throw new IOException("HTTP "+code+": "+(in==null?"":new String(readLimit(in,64000),StandardCharsets.UTF_8))); }
            }
            try(BufferedReader reader=new BufferedReader(new InputStreamReader(c.getInputStream(),StandardCharsets.UTF_8))) {
                String line;
                while((line=reader.readLine())!=null) {
                    if(!line.startsWith("data: ")) continue;
                    String event=line.substring(6); if(event.equals("[DONE]")) break;
                    JSONObject json=new JSONObject(event);
                    emit("chunk",new JSONObject().put("id",id).put("chunk",json));
                }
            }
            reply(id,true,null);
        } finally { c.disconnect(); chat=null; }
    }
    @Override protected void onActivityResult(int requestCode,int result,Intent data) {
        super.onActivityResult(requestCode,result,data);
        if(result!=RESULT_OK || data==null || data.getData()==null) return;
        Uri uri=data.getData();
        worker.execute(() -> {
            try {
                if(requestCode==13) {
                    try(OutputStream out=getContentResolver().openOutputStream(uri)) { out.write(store.logs().getBytes(StandardCharsets.UTF_8)); }
                    emit("toast",Ui.translate(this,"Журнал сохранён")); return;
                }
                byte[] bytes;
                try(InputStream in=getContentResolver().openInputStream(uri)) { bytes=readLimit(in,requestCode==12?7*1024*1024:1024*1024); }
                if(requestCode==11) emit("import",new String(bytes,StandardCharsets.UTF_8));
                else if(requestCode==12) {
                    String mime=getContentResolver().getType(uri);
                    if(mime==null || !mime.matches("image/(png|jpeg|webp|gif)")) throw new Exception("Выберите PNG, JPEG, WebP или GIF.");
                    emit("image","data:"+mime+";base64,"+android.util.Base64.encodeToString(bytes,android.util.Base64.NO_WRAP));
                }
            } catch(Exception e) { emit("toast",Ui.translate(this,e.getMessage())); }
        });
    }
    @Override protected void onResume() { super.onResume(); if(web!=null) emit("resume",true); }
    @Override public void onBackPressed() { if(web!=null) web.evaluateJavascript("window.handleBack&&window.handleBack()",null); }
    @Override protected void onDestroy() { destroyed=true; if(chat!=null) chat.disconnect(); worker.shutdownNow(); web.removeJavascriptInterface("Pocket"); web.destroy(); super.onDestroy(); }
}
