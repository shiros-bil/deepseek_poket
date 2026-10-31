package ai.freedeepseek.pocket;

import android.app.*;
import android.content.*;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.*;
import android.widget.*;
import org.json.*;
import java.util.concurrent.ConcurrentHashMap;

public class AuthActivity extends Activity {
    private WebView browser;
    private TextView hint;
    private final ConcurrentHashMap<String,String> headers=new ConcurrentHashMap<>();
    private volatile String wasm=Store.WASM;
    private static boolean deepseek(Uri u) {
        String host=u.getHost(); return "https".equals(u.getScheme()) && host!=null && (host.equals("deepseek.com") || host.endsWith(".deepseek.com"));
    }
    @Override public void onCreate(Bundle state) {
        Ui.prepare(this);super.onCreate(state);Ui.applyWindow(this);
        LinearLayout layout=new LinearLayout(this); layout.setOrientation(LinearLayout.VERTICAL); layout.setBackgroundColor(Ui.background(this));
        LinearLayout bar=new LinearLayout(this); bar.setPadding(12,8,12,8);
        Button close=new Button(this); close.setText(Ui.text(this,"Back","Назад")); close.setOnClickListener(v -> finish()); bar.addView(close);
        Button save=new Button(this); save.setText(Ui.text(this,"Save sign-in","Сохранить вход")); save.setOnClickListener(v -> capture()); bar.addView(save,new LinearLayout.LayoutParams(0,-2,1)); layout.addView(bar);
        hint=new TextView(this); hint.setText(Ui.text(this,"Sign in to DeepSeek, send a short message, then tap ‘Save sign-in’.","Войдите в DeepSeek, отправьте короткое сообщение, затем нажмите «Сохранить вход».")); hint.setPadding(20,8,20,12); hint.setTextColor(Ui.foreground(this)); layout.addView(hint);
        browser=new WebView(this); browser.getSettings().setJavaScriptEnabled(true); browser.getSettings().setDomStorageEnabled(true);
        browser.getSettings().setAllowFileAccess(false); browser.getSettings().setAllowContentAccess(false);
        browser.getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        CookieManager.getInstance().setAcceptCookie(true);
        // No JavaScript bridge is exposed to the remote login page.
        browser.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v,WebResourceRequest r) {
                if(deepseek(r.getUrl())) return false;
                if("https".equals(r.getUrl().getScheme())) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW,r.getUrl())); } catch(Exception ignored) {}
                }
                return true;
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView v,WebResourceRequest r) {
                if(deepseek(r.getUrl())) {
                    r.getRequestHeaders().forEach((key,value) -> {
                        String k=key.toLowerCase(java.util.Locale.ROOT);
                        if(k.equals("authorization") || k.equals("x-hif-dliq") || k.equals("x-hif-leim")) headers.put(k,value);
                    });
                }
                if(r.getUrl().toString().matches("https://[^/]*deepseek\\.com/.*sha3.*\\.wasm(?:\\?.*)?")) wasm=r.getUrl().toString();
                return null;
            }
            @Override public void onPageFinished(WebView v,String url) {
                if(!deepseek(Uri.parse(url))) return;
                // Capture same-origin fetch headers after login, including headers
                // not surfaced by some WebView versions to shouldInterceptRequest.
                v.evaluateJavascript("(()=>{if(window.__pocketFetch)return;window.__pocketAuth={};window.__pocketFetch=window.fetch;window.fetch=function(input,init){try{const u=new URL(typeof input==='string'?input:input.url,location.href);if(u.hostname==='chat.deepseek.com'){const h=new Headers(init&&init.headers||(input&&input.headers)||{});for(const k of ['authorization','x-hif-dliq','x-hif-leim'])if(h.has(k))window.__pocketAuth[k]=h.get(k);}}catch(e){}return window.__pocketFetch.apply(this,arguments);};})()",null);
            }
        });
        layout.addView(browser,new LinearLayout.LayoutParams(-1,0,1)); setContentView(layout);
        browser.loadUrl("https://chat.deepseek.com");
    }
    private void capture() {
        if(browser.getUrl()==null || !deepseek(Uri.parse(browser.getUrl()))) { hint.setText(Ui.text(this,"Open chat.deepseek.com.","Откройте страницу chat.deepseek.com.")); return; }
        browser.evaluateJavascript("(()=>{const out={token:'',headers:window.__pocketAuth||{}};for(const s of [localStorage,sessionStorage]){for(const k of ['userToken','token','auth_token','access_token','accessToken']){let v=s.getItem(k);if(!v)continue;try{v=JSON.parse(v);if(typeof v==='object')v=v.value||v.token||v.access_token||v.accessToken||'';}catch(e){}if(v){out.token=String(v);break;}}if(out.token)break;}out.wasm=performance.getEntriesByType('resource').map(x=>x.name).find(x=>/sha3.*\\.wasm/.test(x))||'';return out;})()",result -> {
            try {
                JSONObject found=new JSONObject(result); JSONObject h=found.optJSONObject("headers");
                if(h!=null) for(String k:new String[]{"authorization","x-hif-dliq","x-hif-leim"}) if(!h.optString(k).isEmpty()) headers.put(k,h.getString(k));
                String token=found.optString("token"); if(token.isEmpty()) token=headers.getOrDefault("authorization","").replaceFirst("(?i)^Bearer\\s+", "");
                String cookies=CookieManager.getInstance().getCookie("https://chat.deepseek.com");
                if(token.isEmpty() || cookies==null || cookies.isEmpty()) { hint.setText(Ui.text(this,"No session found yet. Finish signing in and send a message. If WebView sign-in is unavailable, import deepseek-auth.json.","Сессия ещё не найдена. Завершите вход и отправьте сообщение. Если вход через WebView недоступен, импортируйте deepseek-auth.json.")); return; }
                String foundWasm=found.optString("wasm"); if(!foundWasm.isEmpty()) wasm=foundWasm;
                JSONObject auth=new JSONObject().put("token",token).put("cookie",cookies).put("wasmUrl",wasm)
                    .put("hif_dliq",headers.getOrDefault("x-hif-dliq", "")).put("hif_leim",headers.getOrDefault("x-hif-leim", ""));
                new Store(this).addAccount(auth.toString(),"",""); CookieManager.getInstance().flush();
                new AlertDialog.Builder(this).setTitle(Ui.text(this,"Account added","Аккаунт добавлен")).setMessage(Ui.text(this,"You can start the API. To add another account, sign out of DeepSeek on the sign-in page and sign in again.","Можно запустить API. Для ещё одного аккаунта выйдите из DeepSeek на странице входа и войдите заново."))
                    .setPositiveButton(Ui.text(this,"Done","Готово"),(d,w)->finish()).show();
            } catch(Exception e) { hint.setText(Ui.text(this,"Could not save: ","Не удалось сохранить: ")+Ui.translate(this,e.getMessage())); }
        });
    }
    @Override public void onBackPressed() { if(browser.canGoBack()) browser.goBack(); else super.onBackPressed(); }
    @Override protected void onDestroy() { browser.destroy(); super.onDestroy(); }
}
