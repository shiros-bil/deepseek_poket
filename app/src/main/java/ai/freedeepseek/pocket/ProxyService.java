package ai.freedeepseek.pocket;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.*;
import java.io.*;

public class ProxyService extends Service {
    static final String STOP = "ai.freedeepseek.pocket.STOP";
    static final String REFRESH = "ai.freedeepseek.pocket.REFRESH";
    static final String START_TUNNEL="ai.freedeepseek.pocket.START_TUNNEL";
    static final String STOP_TUNNEL="ai.freedeepseek.pocket.STOP_TUNNEL";
    private boolean started;
    private boolean stopping;
    private TunnelManager tunnel;
    private PowerManager.WakeLock wake;
    private WifiManager.WifiLock wifi;
    private native int startNode(String script, String directory);
    @Override public IBinder onBind(Intent intent) { return null; }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && STOP.equals(intent.getAction())) { shutdown(); return START_NOT_STICKY; }
        if(intent!=null&&(START_TUNNEL.equals(intent.getAction())||STOP_TUNNEL.equals(intent.getAction()))){
            if(started&&tunnel!=null){if(START_TUNNEL.equals(intent.getAction()))tunnel.start();else tunnel.stop();}else stopSelf();
            return started?START_STICKY:START_NOT_STICKY;
        }
        if(intent!=null && REFRESH.equals(intent.getAction())){
            if(started)getSystemService(NotificationManager.class).notify(7,notification());else stopSelf();
            return started?START_STICKY:START_NOT_STICKY;
        }
        if (started) return START_STICKY;
        started = true;
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel("proxy",Ui.text(this,"Local API","Локальный API"),NotificationManager.IMPORTANCE_LOW));
        Notification notification=notification();
        if (Build.VERSION.SDK_INT >= 34) startForeground(7,notification,ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(7,notification);
        tunnel=new TunnelManager(this,()->{if(started&&!stopping)getSystemService(NotificationManager.class).notify(7,notification());});
        new Thread(() -> {
            Store store = new Store(this);
            try {
                if (store.config().optBoolean("wakeLock",true)) {
                    wake = ((PowerManager)getSystemService(POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,getPackageName()+":api");
                    wake.acquire();
                    WifiManager wm = (WifiManager)getApplicationContext().getSystemService(WIFI_SERVICE);
                    wifi = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF,"DeepSeekPocket"); wifi.acquire();
                }
                copyAssets("engine", new File(store.root,"engine"));
                if(store.config().optBoolean("publicEnabled"))tunnel.start();
                System.loadLibrary("node"); System.loadLibrary("pocket");
                int result = startNode(new File(store.root,"engine/bootstrap.js").getAbsolutePath(),store.root.getAbsolutePath());
                Store.write(new File(store.root,"last-error.txt"),"Node завершился с кодом "+result);
            } catch (Throwable error) {
                try { Store.write(new File(store.root,"last-error.txt"),error.toString()); } catch(Exception ignored) {}
            }
            new Handler(Looper.getMainLooper()).post(this::shutdown);
        },"DeepSeek-Node").start();
        return START_STICKY;
    }
    private Notification notification(){
        PendingIntent open=PendingIntent.getActivity(this,0,new Intent(this,MainActivity.class),PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent stop=PendingIntent.getService(this,1,new Intent(this,ProxyService.class).setAction(STOP),PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);
        String detail=Ui.text(this,"Local API is active in the background. Tap to open.","Локальный сервер активен в фоне. Нажмите, чтобы открыть.");
        try{org.json.JSONObject status=new Store(this).tunnelState();if(status.optString("state").equals("connected"))detail=status.getString("url");}catch(Exception ignored){}
        return new Notification.Builder(this,"proxy").setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(Ui.text(this,"DeepSeek Pocket · API is running","DeepSeek Pocket · API работает"))
            .setContentText(detail)
            .setContentIntent(open).setOngoing(true).setCategory(Notification.CATEGORY_SERVICE)
            .addAction(new Notification.Action.Builder(null,Ui.text(this,"Stop","Остановить"),stop).build()).build();
    }
    private void copyAssets(String path, File dest) throws IOException {
        String[] children = getAssets().list(path);
        if (children != null && children.length > 0) {
            dest.mkdirs(); for (String child : children) copyAssets(path+"/"+child,new File(dest,child));
        } else {
            dest.getParentFile().mkdirs();
            try (InputStream in = getAssets().open(path); OutputStream out = new FileOutputStream(dest)) {
                byte[] buffer=new byte[16384]; int n; while((n=in.read(buffer))!=-1) out.write(buffer,0,n);
            }
        }
    }
    private void releaseLocks() {
        if (wake != null && wake.isHeld()) wake.release();
        if (wifi != null && wifi.isHeld()) wifi.release();
    }
    private void shutdown() {
        stopping=true;if(tunnel!=null)tunnel.stop();
        releaseLocks(); stopForeground(STOP_FOREGROUND_REMOVE); stopSelf();
        new Handler(Looper.getMainLooper()).postDelayed(() -> android.os.Process.killProcess(android.os.Process.myPid()),150);
    }
    @Override public void onDestroy() { stopping=true;started=false;if(tunnel!=null)tunnel.stop();releaseLocks();super.onDestroy(); }
}
