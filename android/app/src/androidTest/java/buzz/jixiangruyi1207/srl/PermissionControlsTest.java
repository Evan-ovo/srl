package buzz.jixiangruyi1207.srl;

import static org.junit.Assert.*;
import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.io.*;
import java.lang.reflect.*;
import java.net.*;
import java.util.Map;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Run only on the explicitly selected isolated emulator. No external network or real installer. */
@RunWith(AndroidJUnit4.class)
public class PermissionControlsTest {
    private final Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    private ApkUpdaterPlugin plugin() { return new ApkUpdaterPlugin() { @Override public Context getContext() { return context; } }; }
    private Object download() throws Exception {
        Constructor<?> constructor = Class.forName(ApkUpdaterPlugin.class.getName() + "$Download").getDeclaredConstructor();
        constructor.setAccessible(true); return constructor.newInstance();
    }
    @SuppressWarnings("unchecked") private Map<String,Object> downloads(ApkUpdaterPlugin plugin) throws Exception {
        Field field = ApkUpdaterPlugin.class.getDeclaredField("downloads"); field.setAccessible(true); return (Map<String,Object>)field.get(plugin);
    }
    private JSObject cancel(ApkUpdaterPlugin plugin, String id) {
        AtomicReference<JSObject> result = new AtomicReference<>();
        JSObject data = new JSObject(); data.put("taskId", id);
        plugin.cancelDownload(new PluginCall(null,"ApkUpdater","test","cancelDownload",data) {
            @Override public void resolve(JSObject value) { result.set(value); }
        });
        return result.get();
    }
    @Test public void cancellationIsScopedAndCannotInterruptInstallerCommit() throws Exception {
        ApkUpdaterPlugin plugin = plugin(); Object first=download(), second=download();
        downloads(plugin).put("first",first); downloads(plugin).put("second",second);
        assertEquals("cancelled",cancel(plugin,"first").getString("status"));
        Field cancelled=first.getClass().getDeclaredField("cancelled"); cancelled.setAccessible(true);
        assertTrue(cancelled.getBoolean(first)); assertFalse(cancelled.getBoolean(second));
        Field committing=second.getClass().getDeclaredField("committing"); committing.setAccessible(true); committing.setBoolean(second,true);
        assertEquals("committing",cancel(plugin,"second").getString("status"));
        assertFalse(cancelled.getBoolean(second));
        assertEquals("missing",cancel(plugin,"absent").getString("status"));
    }
    @Test public void realHttpDownloadStopsAndRemovesPartialFileAfterCancel() throws Exception {
        ApkUpdaterPlugin plugin=plugin(); Object download=download(); String id="permission-device-cancel";
        downloads(plugin).put(id,download);
        ExecutorService executor=Executors.newFixedThreadPool(2);
        ServerSocket server=new ServerSocket(0,1,InetAddress.getByName("127.0.0.1"));
        CountDownLatch release=new CountDownLatch(1);
        Future<?> peer=executor.submit(() -> {
            try(Socket socket=server.accept()) {
                BufferedReader request=new BufferedReader(new InputStreamReader(socket.getInputStream()));
                String line; while((line=request.readLine())!=null && !line.isEmpty()) {}
                OutputStream out=socket.getOutputStream();
                out.write("HTTP/1.1 200 OK\r\nContent-Length: 1048576\r\nConnection: close\r\n\r\n".getBytes("US-ASCII"));
                out.write(new byte[65536]); out.flush(); release.await(10,TimeUnit.SECONDS);
            } catch(Exception error) { throw new RuntimeException(error); }
        });
        File partial=new File(context.getCacheDir(),"apk-updates/srl-update-"+id+".apk.part");
        File finalFile=new File(context.getCacheDir(),"apk-updates/srl-update-"+id+".apk");
        Method read=ApkUpdaterPlugin.class.getDeclaredMethod("downloadVerifiedApk",String.class,String.class,download.getClass(),String.class); read.setAccessible(true);
        Future<?> transfer=executor.submit(() -> {
            try { read.invoke(plugin,"http://127.0.0.1:"+server.getLocalPort()+"/fixture","0".repeat(64),download,id); throw new AssertionError("Cancelled transfer completed"); }
            catch(InvocationTargetException error) { assertTrue(error.getCause().getMessage().contains("取消") || ((Boolean)readCancelled(download))); }
            catch(Exception error) { throw new RuntimeException(error); }
        });
        try {
            long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(8);
            while(partial.length()==0 && !transfer.isDone() && System.nanoTime()<deadline) Thread.sleep(20);
            if (transfer.isDone()) transfer.get();
            assertTrue("actual native HTTP bytes must arrive before cancellation",partial.length()>0);
            assertEquals("cancelled",cancel(plugin,id).getString("status"));
            release.countDown(); transfer.get(8,TimeUnit.SECONDS); peer.get(8,TimeUnit.SECONDS);
            assertFalse(partial.exists()); assertFalse(finalFile.exists());
        } finally { release.countDown();server.close();executor.shutdownNow();partial.delete();finalFile.delete(); }
    }
    private static final class Reply extends PluginCall {
        final CountDownLatch completed = new CountDownLatch(1);
        JSObject value; String error;
        Reply(String method, JSObject data) { super(null,"NativeSafBackup","audit",method,data); }
        @Override public void resolve(JSObject result) { value=result; completed.countDown(); }
        @Override public void resolve() { completed.countDown(); }
        @Override public void reject(String message, Exception exception) { error=message; completed.countDown(); }
        @Override public void reject(String message) { error=message; completed.countDown(); }
        void waitForResult() throws Exception { assertTrue("native operation did not settle",completed.await(5,TimeUnit.SECONDS)); }
    }
    private NativeSafBackupPlugin backupPlugin() { return new NativeSafBackupPlugin() { @Override public Context getContext() { return context; } }; }
    @Test public void revocationDiscardsPendingWriteAndRejectsLateChunks() throws Exception {
        NativeSafBackupPlugin plugin=backupPlugin();
        Reply initial=new Reply("clearDirectory",new JSObject()); plugin.clearDirectory(initial); initial.waitForResult(); assertNull(initial.error);
        File file=File.createTempFile("permission-pending-", ".zip.part",context.getCacheDir());
        FileOutputStream stream=new FileOutputStream(file);stream.write(new byte[]{1,2,3});
        Class<?> type=Class.forName(NativeSafBackupPlugin.class.getName()+"$PendingWrite");
        Constructor<?> constructor=type.getDeclaredConstructor(androidx.documentfile.provider.DocumentFile.class,OutputStream.class); constructor.setAccessible(true);
        Object write=constructor.newInstance(androidx.documentfile.provider.DocumentFile.fromFile(file),stream);
        Field field=NativeSafBackupPlugin.class.getDeclaredField("pendingWrites");field.setAccessible(true);
        @SuppressWarnings("unchecked") Map<String,Object> pending=(Map<String,Object>)field.get(plugin);pending.put("old-write",write);
        Reply clear=new Reply("clearDirectory",new JSObject());plugin.clearDirectory(clear);clear.waitForResult();
        assertNull(clear.error);assertFalse(file.exists());assertTrue(pending.isEmpty());assertFalse(clear.value.getBoolean("configured"));
        JSObject data=new JSObject();data.put("token","old-write");data.put("data","AAAA");
        Reply late=new Reply("appendWrite",data);plugin.appendWrite(late);late.waitForResult();assertNotNull(late.error);assertFalse(file.exists());
    }
    @Test public void oldDirectoryPickerResultCannotRestoreClearedAuthorization() throws Exception {
        NativeSafBackupPlugin plugin=backupPlugin();
        JSObject data=new JSObject();data.put("directoryGeneration",0);
        Reply stale=new Reply("chooseDirectory",data);
        Reply clear=new Reply("clearDirectory",new JSObject());plugin.clearDirectory(clear);clear.waitForResult();assertNull(clear.error);
        android.content.Intent intent=new android.content.Intent();intent.setData(android.net.Uri.parse("content://com.android.externalstorage.documents/tree/primary%3ADocuments"));
        intent.setFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION|android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        Method selected=NativeSafBackupPlugin.class.getDeclaredMethod("directorySelected",PluginCall.class,androidx.activity.result.ActivityResult.class);selected.setAccessible(true);
        selected.invoke(plugin,stale,new androidx.activity.result.ActivityResult(android.app.Activity.RESULT_OK,intent));
        stale.waitForResult();assertNull(stale.error);assertFalse(stale.value.getBoolean("configured"));
    }
    private boolean readCancelled(Object download) {
        try { Field field=download.getClass().getDeclaredField("cancelled");field.setAccessible(true);return field.getBoolean(download); }
        catch(Exception error) { throw new RuntimeException(error); }
    }
}
