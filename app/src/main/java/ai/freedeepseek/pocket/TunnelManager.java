package ai.freedeepseek.pocket;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.regex.*;

 final class TunnelManager {
    private final Context context;
    private final Store store;
    private final Runnable changed;
    private volatile boolean desired;
    private volatile Process child;
    private volatile long generation;
    private volatile String publicUrl="",lastError="";
    private String lastSnapshot="";
    private static final Pattern QUICK_URL=Pattern.compile("https://[a-z0-9-]+\\.trycloudflare\\.com");

    TunnelManager(Context context,Runnable changed){this.context=context;this.store=new Store(context);this.changed=changed;}
    synchronized void start(){
        if(desired)return;desired=true;long epoch=++generation;
        Thread thread=new Thread(()->supervise(epoch),"Cloudflare-Supervisor");thread.setDaemon(true);thread.start();
    }
    synchronized void stop(){
        desired=false;generation++;Process current=child;child=null;
        if(current!=null){current.destroy();if(current.isAlive())current.destroyForcibly();}
        publicUrl="";lastSnapshot="";
        try{Store.write(new File(store.root,"tunnel-status.json"),new JSONObject().put("state","stopped").put("url","").toString());}catch(Exception ignored){}
        changed.run();
    }
    private boolean active(long epoch){return desired&&generation==epoch;}
    private synchronized void publish(long epoch,String state,String mode,String error){
        if(!active(epoch))return;
        String snapshot=state+"|"+mode+"|"+publicUrl+"|"+error;if(snapshot.equals(lastSnapshot))return;lastSnapshot=snapshot;
        try{Store.write(new File(store.root,"tunnel-status.json"),new JSONObject().put("state",state).put("mode",mode).put("url",publicUrl).put("error",error).put("updatedAt",System.currentTimeMillis()).toString());}catch(Exception ignored){}
        changed.run();
    }
    private boolean ready(int port){
        HttpURLConnection connection=null;
        try{connection=(HttpURLConnection)new URL("http://127.0.0.1:"+port+"/ready").openConnection();connection.setConnectTimeout(700);connection.setReadTimeout(900);return connection.getResponseCode()==200;}
        catch(Exception ignored){return false;}finally{if(connection!=null)connection.disconnect();}
    }
    private boolean proxyReady(int port){
        HttpURLConnection connection=null;
        try{connection=(HttpURLConnection)new URL("http://127.0.0.1:"+port+"/health").openConnection();connection.setConnectTimeout(500);connection.setReadTimeout(700);return connection.getResponseCode()==200;}
        catch(Exception ignored){return false;}finally{if(connection!=null)connection.disconnect();}
    }
    private String dnsServers(){
        ArrayList<String> servers=new ArrayList<>();
        try{ConnectivityManager cm=context.getSystemService(ConnectivityManager.class);LinkProperties properties=cm.getLinkProperties(cm.getActiveNetwork());if(properties!=null)for(InetAddress address:properties.getDnsServers())servers.add(address.getHostAddress());}catch(Exception ignored){}
        if(servers.isEmpty())servers.add("1.1.1.1");
        return String.join(",",servers);
    }
    private synchronized void log(String message,JSONObject config){
        try{
            String cleaned=message;
            for(String secret:new String[]{config.optString("tunnelToken"),config.optString("key")})if(!secret.isEmpty())cleaned=cleaned.replace(secret,"[REDACTED]");
            File file=new File(store.root,"tunnel.log");
            if(!file.exists())Store.write(file,"");
            if(file.length()>256*1024){try(RandomAccessFile in=new RandomAccessFile(file,"r")){in.seek(Math.max(0,in.length()-64000));byte[] tail=new byte[(int)(in.length()-in.getFilePointer())];in.readFully(tail);Store.write(file,new String(tail,StandardCharsets.UTF_8));}}
            try(FileOutputStream out=new FileOutputStream(file,true)){out.write((cleaned.substring(0,Math.min(4000,cleaned.length()))+"\n").getBytes(StandardCharsets.UTF_8));}
        }catch(Exception ignored){}
    }
    private void supervise(long epoch){
        int attempt=0;
        while(active(epoch)){
            Process process=null;
            String mode="quick";
            try{
                JSONObject config=store.config();mode=config.optString("tunnelMode","quick");
                if(!config.optBoolean("publicEnabled"))throw new IllegalStateException("Enable public API in Settings, save, and restart the server.");
                publicUrl=mode.equals("named")?config.optString("tunnelPublicUrl"):"";lastError="";
                publish(epoch,"waiting",mode,"");
                while(active(epoch)&&!proxyReady(config.getInt("port")))Thread.sleep(500);
                if(!active(epoch))return;
                int metricsPort;
                try(java.net.ServerSocket socket=new java.net.ServerSocket(0,1,InetAddress.getLoopbackAddress())){metricsPort=socket.getLocalPort();}
                File executable=new File(context.getApplicationInfo().nativeLibraryDir,"libcloudflared.so");
                if(!executable.canExecute())throw new IOException("The Cloudflare executable is missing for this device.");
                List<String> command=new ArrayList<>(Arrays.asList(executable.getAbsolutePath(),"tunnel","--no-autoupdate","--protocol","http2","--edge-ip-version","4","--ha-connections","1","--metrics","127.0.0.1:"+metricsPort,"--output","json"));
                if(mode.equals("named")){
                    String token=config.optString("tunnelToken");if(token.isEmpty())throw new IOException("A Cloudflare Tunnel token is required.");
                    File tokenFile=new File(store.root,"cloudflare-token.txt");Store.write(tokenFile,token);
                    command.addAll(Arrays.asList("run","--token-file",tokenFile.getAbsolutePath()));
                }else command.addAll(Arrays.asList("--url","http://127.0.0.1:"+config.getInt("port")));
                ProcessBuilder builder=new ProcessBuilder(command).directory(store.root).redirectErrorStream(true);
                builder.environment().put("HOME",store.root.getAbsolutePath());builder.environment().put("TMPDIR",context.getCacheDir().getAbsolutePath());builder.environment().put("POCKET_DNS_SERVERS",dnsServers());
                publish(epoch,"connecting",mode,"");
                synchronized(this){if(!active(epoch))return;process=builder.start();child=process;}
                final Process running=process;final JSONObject snapshot=config;
                Thread reader=new Thread(()->{
                    try(BufferedReader lines=new BufferedReader(new InputStreamReader(running.getInputStream(),StandardCharsets.UTF_8))){String line;while((line=lines.readLine())!=null&&active(epoch)&&child==running){
                        log(line,snapshot);Matcher match=QUICK_URL.matcher(line);if(snapshot.optString("tunnelMode","quick").equals("quick")&&match.find()&&!match.group().equals("https://api.trycloudflare.com"))publicUrl=match.group();
                        try{JSONObject event=new JSONObject(line);if("error".equals(event.optString("level"))){String detail=event.optString("message",event.optString("error"));for(String secret:new String[]{snapshot.optString("tunnelToken"),snapshot.optString("key")})if(!secret.isEmpty())detail=detail.replace(secret,"[REDACTED]");lastError=detail;}}catch(Exception ignored){}
                    }}catch(IOException ignored){}
                },"Cloudflare-Output");reader.setDaemon(true);reader.start();
                int failures=0;
                while(active(epoch)&&running.isAlive()){
                    boolean connected=ready(metricsPort)&&!publicUrl.isEmpty();
                    if(connected){attempt=0;failures=0;publish(epoch,"connected",mode,"");}
                    else{failures++;publish(epoch,failures>3?"reconnecting":"connecting",mode,lastError);}
                    Thread.sleep(1500);
                }
                if(!active(epoch))return;
                lastError="cloudflared exited ("+running.exitValue()+"). "+lastError;
            }catch(Exception error){lastError=error.getMessage()==null?error.getClass().getSimpleName():error.getMessage();}
            finally{if(process!=null){process.destroy();if(process.isAlive())process.destroyForcibly();}synchronized(this){if(child==process)child=null;}}
            if(!active(epoch))return;
            publicUrl="";publish(epoch,"error",mode,lastError);attempt=Math.min(attempt+1,5);
            try{for(int i=0;i<(1<<attempt)&&active(epoch);i++)Thread.sleep(1000);}catch(InterruptedException interrupted){Thread.currentThread().interrupt();return;}
        }
    }
}
