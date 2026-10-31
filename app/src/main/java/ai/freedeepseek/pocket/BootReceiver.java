package ai.freedeepseek.pocket;
import android.content.*;
public class BootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context c, Intent i) {
        if (!Intent.ACTION_BOOT_COMPLETED.equals(i.getAction())) return;
        try {
            Store s = new Store(c);
            if (s.config().optBoolean("autoStart") && s.listAccounts().length()>0)
                c.startForegroundService(new Intent(c,ProxyService.class));
        } catch (Exception ignored) {}
    }
}
