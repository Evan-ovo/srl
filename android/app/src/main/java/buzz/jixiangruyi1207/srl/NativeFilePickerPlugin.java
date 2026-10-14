package buzz.jixiangruyi1207.srl;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;

/** Images use Android Photo Picker on API 33+; older Android falls back to read-only SAF. */
@CapacitorPlugin(name = "NativeFilePicker")
public class NativeFilePickerPlugin extends Plugin {
    /** Same SAF owner for webpage uploads; the chosen URI never enters model/chat data. */
    static Intent browserFileIntent(String[] types, boolean multiple) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
            .setType("*/*").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple);
        java.util.ArrayList<String> accepted = new java.util.ArrayList<>();
        if (types != null) for (String type : types) if (type != null && type.matches("[A-Za-z0-9!#$&^_.+*-]+/[A-Za-z0-9!#$&^_.+*-]+")) accepted.add(type);
        if (!accepted.isEmpty()) intent.putExtra(Intent.EXTRA_MIME_TYPES, accepted.toArray(new String[0]));
        return intent;
    }
    static Uri[] browserSelectedFiles(Intent data) {
        java.util.ArrayList<Uri> files = new java.util.ArrayList<>();
        if (data != null && data.getClipData() != null) for (int i = 0; i < data.getClipData().getItemCount(); i++) files.add(data.getClipData().getItemAt(i).getUri());
        else if (data != null && data.getData() != null) files.add(data.getData());
        for (Uri uri : files) if (uri == null || !"content".equals(uri.getScheme())) return null;
        return files.isEmpty() ? null : files.toArray(new Uri[0]);
    }
    static androidx.activity.result.ActivityResultLauncher<Intent> registerBrowserPicker(
            androidx.activity.ComponentActivity activity, java.util.function.Consumer<Uri[]> selected) {
        return activity.getActivityResultRegistry().register("srl-assistant-browser-upload",
            new androidx.activity.result.contract.ActivityResultContracts.StartActivityForResult(),
            result -> selected.accept(result.getResultCode() == Activity.RESULT_OK ? browserSelectedFiles(result.getData()) : null));
    }
    private static final long MAX_IMAGE_BYTES = 64L * 1024L * 1024L;
    private static final long RETENTION_MS = 24L * 60L * 60L * 1000L;

    @PluginMethod
    public void pickImage(PluginCall call) {
        Intent intent;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent = new Intent(MediaStore.ACTION_PICK_IMAGES).setType("image/*");
        } else {
            intent = new Intent(Intent.ACTION_OPEN_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType("image/*")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        }
        startActivityForResult(call, intent, "imageSelected");
    }

    @ActivityCallback
    private void imageSelected(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        Uri uri = data == null ? null : data.getData();
        if (result.getResultCode() != Activity.RESULT_OK || uri == null) {
            JSObject value = new JSObject();
            value.put("cancelled", true);
            call.resolve(value);
            return;
        }
        NativeExecutors.ioLimited().execute(() -> stageImage(call, uri));
    }

    private void stageImage(PluginCall call, Uri uri) {
        try {
            File directory = new File(getContext().getCacheDir(), "picked-images");
            if (!directory.exists() && !directory.mkdirs()) {
                throw new IllegalStateException("无法创建图片暂存目录");
            }
            cleanStale(directory);
            String name = queryName(uri);
            String mimeType = getContext().getContentResolver().getType(uri);
            if (mimeType == null || !mimeType.startsWith("image/")) {
                throw new IllegalArgumentException("所选内容不是受支持的图片");
            }
            String suffix = suffix(name, mimeType);
            File target = File.createTempFile("picked-", suffix, directory);
            long bytes = 0;
            try (InputStream input = getContext().getContentResolver().openInputStream(uri);
                 FileOutputStream output = new FileOutputStream(target)) {
                if (input == null) throw new IllegalArgumentException("无法读取所选图片");
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = input.read(buffer)) >= 0) {
                    bytes += read;
                    if (bytes > MAX_IMAGE_BYTES) throw new IllegalArgumentException("图片不能超过 64 MiB");
                    output.write(buffer, 0, read);
                }
            } catch (Exception error) {
                target.delete();
                throw error;
            }
            JSObject value = new JSObject();
            value.put("cancelled", false);
            value.put("uri", Uri.fromFile(target).toString());
            value.put("name", safeName(name, target.getName()));
            value.put("mimeType", mimeType);
            value.put("size", bytes);
            getActivity().runOnUiThread(() -> call.resolve(value));
        } catch (Exception error) {
            getActivity().runOnUiThread(() -> call.reject("无法读取所选图片：" + error.getMessage(), error));
        }
    }

    private String queryName(Uri uri) {
        try (Cursor cursor = getContext().getContentResolver().query(
            uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null
        )) {
            if (cursor != null && cursor.moveToFirst()) return cursor.getString(0);
        } catch (Exception ignored) {}
        return "image";
    }

    private static String suffix(String name, String mimeType) {
        int dot = name == null ? -1 : name.lastIndexOf('.');
        if (dot >= 0 && dot < name.length() - 1) return name.substring(dot);
        if ("image/jpeg".equals(mimeType)) return ".jpg";
        if ("image/webp".equals(mimeType)) return ".webp";
        if ("image/gif".equals(mimeType)) return ".gif";
        return ".png";
    }

    private static String safeName(String value, String fallback) {
        if (value == null || value.trim().isEmpty()) return fallback;
        return value.replaceAll("[\\\\/:*?\"<>|]", "_");
    }

    private static void cleanStale(File directory) {
        File[] files = directory.listFiles();
        if (files == null) return;
        long cutoff = System.currentTimeMillis() - RETENTION_MS;
        for (File file : files) if (file.isFile() && file.lastModified() < cutoff) file.delete();
    }
}
