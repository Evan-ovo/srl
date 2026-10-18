package buzz.jixiangruyi1207.srl;

import android.app.Activity;
import android.content.Intent;
import android.content.UriPermission;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import androidx.documentfile.provider.DocumentFile;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.OutputStream;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import android.util.Base64;

/** 用户明确选择的 SAF 文件夹。只保存 SRL 导出的 ZIP，不申请全盘文件权限。 */
@CapacitorPlugin(name = "NativeSafBackup")
public class NativeSafBackupPlugin extends Plugin {
    private static final String PREFS = "srl-saf-backup";
    private static final String TREE_URI = "tree-uri";
    private static final String LAST_BACKUP_AT = "last-backup-at";
    private static final int MAX_CHUNK_BYTES = 1024 * 1024;
    private volatile boolean destroyed;
    private final AtomicInteger directoryGeneration = new AtomicInteger();
    private final ConcurrentHashMap<String, PendingWrite> pendingWrites = new ConcurrentHashMap<>();

    @PluginMethod public void beginArchive(PluginCall call) {
        archiveIo(call, () -> NativeArchiveExport.begin(getContext(),call.getString("taskId"),safeName(call.getString("fileName","SRL.zip")),prefs().getString(TREE_URI,null)));
    }
    @PluginMethod public void getArchiveEntry(PluginCall call) {
        archiveIo(call, () -> { JSObject value=new JSObject(); value.put("entry",NativeArchiveExport.entry(getContext(),call.getString("id"),call.getString("path"))); return value; });
    }
    @PluginMethod public void resetArchiveInput(PluginCall call) {
        archiveIo(call, () -> { NativeArchiveExport.resetInput(getContext(),call.getString("id"),call.getString("path")); return new JSObject(); });
    }
    @PluginMethod public void appendArchiveInput(PluginCall call) {
        archiveIo(call, () -> {
            String data=call.getString("data","");
            if(data.length()>1400000) throw new IllegalArgumentException("导出分块过大");
            long offset = NativeBridgeNumber.bounded(call.getData().opt("offset"), 0L, NativeBridgeNumber.MAX_SAFE_INTEGER, "导出分块位置无效");
            NativeArchiveExport.appendInput(getContext(),call.getString("id"),call.getString("path"),offset,Base64.decode(data,Base64.NO_WRAP));
            return new JSObject();
        });
    }
    @PluginMethod public void compressArchiveEntry(PluginCall call) {
        archiveIo(call, () -> {
            long size = NativeBridgeNumber.bounded(call.getData().opt("size"), 0L, NativeBridgeNumber.MAX_SAFE_INTEGER, "导出源文件大小无效");
            long mtime = NativeBridgeNumber.boundedOrDefault(call.getData().opt("mtime"), 315532800000L, 0L, NativeBridgeNumber.MAX_SAFE_INTEGER, "导出源文件时间无效");
            return NativeArchiveExport.compress(getContext(),call.getString("id"),call.getString("path"),call.getString("uri"),size,call.getBoolean("compress",true),mtime,call.getObject("descriptor"));
        });
    }
    @PluginMethod public void assembleArchive(PluginCall call) {
        archiveIo(call, () -> {
            java.util.List<String> paths=new java.util.ArrayList<>();
            org.json.JSONArray input=call.getArray("paths");
            if(input==null) throw new IllegalArgumentException("缺少条目清单");
            for(int i=0;i<input.length();i++) paths.add(input.getString(i));
            return NativeArchiveExport.assemble(getContext(),call.getString("id"),paths);
        });
    }
    @PluginMethod public void publishArchive(PluginCall call) {
        archiveIo(call, () -> {
            String expected = prefs().getString(TREE_URI, null);
            if (expected == null || !expected.equals(NativeArchiveExport.state(getContext(),call.getString("id")).optString("treeUri")))
                throw new SecurityException("原备份目录授权已取消或改变，请重新选择目录后开始新任务");
            JSObject result=NativeArchiveExport.publish(getContext(),call.getString("id"));
            prefs().edit().putLong(LAST_BACKUP_AT,System.currentTimeMillis()).apply();
            return result;
        });
    }
    @PluginMethod public void discardArchiveTask(PluginCall call) {
        archiveIo(call, () -> { NativeArchiveExport.removeTask(getContext(),call.getString("taskId")); return new JSObject(); });
    }
    private interface ArchiveAction { JSObject run() throws Exception; }
    private void archiveIo(PluginCall call, ArchiveAction action) {
        NativeExecutors.ioSerial().execute(() -> { synchronized (NativeArchiveExport.class) { try { if (destroyed) throw new IllegalStateException("备份工作区已关闭"); call.resolve(action.run()); } catch(Exception error) { call.reject(error.getMessage(),error); } } });
    }

