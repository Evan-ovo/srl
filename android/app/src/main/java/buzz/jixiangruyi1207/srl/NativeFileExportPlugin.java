package buzz.jixiangruyi1207.srl;

import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import androidx.activity.result.ActivityResult;
import androidx.documentfile.provider.DocumentFile;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import android.util.Base64;
import android.webkit.CookieManager;
import java.io.InputStream;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;
import java.io.OutputStream;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/** 用户明确选择的本地导出：图片进入相册，其他文件进入下载，任意位置仅通过 SAF 获得授权。 */
@CapacitorPlugin(name = "NativeFileExport")
public class NativeFileExportPlugin extends Plugin {
    private static final String PREFS = "srl-native-file-export";
    private static final String TREE_URI = "tree-uri";
    private static final int MAX_CHUNK_BYTES = 1024 * 1024;
    private final ConcurrentHashMap<String, PendingWrite> pendingWrites = new ConcurrentHashMap<>();
    /** Browser downloads share the existing export destination and write/commit cleanup. */
    JSObject downloadBrowserFile(String url, String name, String mime, String pageUrl, String userAgent,
                                java.util.function.BooleanSupplier current, java.util.function.Consumer<okhttp3.Call> activeCall,
                                java.util.function.LongConsumer progress) throws Exception {
        if (!AssistantBrowserPolicy.browseAllowed(url)) throw new IllegalArgumentException("只支持 HTTPS 文件下载");
        if (!current.getAsBoolean()) throw new java.io.IOException("网页任务已停止");
        PendingWrite write = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
            ? createMediaStoreWrite("downloads", safeName(name), safeMimeType(mime))
            : createDirectoryWrite(safeName(name), safeMimeType(mime));
        boolean committed = false;
        try {
            String target = url;
            boolean received = false;
            for (int redirects = 0; redirects <= 10; redirects++) {
                if (!current.getAsBoolean() || !AssistantBrowserPolicy.browseAllowed(target)) throw new java.io.IOException("下载任务已停止或跳转地址不可用");
                Request.Builder request = new Request.Builder().url(target).get().header("User-Agent", userAgent);
                // Rebuild credentials per destination; never carry an origin's Cookie across a redirect.
                String cookie = CookieManager.getInstance().getCookie(target);
                if (cookie != null && !cookie.isBlank()) request.header("Cookie", cookie);
                okhttp3.Call transfer = NativeHttpClients.CLOUD.newBuilder().followRedirects(false).followSslRedirects(false).build().newCall(request.build());
                activeCall.accept(transfer);
                if (!current.getAsBoolean()) { transfer.cancel(); throw new java.io.IOException("网页下载已停止"); }
                try (Response response = transfer.execute()) {
                if (response.code() >= 300 && response.code() < 400 && response.header("Location") != null) {
                    okhttp3.HttpUrl next = response.request().url().resolve(response.header("Location"));
                    if (next == null) throw new java.io.IOException("下载跳转地址无效");
                    target = next.toString(); continue;
                }
                if (!response.isSuccessful() || response.body() == null) throw new java.io.IOException("文件下载 HTTP " + response.code() + "；检查当前链接，不重试旧提交");
                long expected = response.body().contentLength();
                try (InputStream input = response.body().byteStream()) {
                    write.bytes = copyBrowserBody(input, write.stream, expected, current, progress);
                }
                received = true; break;
                }
            }
            if (!received) throw new java.io.IOException("文件下载跳转过多");
            if (!current.getAsBoolean()) throw new java.io.IOException("下载提交前任务已停止");
            commit(write); committed = true;
            return new JSObject().put("uri", write.uri.toString()).put("bytes", write.bytes).put("name", safeName(name));
        } finally {
            activeCall.accept(null);
            if (!committed) { try { write.stream.close(); } finally { getContext().getContentResolver().delete(write.uri, null, null); } }
        }
    }
    static long copyBrowserBody(InputStream input, OutputStream output, long expected,
                                java.util.function.BooleanSupplier current, java.util.function.LongConsumer progress) throws Exception {
        byte[] buffer = new byte[128 * 1024]; long bytes = 0; int count;
        while ((count = input.read(buffer)) != -1) {
            if (!current.getAsBoolean()) throw new java.io.IOException("网页下载已停止");
            if (expected >= 0 && bytes + count > expected) throw new java.io.IOException("下载文件超过声明大小");
            output.write(buffer, 0, count); bytes += count; progress.accept(bytes);
        }
        if (expected >= 0 && bytes != expected) throw new java.io.IOException("下载文件不完整");
        return bytes;
    }


