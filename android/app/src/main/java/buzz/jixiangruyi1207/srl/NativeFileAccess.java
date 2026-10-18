package buzz.jixiangruyi1207.srl;

import android.content.Context;
import android.net.Uri;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.security.MessageDigest;
import java.util.Locale;

/** Only committed library/database objects and import files may be exposed to bridge operations. */
final class NativeFileAccess {
    interface Progress { void update(long readBytes, long totalBytes) throws Exception; }

    static boolean hasOfficialAppFiles(File filesDir, String[] paths, long[] sizes) throws IOException {
        if (paths == null || sizes == null || paths.length != sizes.length || paths.length > 100)
            throw new IOException("APP 文件清单无效");
        for (int index = 0; index < paths.length; index++) {
            if (paths[index] == null || !paths[index].matches("/assets/[A-Za-z0-9_.-]+")
                || paths[index].contains("..") || sizes[index] < 0)
                throw new IOException("APP 文件清单无效");
        }
        File data = filesDir.getCanonicalFile();
        File root = new File(data, "official-apps/assets").getCanonicalFile();
        if (!root.getPath().startsWith(data.getPath() + File.separator))
            throw new IOException("APP 文件位置无效");
        for (int index = 0; index < paths.length; index++) {
            File file = new File(root, paths[index].substring("/assets/".length())).getCanonicalFile();
            if (!root.equals(file.getParentFile())) throw new IOException("APP 文件位置无效");
            if (!file.isFile() || file.length() != sizes[index]) return false;
        }
        return true;
    }

    static File resolve(Context context, String value) throws Exception {
        if (value == null) throw new IOException("缺少原生文件位置");
        Uri uri = Uri.parse(value);
        if (uri.getScheme() != null && !"file".equals(uri.getScheme())) throw new IOException("不支持的原生文件位置");
        return resolve(context.getFilesDir(), context.getCacheDir(), NativeLibraryPlugin.libraryRoot(context),
            new File(uri.getScheme() == null ? value : uri.getPath()));
    }

    static File resolve(File filesDir, File cacheDir, File libraryRoot, File requested) throws IOException {
        File file = requested.getCanonicalFile();
        File blob = resolveDatabaseObject(filesDir, file);
        if (blob != null) return blob;
        File taskRoot = new File(filesDir, "srl-archive-tasks").getCanonicalFile();
        if(taskRoot.equals(file.getParentFile()) && file.isFile() && file.getName().matches("[0-9a-f]{8}-[0-9a-f-]{27}\\.source")) return file;
        File[] roots = {
            new File(libraryRoot, "objects"),
            new File(filesDir, "srl-shared-intake"),
            new File(filesDir, "srl-archive-jobs"),
            new File(cacheDir, "picked-images")
        };
        for (File root : roots) {
            if (file.getPath().startsWith(root.getCanonicalPath() + File.separator) && file.isFile()) return file;
        }
        throw new IOException("文件不属于资源库原件或导入暂存目录");
    }

    private static File resolveDatabaseObject(File filesDir, File file) throws IOException {
        File data = filesDir.getCanonicalFile();
        File blobs = new File(data, "srl-app-data/blobs").getCanonicalFile();
        String prefix = blobs.getPath() + File.separator;
        if (!file.getPath().startsWith(prefix)) return null;
        String relative = file.getPath().substring(prefix.length()).replace(File.separatorChar, '/');
        if (blobs.getPath().startsWith(data.getPath() + File.separator)
                && relative.matches("[a-f0-9]{2}/[a-f0-9]{64}\\.bin")
                && relative.substring(0, 2).equals(relative.substring(3, 5)) && file.isFile()) return file;
        throw new IOException("原生二进制附件位置无效");
    }

    /** Images reuse the blob boundary without initializing the external library. */
    static File resolveImage(Context context, String value) throws Exception {
        if (value == null) throw new IOException("缺少原生文件位置");
        Uri uri = Uri.parse(value);
        if ("file".equals(uri.getScheme())) {
            File blob = resolveDatabaseObject(context.getFilesDir(), new File(uri.getPath()).getCanonicalFile());
            if (blob != null) return blob;
        }
        return resolve(context, value);
    }

    static String hash(File file) throws Exception {
        return hash(file, (readBytes, totalBytes) -> {});
    }

    static String hash(File file, Progress progress) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[256 * 1024];
        long readBytes = 0L;
        long totalBytes = file.length();
        try (FileInputStream input = new FileInputStream(file)) {
            int count;
            while ((count = input.read(buffer)) != -1) {
                digest.update(buffer, 0, count);
                readBytes += count;
                progress.update(readBytes, totalBytes);
            }
        }
        StringBuilder hex = new StringBuilder(64);
        for (byte value : digest.digest()) hex.append(String.format(Locale.ROOT, "%02x", value));
        return hex.toString();
    }
}