    @PluginMethod
    public void chooseDirectory(PluginCall call) {
        call.getData().put("directoryGeneration", directoryGeneration.incrementAndGet());
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            .addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        startActivityForResult(call, intent, "directorySelected");
    }

    @ActivityCallback
    private void directorySelected(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.resolve(status());
            return;
        }
        Uri treeUri = result.getData().getData();
        int grantedFlags = result.getData().getFlags();
        int generation = call.getInt("directoryGeneration", -1);
        archiveIo(call, () -> {
            if (generation != directoryGeneration.get()) return status();
            if (!pendingWrites.isEmpty()) throw new IllegalStateException("请先停止当前备份写入，再更换目录");
            int flags = ((grantedFlags & Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0 ? Intent.FLAG_GRANT_READ_URI_PERMISSION : 0)
                | ((grantedFlags & Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != 0 ? Intent.FLAG_GRANT_WRITE_URI_PERMISSION : 0);
            if (flags == 0) throw new SecurityException("系统没有授予所选文件夹的读写权限");
            Uri previous = treeUri();
            getContext().getContentResolver().takePersistableUriPermission(treeUri, flags);
            boolean shared = previous != null && !previous.equals(treeUri) && releaseDirectoryGrant(previous);
            prefs().edit().putString(TREE_URI, treeUri.toString()).apply();
            JSObject value = status();
            if (shared) value.put("warning", "已更换备份目录；旧目录仍被其他功能使用，其共享授权保留。");
            return value;
        });
    }

    /** Only the backup selection changes; another feature sharing the same URI keeps its permission. */
    private boolean releaseDirectoryGrant(Uri previous) {
        boolean shared = previous.toString().equals(getContext().getSharedPreferences("srl-tavern-directory", 0).getString("tree", null));
        if (!shared) {
            for (UriPermission permission : getContext().getContentResolver().getPersistedUriPermissions()) {
                if (!previous.equals(permission.getUri())) continue;
                int flags = (permission.isReadPermission() ? Intent.FLAG_GRANT_READ_URI_PERMISSION : 0)
                    | (permission.isWritePermission() ? Intent.FLAG_GRANT_WRITE_URI_PERMISSION : 0);
                if (flags != 0) getContext().getContentResolver().releasePersistableUriPermission(previous, flags);
            }
        }
        return shared;
    }

    @PluginMethod
    public void getStatus(PluginCall call) { call.resolve(status()); }

    @PluginMethod
    public void clearDirectory(PluginCall call) {
        directoryGeneration.incrementAndGet();
        archiveIo(call, () -> {
            synchronized (pendingWrites) {
                Uri previous = treeUri();
                for (PendingWrite write : pendingWrites.values()) {
                    synchronized (write) { write.stream.close(); }
                    if (write.file.exists() && !write.file.delete()) throw new IllegalStateException("未完成备份文件无法清理，目录授权仍保留");
                }
                pendingWrites.clear();
                boolean shared = previous != null && releaseDirectoryGrant(previous);
                prefs().edit().remove(TREE_URI).remove(LAST_BACKUP_AT).apply();
                JSObject result = status();
                result.put("warning", shared ? "已取消备份目录；其他功能仍在使用此目录，系统共享授权予以保留。" : "已取消备份目录并释放系统授权。");
                return result;
            }
        });
    }

    @PluginMethod
    public void beginWrite(PluginCall call) {
        archiveIo(call, () -> {
            Uri treeUri = treeUri();
            DocumentFile tree = treeUri == null ? null : DocumentFile.fromTreeUri(getContext(), treeUri);
            if (tree == null || !tree.canWrite()) throw new IllegalStateException("系统备份文件夹不可写，请重新选择");
            DocumentFile output = tree.createFile("application/zip", safeName(call.getString("fileName", "SRL-备份.zip")));
            if (output == null) throw new IllegalStateException("无法在系统备份文件夹创建文件");
            OutputStream stream = getContext().getContentResolver().openOutputStream(output.getUri(), "w");
            if (stream == null) { output.delete(); throw new IllegalStateException("无法写入系统备份文件"); }
            String token = UUID.randomUUID().toString();
            pendingWrites.put(token, new PendingWrite(output, stream));
            JSObject value = new JSObject(); value.put("token", token); return value;
        });
    }
    @PluginMethod
    public void appendWrite(PluginCall call) {
        archiveIo(call, () -> {
            PendingWrite write = pending(call.getString("token"));
            byte[] bytes = Base64.decode(call.getString("data", ""), Base64.NO_WRAP);
            if (bytes.length > MAX_CHUNK_BYTES) throw new IllegalArgumentException("备份分块超过 1 MiB");
            write.stream.write(bytes); write.bytes += bytes.length;
            return new JSObject();
        });
    }
    @PluginMethod
    public void commitWrite(PluginCall call) {
        archiveIo(call, () -> {
            String token = call.getString("token");
            PendingWrite write = pending(token);
            write.stream.flush(); write.stream.close();
            pendingWrites.remove(token, write);
            prefs().edit().putLong(LAST_BACKUP_AT, System.currentTimeMillis()).apply();
            JSObject value = new JSObject(); value.put("uri", write.file.getUri().toString()); value.put("bytes", write.bytes); return value;
        });
    }
    @PluginMethod
    public void abortWrite(PluginCall call) {
        archiveIo(call, () -> {
            String token = call.getString("token");
            PendingWrite write = pendingWrites.get(token);
            if (write != null) {
                write.stream.close();
                if (write.file.exists() && !write.file.delete()) throw new IllegalStateException("未完成备份文件无法清理");
                pendingWrites.remove(token, write);
            }
            return new JSObject();
        });
    }
    @Override protected void handleOnDestroy() {
        destroyed = true;
        directoryGeneration.incrementAndGet();
        NativeExecutors.ioSerial().execute(() -> {
            for (PendingWrite write : pendingWrites.values()) {
                try { write.stream.close(); write.file.delete(); } catch (Exception ignored) {}
            }
            pendingWrites.clear();
        });
    }

    private JSObject status() {
        JSObject result = new JSObject();
        Uri uri = treeUri();
        DocumentFile tree = uri == null ? null : DocumentFile.fromTreeUri(getContext(), uri);
        boolean available = tree != null && tree.exists() && tree.canRead() && tree.canWrite();
        result.put("configured", uri != null);
        result.put("available", available);
        if (uri != null) result.put("uri", uri.toString());
        if (tree != null && tree.getName() != null) result.put("name", tree.getName());
        long availableBytes = availableBytes(uri);
        if (availableBytes >= 0) result.put("availableBytes", availableBytes);
        result.put("lastBackupAt", prefs().getLong(LAST_BACKUP_AT, 0));
        return result;
    }
    private SharedPreferences prefs() { return getContext().getSharedPreferences(PREFS, Activity.MODE_PRIVATE); }
    private Uri treeUri() { String value = prefs().getString(TREE_URI, null); return value == null || value.isBlank() ? null : Uri.parse(value); }
    /** 外部存储提供器会公开根目录余量；第三方云盘未公开时返回 -1，由页面如实标为未知。 */
    private long availableBytes(Uri uri) {
        if (uri == null || uri.getAuthority() == null) return -1;
        try (Cursor cursor = getContext().getContentResolver().query(
            DocumentsContract.buildRootsUri(uri.getAuthority()), null, null, null, null
        )) {
            if (cursor == null) return -1;
            String treeId = DocumentsContract.getTreeDocumentId(uri);
            String rootId = treeId.contains(":") ? treeId.substring(0, treeId.indexOf(':')) : treeId;
            int idIndex = cursor.getColumnIndex(DocumentsContract.Root.COLUMN_DOCUMENT_ID);
            int bytesIndex = cursor.getColumnIndex(DocumentsContract.Root.COLUMN_AVAILABLE_BYTES);
            while (cursor.moveToNext()) {
                if (idIndex >= 0 && rootId.equals(cursor.getString(idIndex)) && bytesIndex >= 0 && !cursor.isNull(bytesIndex)) return cursor.getLong(bytesIndex);
            }
        } catch (Exception ignored) {}
        return -1;
    }
    private PendingWrite pending(String token) { PendingWrite value = token == null ? null : pendingWrites.get(token); if (value == null) throw new IllegalArgumentException("系统备份写入令牌已失效"); return value; }
    private String safeName(String value) { String name = value.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim(); return name.isBlank() ? "SRL-备份.zip" : name; }
    private static final class PendingWrite { final DocumentFile file; final OutputStream stream; long bytes; PendingWrite(DocumentFile file, OutputStream stream) { this.file=file; this.stream=stream; } }
}
