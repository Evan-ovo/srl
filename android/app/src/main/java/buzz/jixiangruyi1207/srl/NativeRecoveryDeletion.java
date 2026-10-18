package buzz.jixiangruyi1207.srl;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.HashSet;
import java.util.Set;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONObject;

/** Explicitly selected files only; reuse the existing GC reference/job/pending-write owner. */
final class NativeRecoveryDeletion {
    static JSONObject delete(File library, File jobs, JSONArray candidates, Set<String> protectedHashes) throws Exception {
        if (candidates.length() == 0 || candidates.length() > 100) throw new IllegalArgumentException("每批删除1至100个待找回原件");
        Set<String> hashes = new HashSet<>();
        Set<File> ignored = new HashSet<>();
        for (int i = 0; i < candidates.length(); i++) {
            JSONObject item = candidates.getJSONObject(i);
            String hash = item.getString("contentHash");
            if (!hash.matches("[a-f0-9]{64}") || !hashes.add(hash)) throw new IllegalArgumentException("待删除原件标识无效或重复");
            File object = object(library, hash);
            if (!object.getCanonicalFile().equals(object.getAbsoluteFile()) || !object.isFile()
                || object.length() != item.getLong("size") || object.lastModified() != item.getLong("modifiedAt"))
                throw new IllegalStateException("待找回原件已变化，请重新扫描后确认删除");
            if (protectedHashes.contains(hash)) continue;
            if (item.has("nativeId")) {
                String entry = item.getString("entry");
                if (!entry.matches("[A-Za-z0-9._-]{1,160}")) throw new IllegalArgumentException("原生索引目录无效");
                File directory = new File(new File(library.getCanonicalFile(), "current"), entry);
                File metadata = new File(directory, "resource.json");
                File[] files = directory.listFiles();
                if (!metadata.getCanonicalFile().equals(metadata.getAbsoluteFile()) || files == null || files.length != 1
                    || !metadata.isFile() || metadata.length() > 1024 * 1024) throw new IllegalStateException("原生索引无法完整核对，已保留原件");
                JSONObject record = new JSONObject(new String(Files.readAllBytes(metadata.toPath()), StandardCharsets.UTF_8));
                if (!item.getString("nativeId").equals(record.getString("id")) || !hash.equalsIgnoreCase(record.getString("contentHash"))
                    || item.getLong("size") != record.getLong("size")) throw new IllegalStateException("原生索引已变化，请重新扫描");
                ignored.add(metadata.getCanonicalFile());
            }
        }
        long bytes = NativeReplacedObjectCleanup.releaseUnreferenced(library, jobs, hashes, protectedHashes, ignored);
        JSONArray deleted = new JSONArray(), retained = new JSONArray();
        for (String hash : hashes) {
            if (object(library, hash).exists()) retained.put(hash);
            else deleted.put(hash);
        }
        for (File metadata : ignored) {
            JSONObject record = new JSONObject(new String(Files.readAllBytes(metadata.toPath()), StandardCharsets.UTF_8));
            if (!object(library, record.getString("contentHash")).exists()) {
                if (!metadata.delete()) throw new IllegalStateException("原件已删除，旧索引未能清除，请重新检查");
                metadata.getParentFile().delete(); // Only remove an empty, verified index directory.
            }
        }
        return new JSONObject().put("deletedHashes", deleted).put("retainedHashes", retained).put("clearedBytes", bytes);
    }

    private static File object(File library, String hash) throws Exception {
        String normalized = hash.toLowerCase(Locale.ROOT);
        return new File(new File(new File(library.getCanonicalFile(), "objects"), normalized.substring(0, 2)), normalized + ".bin");
    }
    private NativeRecoveryDeletion() {}
}