    @PluginMethod
    public void chooseDirectory(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            .addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        startActivityForResult(call, intent, "directorySelected");
    }

    @ActivityCallback
    private void directorySelected(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.resolve(directoryStatus());
            return;
        }
        Uri treeUri = result.getData().getData();
        int flags = result.getData().getFlags();
        try {
            boolean canRead = (flags & Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0;
            boolean canWrite = (flags & Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != 0;
            if (canRead && canWrite) {
                getContext().getContentResolver().takePersistableUriPermission(treeUri, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            } else if (canRead) {
                getContext().getContentResolver().takePersistableUriPermission(treeUri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } else if (canWrite) {
                getContext().getContentResolver().takePersistableUriPermission(treeUri, Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            } else {
                throw new SecurityException("系统没有授予所选文件夹的读写权限");
            }
            prefs().edit().putString(TREE_URI, treeUri.toString()).apply();
            call.resolve(directoryStatus());
        } catch (Exception error) {
            call.reject("无法保留所选文件夹的授权：" + error.getMessage(), error);
        }
    }

    @PluginMethod public void getDirectoryStatus(PluginCall call) { call.resolve(directoryStatus()); }

    @PluginMethod
    public void clearDirectory(PluginCall call) {
        prefs().edit().remove(TREE_URI).apply();
        call.resolve(directoryStatus());
    }

    @PluginMethod
    public void beginWrite(PluginCall call) {
        try {
            String destination = call.getString("destination", "");
            String fileName = safeName(call.getString("fileName", "SRL-export"));
            String mimeType = safeMimeType(call.getString("mimeType", "application/octet-stream"));
            PendingWrite write;
            if ("directory".equals(destination)) write = createDirectoryWrite(fileName, mimeType);
            else if ("pictures".equals(destination) || "downloads".equals(destination)) write = createMediaStoreWrite(destination, fileName, mimeType);
            else throw new IllegalArgumentException("不支持的保存位置");
            String token = UUID.randomUUID().toString();
            pendingWrites.put(token, write);
            JSObject value = new JSObject(); value.put("token", token); call.resolve(value);
        } catch (Exception error) { call.reject(error.getMessage(), error); }
    }

    @PluginMethod
    public void appendWrite(PluginCall call) {
        try {
            PendingWrite write = pending(call.getString("token"));
            byte[] bytes = Base64.decode(call.getString("data", ""), Base64.NO_WRAP);
            if (bytes.length > MAX_CHUNK_BYTES) throw new IllegalArgumentException("导出分块超过 1 MiB");
            synchronized (write) { write.stream.write(bytes); write.bytes += bytes.length; }
            call.resolve();
        } catch (Exception error) { call.reject(error.getMessage(), error); }
    }

    @PluginMethod
    public void commitWrite(PluginCall call) {
        try {
            PendingWrite write = pendingWrites.remove(call.getString("token"));
            if (write == null) throw new IllegalArgumentException("导出写入令牌已失效");
            commit(write);
            JSObject value = new JSObject(); value.put("uri", write.uri.toString()); value.put("bytes", write.bytes); call.resolve(value);
        } catch (Exception error) { call.reject(error.getMessage(), error); }
    }

    @PluginMethod
    public void abortWrite(PluginCall call) {
        PendingWrite write = pendingWrites.remove(call.getString("token"));
        try {
            if (write != null) {
                synchronized (write) { write.stream.close(); }
                getContext().getContentResolver().delete(write.uri, null, null);
            }
            call.resolve();
        } catch (Exception error) { call.reject("取消导出失败：" + error.getMessage(), error); }
    }

    @Override protected void handleOnDestroy() {
        for (PendingWrite write : pendingWrites.values()) try { write.stream.close(); } catch (Exception ignored) {}
        pendingWrites.clear();
    }

    private PendingWrite createMediaStoreWrite(String destination, String fileName, String mimeType) throws Exception {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) throw new IllegalStateException("Android 10 以下请使用“选择文件夹”保存文件");
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
        values.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, "pictures".equals(destination) ? "Pictures/SRL" : "Download/SRL");
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri collection = "pictures".equals(destination) ? MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY) : MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
        Uri uri = getContext().getContentResolver().insert(collection, values);
        if (uri == null) throw new IllegalStateException("无法在系统目录创建导出文件");
        OutputStream stream = getContext().getContentResolver().openOutputStream(uri, "w");
        if (stream == null) { getContext().getContentResolver().delete(uri, null, null); throw new IllegalStateException("无法写入系统目录"); }
        return new PendingWrite(uri, stream, true);
    }
    private void commit(PendingWrite write) throws Exception {
        synchronized (write) { write.stream.flush(); write.stream.close(); }
        if (write.mediaStore && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentValues values = new ContentValues(); values.put(MediaStore.MediaColumns.IS_PENDING, 0);
            getContext().getContentResolver().update(write.uri, values, null, null);
        }
    }

    private PendingWrite createDirectoryWrite(String fileName, String mimeType) throws Exception {
        Uri treeUri = treeUri();
        DocumentFile tree = treeUri == null ? null : DocumentFile.fromTreeUri(getContext(), treeUri);
        if (tree == null || !tree.canWrite()) throw new IllegalStateException("尚未授权导出文件夹，请先选择文件夹");
        DocumentFile output = tree.createFile(mimeType, fileName);
        if (output == null) throw new IllegalStateException("无法在所选文件夹创建文件");
        OutputStream stream = getContext().getContentResolver().openOutputStream(output.getUri(), "w");
        if (stream == null) { output.delete(); throw new IllegalStateException("无法写入所选文件夹"); }
        return new PendingWrite(output.getUri(), stream, false);
    }

    private JSObject directoryStatus() {
        JSObject result = new JSObject(); Uri uri = treeUri(); DocumentFile tree = uri == null ? null : DocumentFile.fromTreeUri(getContext(), uri);
        result.put("configured", uri != null); result.put("available", tree != null && tree.exists() && tree.canWrite());
        if (tree != null && tree.getName() != null) result.put("name", tree.getName());
        return result;
    }
    private SharedPreferences prefs() { return getContext().getSharedPreferences(PREFS, Activity.MODE_PRIVATE); }
    private Uri treeUri() { String value = prefs().getString(TREE_URI, null); return value == null || value.isBlank() ? null : Uri.parse(value); }
    private PendingWrite pending(String token) { PendingWrite value = token == null ? null : pendingWrites.get(token); if (value == null) throw new IllegalArgumentException("导出写入令牌已失效"); return value; }
    private String safeName(String value) { String name = value.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim(); return name.isBlank() ? "SRL-export" : name; }
    private String safeMimeType(String value) { return value != null && value.matches("^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$") ? value : "application/octet-stream"; }
    private static final class PendingWrite { final Uri uri; final OutputStream stream; final boolean mediaStore; long bytes; PendingWrite(Uri uri, OutputStream stream, boolean mediaStore) { this.uri=uri; this.stream=stream; this.mediaStore=mediaStore; } }
}
