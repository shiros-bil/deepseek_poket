package ai.freedeepseek.pocket;

import android.app.ActivityManager;
import android.content.Context;
import android.system.Os;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.*;

final class Store {
    static final String WASM = "https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm";
    final Context context;
    final File root, accounts;
    Store(Context context) {
        this.context = context.getApplicationContext();
        root = context.getFilesDir();
        accounts = new File(root, "accounts");
        accounts.mkdirs();
    }
    synchronized JSONObject preferences() throws Exception {
        File file=new File(root,"ui-preferences.json");
        JSONObject p=file.exists()?new JSONObject(new String(Files.readAllBytes(file.toPath()),StandardCharsets.UTF_8)):new JSONObject();
        String language=p.optString("language","en"),theme=p.optString("theme","dark");
        return new JSONObject().put("language",language.equals("ru")?"ru":"en").put("theme",theme.equals("light")?"light":"dark");
    }
    synchronized JSONObject savePreferences(JSONObject input) throws Exception {
        String language=input.getString("language"),theme=input.getString("theme");
        if(!(language.equals("en")||language.equals("ru")) || !(theme.equals("dark")||theme.equals("light")))
            throw new Exception("Unsupported language or theme.");
        JSONObject p=new JSONObject().put("language",language).put("theme",theme);
        write(new File(root,"ui-preferences.json"),p.toString());
        return p;
    }
    synchronized JSONObject config() throws Exception {
        File file = new File(root, "config.json");
        if (file.exists()) {
            JSONObject saved=new JSONObject(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
            if(!saved.has("optionalKeyMigrated")){saved.put("key","").put("optionalKeyMigrated",true);write(file,saved.toString());}
            return saved;
        }
        JSONObject config = new JSONObject().put("port", 9655).put("lan", false)
            .put("key", "").put("optionalKeyMigrated",true).put("wakeLock", true).put("autoStart", false).put("envText", "")
            .put("sendFullHistory",false).put("newChatEachMessage",false)
            .put("publicEnabled",false).put("tunnelMode","quick").put("tunnelAllowAnyOrigin",true)
            .put("tunnelOrigins","").put("tunnelPublicUrl","").put("tunnelToken","");
        write(file, config.toString()); return config;
    }
    void ensureStopped() {
        if (isRunning()) throw new IllegalStateException("Сначала остановите сервер, затем измените настройки или аккаунты.");
    }
    JSONObject tunnelState() throws Exception {
        File file=new File(root,"tunnel-status.json");
        if(!isRunning()||!file.exists())return new JSONObject().put("state","stopped").put("url","");
        return new JSONObject(new String(Files.readAllBytes(file.toPath()),StandardCharsets.UTF_8));
    }
    boolean isRunning() {
        ActivityManager am = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
        for (ActivityManager.RunningServiceInfo s : am.getRunningServices(100))
            if (s.service.getClassName().equals(ProxyService.class.getName())) return true;
        return false;
    }
    void saveConfig(JSONObject input) throws Exception {
        ensureStopped();
        int port = input.getInt("port");
        if (port < 1024 || port > 65535) throw new Exception("Порт должен быть от 1024 до 65535.");
        String env = input.optString("envText", "");
        if (env.length() > 32000) throw new Exception("Слишком большой файл настроек.");
        for (String line : env.split("\n")) {
            line = line.trim();
            if (!line.isEmpty() && !line.startsWith("#") && !line.matches("DEEPSEEK_[A-Z0-9_]+\\s*=.*"))
                throw new Exception("Допустимы строки DEEPSEEK_ИМЯ=значение и комментарии #.");
        }
        JSONObject c = config();
        c.put("port", port).put("lan", input.optBoolean("lan"))
            .put("wakeLock", input.optBoolean("wakeLock", true))
            .put("autoStart", input.optBoolean("autoStart"))
            .put("envText", env)
            .put("sendFullHistory",input.optBoolean("sendFullHistory"))
            .put("newChatEachMessage",input.optBoolean("sendFullHistory")&&input.optBoolean("newChatEachMessage"));
        String key = input.optString("key", "").trim();
        if(input.optBoolean("clearKey"))c.put("key","");
        if (!key.isEmpty()) {
            if (key.length() < 24 || !key.matches("[A-Za-z0-9_.-]+")) throw new Exception("Ключ: минимум 24 латинских символа, цифры, точка, - или _.");
            c.put("key", key);
        }
        boolean publicEnabled=input.optBoolean("publicEnabled");
        String mode=input.optString("tunnelMode","quick");
        if(!mode.equals("quick")&&!mode.equals("named"))throw new Exception(Ui.text(context,"Choose a valid tunnel mode.","Выберите корректный режим туннеля."));
        String token=input.optString("tunnelToken","").trim();
        if(input.optBoolean("clearTunnelToken"))c.put("tunnelToken","");
        if(!token.isEmpty()){
            if(!token.matches("[A-Za-z0-9_+/=-]{40,8192}"))throw new Exception(Ui.text(context,"Paste only the Cloudflare Tunnel token.","Вставьте только токен Cloudflare Tunnel."));
            c.put("tunnelToken",token);
        }
        String publicUrl=input.optString("tunnelPublicUrl","").trim().replaceFirst("/+$","");
        if(!publicUrl.isEmpty()){
            java.net.URI uri=new java.net.URI(publicUrl);
            if(!"https".equals(uri.getScheme())||uri.getHost()==null||uri.getUserInfo()!=null||uri.getQuery()!=null||uri.getFragment()!=null||!uri.getPath().isEmpty())
                throw new Exception(Ui.text(context,"Public URL must be an HTTPS hostname without a path.","Публичный URL должен быть HTTPS-адресом без пути."));
        }
        String origins=input.optString("tunnelOrigins","").trim();
        if(origins.length()>4096)throw new Exception("Too many website origins.");
        ArrayList<String> normalized=new ArrayList<>();
        for(String origin:origins.split("[,\\s]+")){
            if(origin.isEmpty())continue;java.net.URI uri=new java.net.URI(origin);
            if(!("https".equals(uri.getScheme())||"http".equals(uri.getScheme()))||uri.getHost()==null||uri.getUserInfo()!=null||uri.getQuery()!=null||uri.getFragment()!=null||!(uri.getPath().isEmpty()||uri.getPath().equals("/")))
                throw new Exception(Ui.text(context,"Enter exact website origins, for example https://example.com.","Укажите адреса сайтов без пути, например https://example.com."));
            normalized.add(uri.getScheme()+"://"+uri.getRawAuthority());
        }
        if(publicEnabled&&mode.equals("named")&&(c.optString("tunnelToken").isEmpty()||publicUrl.isEmpty()))
            throw new Exception(Ui.text(context,"Named mode requires a tunnel token and its public HTTPS hostname.","Для постоянного туннеля нужны токен и его публичный HTTPS-адрес."));
        c.put("publicEnabled",publicEnabled).put("tunnelMode",mode).put("tunnelPublicUrl",publicUrl)
            .put("tunnelAllowAnyOrigin",input.optBoolean("tunnelAllowAnyOrigin",true)).put("tunnelOrigins",String.join(",",normalized));
        write(new File(root, "config.json"), c.toString());
    }
    JSONArray listAccounts() throws Exception {
        JSONArray list = new JSONArray();
        File[] files = accounts.listFiles((d,n) -> n.endsWith(".json"));
        if (files == null) return list;
        Arrays.sort(files, Comparator.comparing(File::getName));
        for (File file : files) {
            JSONObject a = new JSONObject(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
            list.put(new JSONObject().put("id", file.getName()).put("name", a.optString("_label", "DeepSeek"))
                .put("ready", !a.optString("token").isEmpty() && !a.optString("cookie").isEmpty()));
        }
        return list;
    }
    void addAccount(String raw, String extraToken, String label) throws Exception {
        ensureStopped();
        Object input = new JSONTokener(raw).nextValue();
        JSONObject obj = input instanceof JSONObject ? (JSONObject)input : new JSONObject();
        String token = "";
        for (String key : new String[]{"token", "access_token", "accessToken", "auth_token"}) {
            if (!obj.optString(key).trim().isEmpty()) { token = obj.optString(key); break; }
        }
        if (token.trim().isEmpty()) token = extraToken;
        token = token.trim().replaceFirst("(?i)^Bearer\\s+", "");
        String cookie = obj.optString("cookie", "");
        Object cookies = input instanceof JSONArray ? input : obj.opt("cookies");
        if (cookies instanceof String) cookie = ((String)cookies).trim();
        if (cookies instanceof JSONArray) {
            ArrayList<String> parts = new ArrayList<>();
            JSONArray array = (JSONArray)cookies;
            for (int i=0;i<array.length();i++) {
                JSONObject c = array.optJSONObject(i); if (c == null) continue;
                String domain = c.optString("domain").toLowerCase(Locale.ROOT);
                if ((domain.equals("deepseek.com") || domain.endsWith(".deepseek.com")) && !c.optString("name").trim().isEmpty())
                    parts.add(c.optString("name") + "=" + c.optString("value"));
            }
            cookie = String.join("; ", parts);
        }
        if (token.trim().isEmpty() || cookie.trim().isEmpty()) throw new Exception("Нужны token и cookie. Для cookies.json укажите токен в отдельном поле.");
        JSONObject auth = new JSONObject().put("token", token).put("cookie", cookie)
            .put("hif_dliq", obj.optString("hif_dliq", obj.optString("x-hif-dliq")))
            .put("hif_leim", obj.optString("hif_leim", obj.optString("x-hif-leim")))
            .put("wasmUrl", obj.optString("wasmUrl", obj.optString("wasm_url", WASM)))
            .put("_label", label.trim().isEmpty() ? Ui.text(context,"Account ","Аккаунт ") + (listAccounts().length()+1) : label.substring(0, Math.min(60,label.length())));
        String wasm = auth.getString("wasmUrl");
        if (!wasm.startsWith("https://")) throw new Exception("wasmUrl должен начинаться с https://.");
        write(new File(accounts, UUID.randomUUID()+".json"), auth.toString());
    }
    void deleteAccount(String id) throws Exception {
        ensureStopped();
        if (!id.matches("[a-f0-9-]{36}\\.json")) throw new Exception("Неизвестный аккаунт.");
        if (!new File(accounts,id).delete()) throw new Exception("Не удалось удалить аккаунт.");
    }
    static void write(File file, String value) throws Exception {
        file.getParentFile().mkdirs();
        File tmp = new File(file.getPath()+".tmp");
        Files.write(tmp.toPath(), value.getBytes(StandardCharsets.UTF_8));
        Os.chmod(tmp.getPath(), 0600);
        if (!tmp.renameTo(file)) throw new IOException("Не удалось сохранить файл.");
    }
    String logs() throws Exception {
        String api=readLog(new File(root,"proxy.log")),tunnel=readLog(new File(root,"tunnel.log"));
        if(api.isEmpty()&&tunnel.isEmpty())return Ui.translate(context,"Журнал пока пуст.");
        return "API\n"+api+(tunnel.isEmpty()?"":"\n\nCLOUDFLARE\n"+tunnel);
    }
    private String readLog(File log) throws Exception {
        if (!log.exists()) return "";
        try (RandomAccessFile f = new RandomAccessFile(log,"r")) {
            f.seek(Math.max(0, f.length()-64000));
            byte[] bytes = new byte[(int)(f.length()-f.getFilePointer())]; f.readFully(bytes);
            return new String(bytes, StandardCharsets.UTF_8);
        }
    }
}
