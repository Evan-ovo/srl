package buzz.jixiangruyi1207.srl;
import android.net.Uri;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.util.UUID;

@CapacitorPlugin(name = "NativeImages")
public class NativeImagesPlugin extends Plugin {
    @PluginMethod
    public void inspectImage(PluginCall call) {
        runIo(call, () -> {
            File source = NativeFileAccess.resolve(getContext(), call.getString("uri"));
            android.graphics.BitmapFactory.Options info = NativeImageDecoder.bounds(source);
            JSObject result = new JSObject();
            result.put("width", info.outWidth);
            result.put("height", info.outHeight);
            // The browser remains the owner of EXIF-oriented and animated image formats.
            result.put("supported", NativeImageDecoder.supportsRegion(source, info));
            call.resolve(result);
        });
    }

    @PluginMethod
    public void readImageRegion(PluginCall call) {
        runIo(call, () -> {
            File source = NativeFileAccess.resolve(getContext(), call.getString("uri"));
            android.graphics.Rect rect = new android.graphics.Rect(call.getInt("left", -1), call.getInt("top", -1), call.getInt("right", -1), call.getInt("bottom", -1));
            android.graphics.Bitmap bitmap = NativeImageDecoder.region(source, rect, Math.max(32, Math.min(2048, call.getInt("edge", 1024))));
            if (bitmap == null) throw new IllegalStateException("图片不支持分块解码");
            JSObject result = new JSObject();
            result.put("uri", saveTemporaryThumbnail(bitmap, 92));
            call.resolve(result);
        });
    }

    private String saveTemporaryThumbnail(android.graphics.Bitmap bitmap, int quality) throws Exception {
        try {
            File directory = new File(getContext().getCacheDir(), "srl-thumbnails");
            if (!directory.isDirectory() && !directory.mkdirs()) throw new IllegalStateException("无法创建缩略图目录");
            File output = new File(directory, UUID.randomUUID() + ".webp");
            try (FileOutputStream stream = new FileOutputStream(output)) {
                if (!bitmap.compress(android.graphics.Bitmap.CompressFormat.WEBP, quality, stream)) throw new IllegalStateException("无法编码缩略图");
            }
            return Uri.fromFile(output).toString();
        } finally { bitmap.recycle(); }
    }

    @PluginMethod
    public void createThumbnail(PluginCall call) {
        runIo(call, () -> {
            File file = NativeFileAccess.resolveImage(getContext(), call.getString("uri"));
            NativeBridgeNumber.matchingFileSize(
                call.getData().opt("size"), file.length(), NativeBridgeNumber.MAX_SAFE_INTEGER,
                "原生文件大小无效", "原生文件大小已变化"
            );
            int edge = Math.max(32, Math.min(768, call.getInt("maxEdge", 640)));
            int quality = (int) Math.round(Math.max(0.5, Math.min(0.95, call.getDouble("quality", 0.82))) * 100);
            android.graphics.Bitmap thumbnail = NativeImageDecoder.thumbnail(file, edge);
            JSObject result = new JSObject();
            if (thumbnail != null) {
                result.put("uri", saveTemporaryThumbnail(thumbnail, quality));
            }
            call.resolve(result);
        }, NativeExecutors.ioLimited());
    }

    @PluginMethod
    public void releaseThumbnail(PluginCall call) {
        runIo(call, () -> {
            Uri uri = Uri.parse(required(call, "uri", 4096));
            if (!"file".equals(uri.getScheme())) throw new IllegalArgumentException("缩略图位置无效");
            File file = new File(uri.getPath()).getCanonicalFile();
            File directory = new File(getContext().getCacheDir(), "srl-thumbnails").getCanonicalFile();
            if (!directory.equals(file.getParentFile()) || !file.getName().matches("[a-f0-9-]{36}\\.webp")) throw new IllegalArgumentException("缩略图位置无效");
            if (file.exists() && !file.delete()) throw new IllegalStateException("无法释放缩略图");
            call.resolve();
        });
    }


    private interface CheckedAction { void run() throws Exception; }
    private void runIo(PluginCall call, CheckedAction action) {
        runIo(call, action, NativeExecutors.ioSerial());
    }
    private void runIo(PluginCall call, CheckedAction action, java.util.concurrent.ExecutorService executor) {
        executor.execute(() -> { try { action.run(); } catch (Exception error) { call.reject(error.getMessage(), error); } });
    }
    private String required(PluginCall call, String key, int maxLength) {
        String value = call.getString(key);
        if (value == null || value.isBlank() || value.length() > maxLength) throw new IllegalArgumentException(key + " 无效");
        return value;
    }
}
