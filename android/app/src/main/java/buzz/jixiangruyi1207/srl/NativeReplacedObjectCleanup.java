package buzz.jixiangruyi1207.srl;

import java.io.File;
import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/** Targeted post-commit GC. Unknown objects and unreadable references remain recoverable. */
final class NativeReplacedObjectCleanup {
    private NativeReplacedObjectCleanup() {}

    static long release(File library, File jobs, JSONArray records) throws Exception {
        return release(library, jobs, records, java.util.Collections.emptySet());
    }

    static long release(File library, File jobs, JSONArray records, Set<String> protectedHashes) throws Exception {
        Set<String> unused = new HashSet<>();
        for (int index = 0; index < records.length(); index++) {
            JSONObject record = records.getJSONObject(index);
            String expectedHash = record.getString("contentHash");
            long expectedSize = record.getLong("size");
            File metadata = new File(new File(new File(library.getCanonicalFile(), record.getString("scope")),
                record.optString("entry", record.getString("id"))), "resource.json");
            if (!metadata.getCanonicalFile().equals(metadata.getAbsoluteFile())) return 0;
            JSONObject committed = read(metadata);
            if (!record.getString("id").equals(committed.optString("id"))
                || !expectedHash.equalsIgnoreCase(committed.getString("contentHash"))
                || committed.getLong("size") != expectedSize) continue;
            File replacement = object(library, expectedHash);
            if (!replacement.isFile() || replacement.length() != expectedSize) continue;
            JSONArray candidates = record.getJSONArray("replacedHashes");
            for (int i = 0; i < candidates.length(); i++) {
                String hash = candidates.getString(i);
                if (!hash.matches("(?i)[a-f0-9]{64}")) throw new IllegalArgumentException("旧原件哈希无效");
                if (!hash.equalsIgnoreCase(expectedHash)) unused.add(hash.toLowerCase(Locale.ROOT));
            }
        }
        return releaseUnreferenced(library, jobs, unused, protectedHashes);
    }

    static long releaseUnreferenced(File library, File jobs, Set<String> candidates) throws Exception {
        return releaseUnreferenced(library, jobs, candidates, java.util.Collections.emptySet());
    }

    static long releaseUnreferenced(File library, File jobs, Set<String> candidates, Set<String> protectedHashes) throws Exception {
        return releaseUnreferenced(library, jobs, candidates, protectedHashes, java.util.Collections.emptySet());
    }

    /** Only explicit recovery deletion may ignore individually verified, unlinked current indexes. */
    static long releaseUnreferenced(File library, File jobs, Set<String> candidates, Set<String> protectedHashes,
                                   Set<File> ignoredMetadata) throws Exception {
        Set<String> unused = new HashSet<>(candidates);
        unused.removeAll(protectedHashes);
        for (String hash : unused) if (!hash.matches("[a-f0-9]{64}"))
            throw new IllegalArgumentException("原件哈希无效");
        // Superseded aliases can outlive their already reclaimed objects. Do not scan the library again.
        unused.removeIf(hash -> { try { return !object(library, hash).isFile(); } catch (Exception error) { return false; } });
        if (unused.isEmpty()) return 0;
        for (String scope : new String[] { "current", "versions" }) {
            File root = new File(library, scope);
            File[] entries = root.listFiles(File::isDirectory);
            if (entries == null && root.exists()) return 0;
            if (entries != null) for (File entry : entries) {
                File path = new File(entry, "resource.json");
                if (ignoredMetadata.contains(path.getCanonicalFile())) continue;
                JSONObject metadata = read(path);
                String hash = metadata.getString("contentHash").toLowerCase(Locale.ROOT);
                if (!hash.matches("[a-f0-9]{64}")) throw new IllegalStateException("原件引用无效，保留文件");
                unused.remove(hash);
                if (unused.isEmpty()) return 0;
            }
        }
        File[] jobRoots = jobs.listFiles(File::isDirectory);
        if (jobRoots == null && jobs.exists()) return 0;
        if (jobRoots != null) for (File root : jobRoots) {
            JSONObject job = NativeCloudTransferPlugin.readJob(root);
            String status = job.optString("status");
            if ("restore".equals(job.optString("kind"))) {
                if ("cancelled".equals(status)) continue;
                // Completed file downloads can still be waiting for foreground metadata import.
                JSONObject plan = NativeCloudTransferPlugin.readJob(new File(root, "restore-plan"));
                JSONArray resources = plan.getJSONArray("resources");
                for (int i = 0; i < resources.length(); i++) unused.remove(resources.getJSONObject(i).getString("hash").toLowerCase(Locale.ROOT));
                if (unused.isEmpty()) return 0;
                continue;
            }
            if ("completed".equals(status) || "cancelled".equals(status)) continue;
            // An incomplete plan may not have named its source objects yet.
            if ("staging".equals(status)) return 0;
            int count = NativeCloudJobStore.objectCount(job);
            for (int start = 0; start < count; start += 64) {
                for (JSONObject item : NativeCloudJobStore.readRange(root, job, start, 64)) {
                    JSONObject source = item.optJSONObject("source");
                    if (source == null) continue;
                    JSONArray segments = source.getJSONArray("segments");
                    for (int i = 0; i < segments.length(); i++)
                        unused.remove(segments.getJSONObject(i).getString("sourceHash").toLowerCase(Locale.ROOT));
                    if (unused.isEmpty()) return 0;
                }
            }
        }
        long cleared = 0;
        for (String hash : unused) {
            File file = object(library, hash);
            // Refuse links, including a linked prefix directory.
            if (!file.getCanonicalFile().equals(file.getAbsoluteFile())) continue;
            long bytes = file.length();
            if (file.isFile() && file.delete()) {
                cleared += bytes;
                file.getParentFile().delete(); // Only succeeds when the prefix is empty.
            }
        }
        return cleared;
    }

    private static File object(File root, String hash) throws Exception {
        String normalized = hash.toLowerCase(Locale.ROOT);
        return new File(new File(new File(root.getCanonicalFile(), "objects"), normalized.substring(0, 2)), normalized + ".bin");
    }

    // Recovery deletion shares this bounded reader on all supported Android API levels.
    static JSONObject read(File file) throws Exception {
        if (!file.isFile() || file.length() > 1024 * 1024)
            throw new IllegalStateException("原件引用无法完整核对，保留旧文件");
        byte[] bytes = new byte[(int) file.length()];
        try (FileInputStream input = new FileInputStream(file)) {
            int offset = 0;
            while (offset < bytes.length) {
                int read = input.read(bytes, offset, bytes.length - offset);
                if (read < 0) throw new IllegalStateException("原件引用读取不完整，保留文件");
                offset += read;
            }
        }
        return new JSONObject(new String(bytes, StandardCharsets.UTF_8));
    }
}
