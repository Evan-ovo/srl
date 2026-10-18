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
import org.junit.Test;
import org.junit.runner.RunWith;

/** Run only on the explicitly selected isolated emulator. No external network or real installer. */
@RunWith(AndroidJUnit4.class)
public class PermissionControlsTest {
    private final Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
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
