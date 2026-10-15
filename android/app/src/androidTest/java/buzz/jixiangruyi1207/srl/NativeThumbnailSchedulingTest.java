package buzz.jixiangruyi1207.srl;

import static org.junit.Assert.*;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Debug;
import android.os.SystemClock;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Random;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Actual native decode/encode competes with a foreground database read; no simulated sleeps. */
@RunWith(AndroidJUnit4.class)
public class NativeThumbnailSchedulingTest {
    @Test public void preparesBackgroundCardWithoutReplacingTheFullPreview() throws Exception {
        Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();
        File picked=new File(context.getCacheDir(),"picked-images"); assertTrue(picked.mkdirs()||picked.isDirectory());
        File source=new File(picked,"background-thumbnail-"+UUID.randomUUID()+".png");
        Bitmap image=Bitmap.createBitmap(512,1024,Bitmap.Config.ARGB_8888);
        image.eraseColor(0xff375a9e);
        try(FileOutputStream output=new FileOutputStream(source)) { assertTrue(image.compress(Bitmap.CompressFormat.PNG,100,output)); }
        image.recycle(); String name="background-thumbnail-"+UUID.randomUUID();
        try(NativeAppDatabase database=new NativeAppDatabase(context,name)) {
            database.putState("migration:appdb:v1:active",new JSONObject().put("version",1).put("mode","active").toString());
            database.putState("migration:appdb:indexes:v1:active","verified-v1");
            var method=NativeBackgroundResourceImporter.class.getDeclaredMethod("storeThumbnail",NativeAppDatabase.class,File.class);
            method.setAccessible(true); String id=database.withReadGuard(()->(String)method.invoke(null,database,source)); assertNotNull(id);
            JSONObject asset=database.getRecord("assets",JSONObject.quote(id));
            String card=asset.getJSONObject("thumbnailRefs").getString("card");
            assertTrue(database.getRecord("assets",JSONObject.quote(card)).getBoolean("vaultProtected"));
            JSONArray keys=new JSONArray().put(JSONObject.quote(id));
            File full=new File(Uri.parse(database.getAssetImageSources(keys).getJSONObject(0).getJSONObject("blob").getString("path")).getPath());
            File small=new File(Uri.parse(database.getAssetImageSources(keys,keys).getJSONObject(0).getJSONObject("blob").getString("path")).getPath());
            var fullBounds=NativeImageDecoder.bounds(full); var smallBounds=NativeImageDecoder.bounds(small);
            assertEquals(640,Math.max(fullBounds.outWidth,fullBounds.outHeight));
            assertEquals(320,Math.max(smallBounds.outWidth,smallBounds.outHeight));
        } finally { context.deleteDatabase(name); assertTrue(source.delete()); }
    }
    private static class Call extends PluginCall {
        final CountDownLatch done = new CountDownLatch(1);
        JSObject result; String failure, thread; long finished;
        Call(String method, JSObject data) { super(null, "NativeImages", "test", method, data); }
        @Override public void resolve(JSObject data) { result=data; finish(); }
        @Override public void resolve() { finish(); }
        @Override public void reject(String message, String code, Exception error, JSObject data) {
            failure=message; finish();
        }
        private void finish() { thread=Thread.currentThread().getName(); finished=SystemClock.elapsedRealtimeNanos(); done.countDown(); }
        void await() throws Exception { assertTrue("Native image task did not finish",done.await(30,TimeUnit.SECONDS)); assertNull(failure); }
    }
    @Test public void measuresForegroundReadDuringActualThumbnailGeneration() throws Exception {
        Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();
        String label=InstrumentationRegistry.getArguments().getString("measurementLabel","current");
        File picked=new File(context.getCacheDir(),"picked-images"); assertTrue(picked.mkdirs()||picked.isDirectory());
        File source=new File(picked,"thumbnail-queue-"+UUID.randomUUID()+".jpg");
        Bitmap image=Bitmap.createBitmap(2048,3072,Bitmap.Config.ARGB_8888);
        int[] row=new int[2048]; Random random=new Random(7);
        for(int y=0;y<3072;y++) { for(int x=0;x<2048;x++)row[x]=0xff000000|random.nextInt(0x1000000); image.setPixels(row,0,2048,0,y,2048,1); }
        try(FileOutputStream output=new FileOutputStream(source)) { assertTrue(image.compress(Bitmap.CompressFormat.JPEG,95,output)); }
        image.recycle();
        NativeImagesPlugin plugin=new NativeImagesPlugin() { @Override public Context getContext(){return context;} };
        JSONArray measurements=new JSONArray();
        String dbName="thumbnail-queue-"+UUID.randomUUID();
        try(NativeAppDatabase database=new NativeAppDatabase(context,dbName)) {
            database.getReadableDatabase();
            for(int round=0;round<7;round++) {
                JSObject data=new JSObject(); data.put("uri",Uri.fromFile(source).toString());
                data.put("size",source.length()); data.put("maxEdge",640); data.put("quality",0.82);
                Call generated=new Call("createThumbnail",data);
                long started=SystemClock.elapsedRealtimeNanos();
                plugin.createThumbnail(generated);
                CountDownLatch readDone=new CountDownLatch(1); AtomicReference<Throwable> failure=new AtomicReference<>();
                long[] readTimes=new long[2]; long queued=SystemClock.elapsedRealtimeNanos();
                NativeExecutors.ioSerial().execute(()->{
                    readTimes[0]=SystemClock.elapsedRealtimeNanos();
                    try { assertEquals(1,database.getAssetImageSources(new JSONArray().put("\"missing\"")).length()); }
                    catch(Throwable error){failure.set(error);} finally {readTimes[1]=SystemClock.elapsedRealtimeNanos();readDone.countDown();}
                });
                assertTrue(readDone.await(30,TimeUnit.SECONDS)); assertNull(failure.get()); generated.await();
                if (!"baseline".equals(label)) assertTrue("Image generation must not occupy the database serial queue",generated.thread.matches("srl-io-[0-9]+"));
                File thumbnail=new File(Uri.parse(generated.result.getString("uri")).getPath());
                BitmapFactory.Options bounds=NativeImageDecoder.bounds(thumbnail);
                assertEquals(640,Math.max(bounds.outWidth,bounds.outHeight));
                measurements.put(new JSONObject().put("round",round).put("label",label)
                    .put("waitMs",(readTimes[0]-queued)/1e6).put("readMs",(readTimes[1]-readTimes[0])/1e6)
                    .put("imageMs",(generated.finished-started)/1e6).put("imageThread",generated.thread)
                    .put("sourceBytes",source.length()).put("thumbnailBytes",thumbnail.length()).put("appPssKiB",Debug.getPss()));
                Call release=new Call("releaseThumbnail",new JSObject().put("uri",thumbnail.toURI().toString()));
                plugin.releaseThumbnail(release); release.await();
            }
            Call[] parallel=new Call[3]; long parallelStarted=SystemClock.elapsedRealtimeNanos();
            for(int index=0;index<parallel.length;index++) {
                JSObject data=new JSObject();data.put("uri",Uri.fromFile(source).toString());data.put("size",source.length());data.put("maxEdge",640);
                parallel[index]=new Call("createThumbnail",data); plugin.createThumbnail(parallel[index]);
            }
            long sampledPeak=Debug.getPss();
            while(SystemClock.elapsedRealtimeNanos()-parallelStarted<TimeUnit.SECONDS.toNanos(30)) {
                boolean pending=false;for(Call call:parallel)pending|=call.done.getCount()>0;
                if(!pending)break;
                sampledPeak=Math.max(sampledPeak,Debug.getPss());SystemClock.sleep(5);
            }
            long finished=0;
            for(Call call:parallel) {
                call.await();finished=Math.max(finished,call.finished);
                var bounds=NativeImageDecoder.bounds(new File(Uri.parse(call.result.getString("uri")).getPath()));
                assertEquals(640,Math.max(bounds.outWidth,bounds.outHeight));
                Call release=new Call("releaseThumbnail",new JSObject().put("uri",call.result.getString("uri")));plugin.releaseThumbnail(release);release.await();
            }
            JSONObject parallelResult=new JSONObject().put("images",3).put("elapsedMs",(finished-parallelStarted)/1e6).put("sampledAppPeakPssKiB",sampledPeak);
            try(FileOutputStream output=new FileOutputStream(new File(context.getFilesDir(),"thumbnail-parallel-"+label+".json"))) {output.write(parallelResult.toString().getBytes(StandardCharsets.UTF_8));}
        } finally { context.deleteDatabase(dbName); assertTrue(source.delete()); }
        File result=new File(context.getFilesDir(),"thumbnail-queue-"+label+".json");
        try(FileOutputStream output=new FileOutputStream(result)) { output.write(measurements.toString().getBytes(StandardCharsets.UTF_8)); }
    }
}
