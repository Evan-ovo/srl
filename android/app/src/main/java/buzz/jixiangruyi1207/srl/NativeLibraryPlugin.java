package buzz.jixiangruyi1207.srl;

import android.content.Context;
import android.net.Uri;
import android.os.Environment;
import android.os.StatFs;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.json.JSONObject;

/**
 * 把 Vue 资源原件分块镜像到 Android 应用专属 Documents/SRL 目录。
 *
 * IndexedDB 仍负责现有事务和索引；该目录提供原生文件副本与可审计清单。分块桥接
 * 避免把整份大文件一次性转成 Base64。启用网页本地保险库时由前端主动清空明文镜像。
 */
@CapacitorPlugin(name = "NativeLibrary")
public class NativeLibraryPlugin extends Plugin {
    private static final long MAX_FILE_BYTES = 8L * 1024L * 1024L * 1024L * 1024L;
    private static final int MAX_CHUNK_BYTES = 1024 * 1024;
    private static final long STALE_PENDING_MS = 24L * 60L * 60L * 1000L;
    private static final Set<String> CANCELLED_HASHES = ConcurrentHashMap.newKeySet();
    private final ConcurrentHashMap<String, PendingWrite> pendingWrites = new ConcurrentHashMap<>();

    @PluginMethod
    public void hasOfficialAppFiles(PluginCall call) {
        runIo(call, () -> {
            com.getcapacitor.JSArray files = call.getArray("files");
            if (files == null || files.length() > 100) throw new IllegalArgumentException("APP 文件清单无效");
            String[] paths = new String[files.length()];
            long[] sizes = new long[files.length()];
            for (int index = 0; index < files.length(); index++) {
                org.json.JSONObject file = files.getJSONObject(index);
                paths[index] = file.getString("path");
                sizes[index] = NativeBridgeNumber.bounded(file.opt("size"), 0L, MAX_FILE_BYTES, "APP 文件大小无效");
            }
            JSObject result = new JSObject();
            result.put("ready", NativeFileAccess.hasOfficialAppFiles(getContext().getFilesDir(), paths, sizes));
            call.resolve(result);
        });
    }

    @PluginMethod
    public void hashFile(PluginCall call) {
        runIo(call, () -> {
            String requestId = call.getString("requestId", "");
            if (!requestId.matches("[a-f0-9-]{36}")) throw new IllegalArgumentException("原生文件校验请求无效");
            try {
                if (CANCELLED_HASHES.contains(requestId)) throw new java.io.IOException("已停止备份识别");
                File file = NativeFileAccess.resolve(getContext(), call.getString("uri"));
                NativeBridgeNumber.matchingFileSize(
                    call.getData().opt("size"), file.length(), MAX_FILE_BYTES,
                    "原生文件大小无效", "原生文件大小已变化"
                );
                JSObject result = new JSObject();
                result.put("hash", NativeFileAccess.hash(file, (readBytes, totalBytes) -> {
                    if (CANCELLED_HASHES.contains(requestId)) throw new java.io.IOException("已停止备份识别");
                }));
                call.resolve(result);
            } finally {
                CANCELLED_HASHES.remove(requestId);
            }
        });
    }

    @PluginMethod
    public void cancelHashFile(PluginCall call) {
        String requestId = call.getString("requestId", "");
        if (requestId.matches("[a-f0-9-]{36}")) CANCELLED_HASHES.add(requestId);
        call.resolve();
    }

    @PluginMethod
    public void appendFile(PluginCall call) {
        runIo(call, () -> {
            PendingWrite write = pending(call.getString("token"));
            File source = NativeFileAccess.resolve(getContext(), call.getString("uri"));
            synchronized (write) {
                if (write.written != 0 || source.length() != write.expectedSize) throw new IllegalStateException("原生文件大小或写入位置不一致");
                byte[] buffer = new byte[256 * 1024];
                try (FileInputStream input = new FileInputStream(source)) {
                    int count;
                    while ((count = input.read(buffer)) != -1) {
                        if (write.written + count > write.expectedSize) throw new IllegalStateException("原生文件大小已变化");
                        write.output.write(buffer, 0, count);
                        write.digest.update(buffer, 0, count);
                        write.written += count;
                    }
                }
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void getStorageInfo(PluginCall call) {
        runIo(call, () -> {
            File root = libraryRoot();
            JSObject result = new JSObject();
            result.put("storageVersion", hasLegacyEntries(new File(root, "current")) || hasLegacyEntries(new File(root, "versions")) ? 1 : 4);
            result.put("path", root.getAbsolutePath());
            result.put("recoveryMetadataVersion", 1);
            result.put("recoveryDeletionVersion", 1);
            result.put("supportsRetiredTranslationModelCleanup", true);
            result.put("currentCount", countEntries(new File(root, "current")));
            result.put("versionCount", countEntries(new File(root, "versions")));
            result.put("currentManifestHash", manifestHash(new File(root, "current")));
            result.put("versionManifestHash", manifestHash(new File(root, "versions")));
            if (Boolean.FALSE.equals(call.getBoolean("includeUsage", true))) {
                call.resolve(result);
                return;
            }
            File appData = getContext().getDataDir();
            File externalData = getContext().getExternalFilesDir(null);
            File cache = getContext().getCacheDir();
            File codeCache = getContext().getCodeCacheDir();
            long appDataBytes = directoryBytes(appData);
            long externalDataBytes = externalData == null ? 0L : directoryBytes(externalData);
            long appCacheBytes = directoryBytes(cache);
            long codeCacheBytes = directoryBytes(codeCache);
            result.put("objectCount", countObjectFiles(new File(root, "objects")));
            result.put("objectBytes", countObjectBytes(new File(root, "objects")));
            result.put("appDataBytes", appDataBytes);
            result.put("externalDataBytes", externalDataBytes);
            result.put("totalBytes", appDataBytes + externalDataBytes);
            // Named subsets, not additive peers of totalBytes/objectBytes.
            NativeWebViewStorageUsage webView = NativeWebViewStorageUsage.measure(new File(appData, "app_webview"));
            result.put("webViewBytes", webView.totalBytes());
            JSObject webViewBreakdown = new JSObject();
            webViewBreakdown.put("siteDataBytes", webView.siteDataBytes);
            webViewBreakdown.put("cacheBytes", webView.cacheBytes);
            webViewBreakdown.put("temporaryBlobBytes", webView.temporaryBlobBytes);
            webViewBreakdown.put("otherBytes", webView.otherBytes);
            result.put("webViewBreakdown", webViewBreakdown);
            result.put("cacheBytes", appCacheBytes + codeCacheBytes);
            result.put("appCacheBytes", appCacheBytes);
            result.put("codeCacheBytes", codeCacheBytes);
            // Full SQL/directory diagnostics are manual; ordinary status refreshes keep their existing cost.
            if (Boolean.TRUE.equals(call.getBoolean("includeDetails", false))) {
                File files = getContext().getFilesDir();
                long filesBytes = directoryBytes(files);
                long databaseBytes = directoryBytes(getContext().getDatabasePath(NativeAppDatabase.DATABASE_NAME).getParentFile());
                long preferencesBytes = directoryBytes(new File(appData, "shared_prefs"));
                long noBackupBytes = directoryBytes(getContext().getNoBackupFilesDir());
                JSObject internal = new JSObject();
                internal.put("filesBytes", filesBytes);
                internal.put("databaseBytes", databaseBytes);
                internal.put("preferencesBytes", preferencesBytes);
                internal.put("noBackupBytes", noBackupBytes);
                // WorkManager owns a separate database in Android's no-backup directory.
                JSObject noBackup = new JSObject();
                long workBytes = 0L;
                for (String suffix : new String[] {"", "-wal", "-shm"}) {
                    long bytes = new File(getContext().getNoBackupFilesDir(), "androidx.work.workdb" + suffix).length();
                    noBackup.put(suffix.isEmpty() ? "databaseBytes" : suffix.equals("-wal") ? "walBytes" : "shmBytes", bytes);
                    workBytes += bytes;
                }
                noBackup.put("otherBytes", Math.max(0L, noBackupBytes - workBytes));
                org.json.JSONArray otherEntries = new org.json.JSONArray();
                File[] otherChildren = getContext().getNoBackupFilesDir().listFiles();
                if (otherChildren != null) for (File child : otherChildren) {
                    if (child.getName().equals("androidx.work.workdb") || child.getName().equals("androidx.work.workdb-wal")
                        || child.getName().equals("androidx.work.workdb-shm") || otherEntries.length() >= 64) continue;
                    String name = child.getName();
                    // Keep diagnostics local and omit opaque identifiers or arbitrary user filenames.
                    if (!name.matches("[A-Za-z0-9_.-]{1,80}") || name.matches("[A-Za-z0-9_-]{24,}"))
                        name = "未分类项" + otherEntries.length();
                    otherEntries.put(new JSONObject().put("name", name).put("bytes", directoryBytes(child))
                        .put("directory", child.isDirectory()));
                }
                noBackup.put("otherEntries", otherEntries);
                internal.put("noBackupBreakdown", noBackup);
                internal.put("otherBytes", Math.max(0L, appDataBytes - filesBytes - databaseBytes - preferencesBytes
                    - noBackupBytes - webView.totalBytes() - appCacheBytes - codeCacheBytes));
                // These are subsets of filesBytes, not additional storage.
                JSObject fileGroups = new JSObject();
                long knownFileBytes = 0L;
                for (String name : new String[] {"srl-app-data", "official-apps", "srl-shared-intake", "srl-cloud-jobs",
                    "srl-export-jobs", "srl-archive-jobs", "srl-archive-tasks", "srl-character-card-parser"}) {
                    long bytes = directoryBytes(new File(files, name));
                    fileGroups.put(name, bytes); knownFileBytes += bytes;
                }
                fileGroups.put("other", Math.max(0L, filesBytes - knownFileBytes));
                internal.put("blobFilesBytes", directoryBytes(new File(files, "srl-app-data/blobs")));
                internal.put("pendingBlobFilesBytes", directoryBytes(new File(files, "srl-app-data/pending")));
                internal.put("fileGroups", fileGroups);
                result.put("internalBreakdown", internal);
                try {
                    JSONObject database = NativeAppDatabase.storageUsage(getContext().getDatabasePath(NativeAppDatabase.DATABASE_NAME));
                    if (database != null) result.put("nativeDatabase", database);
                } catch (Exception unavailable) {
                    result.put("nativeDatabaseUnavailable", true);
                }
            }
            result.put("libraryBytes", directoryBytes(root));
            result.put("restoreTemporaryBytes", directoryBytes(new File(root, ".restore-pending"))
                + directoryBytes(new File(getContext().getFilesDir(), "srl-archive-jobs")));
            result.put("writeTemporaryBytes", directoryBytes(new File(root, ".pending"))
                + directoryBytes(new File(getContext().getFilesDir(), "srl-export-jobs"))
                + directoryBytes(new File(getContext().getFilesDir(), "srl-archive-tasks")));
            result.put("availableBytes", availableBytes(appData, externalData));
            call.resolve(result);
        });
    }

    /**
     * 只读分页扫描两类可恢复内容：
     * 1) Android current 索引仍在、但 IndexedDB 当前资源 ID 已缺失的条目；
     * 2) 完全没有 current/versions 原生索引引用的内容寻址对象。
     *
     * 第一类保留原 ID/文件名线索，避免数据库崩溃后启动同步把最后的元数据擦掉。
     * 这里不删除、不移动文件，也不把历史版本自动提升为当前资源。
     */
    @PluginMethod
    public void listRecoveryCandidates(PluginCall call) {
        runIo(call, () -> {
            int limit = Math.max(1, Math.min(200, call.getInt("limit", 100)));
            com.getcapacitor.JSArray currentIds = call.getArray("currentIds");
            if (currentIds == null || currentIds.length() > 50_000) {
                throw new IllegalArgumentException("当前资源 ID 清单无效");
            }
            Set<String> knownCurrent = jsonStringSet(currentIds);
            String[] cursor = call.getString("cursor", "current||0").split("\\|", -1);
            if (cursor.length != 3 || !("current".equals(cursor[0]) || "objects".equals(cursor[0]))) {
                throw new IllegalArgumentException("原件找回游标无效");
            }
            String phase = cursor[0];
            String after = cursor[1];
            long scanned;
            try { scanned = Math.max(0L, Long.parseLong(cursor[2])); }
            catch (NumberFormatException invalid) { throw new IllegalArgumentException("原件找回游标无效"); }
            com.getcapacitor.JSArray candidates = new com.getcapacitor.JSArray();
            String last = after;

            File currentRoot = new File(libraryRoot(), "current");
            if ("current".equals(phase)) {
              File[] indexedEntries = currentRoot.listFiles(File::isDirectory);
              if (indexedEntries != null) {
                java.util.Arrays.sort(indexedEntries, (left, right) -> left.getName().compareTo(right.getName()));
                for (File entry : indexedEntries) {
                    if (entry.getName().compareTo(after) <= 0) continue;
                    scanned++;
                    JSObject metadata = readJson(new File(entry, "resource.json"));
                    if (metadata == null) continue;
                    String id = metadata.optString("id", "");
                    if (id.isBlank() || knownCurrent.contains(id)) continue;
                    String hash = metadata.optString("contentHash", "").toLowerCase(Locale.ROOT);
                    long size = metadata.optLong("size", -1L);
                    if (!hash.matches("[a-f0-9]{64}") || size < 0 || size > MAX_FILE_BYTES) continue;
                    File object = objectFile(hash);
                    if (!object.isFile() || object.length() != size) continue;
                    JSObject item = new JSObject();
                    item.put("contentHash", hash);
                    item.put("size", size);
                    item.put("modifiedAt", object.lastModified());
                    item.put("nativeId", id);
                    item.put("nativeScope", "current");
                    String fileName = metadata.optString("fileName", "");
                    if (!fileName.isBlank()) item.put("fileName", fileName);
                    candidates.put(item);
                    last = entry.getName();
                    if (candidates.length() == limit) {
                        JSObject result = new JSObject();
                        result.put("candidates", candidates);
                        result.put("scanned", scanned);
                        result.put("nextCursor", "current|" + last + "|" + scanned);
                        call.resolve(result);
                        return;
                    }
                }
              }
              phase = "objects";
              after = "";
            }

            Set<String> referenced = new HashSet<>();
            collectReferencedHashes(currentRoot, referenced);
            collectReferencedHashes(new File(libraryRoot(), "versions"), referenced);
            File[] prefixes = new File(libraryRoot(), "objects").listFiles(File::isDirectory);
            if (prefixes != null) {
              java.util.Arrays.sort(prefixes, (left, right) -> left.getName().compareTo(right.getName()));
              for (File prefix : prefixes) {
                File[] objects = prefix.listFiles(File::isFile);
                if (objects == null) continue;
                java.util.Arrays.sort(objects, (left, right) -> left.getName().compareTo(right.getName()));
                for (File object : objects) {
                    String name = object.getName();
                    if (!name.matches("(?i)[a-f0-9]{64}\\.bin")) continue;
                    String hash = name.substring(0, 64).toLowerCase(Locale.ROOT);
                    if (hash.compareTo(after) <= 0) continue;
                    scanned++;
                    last = hash;
                    if (referenced.contains(hash)) continue;
                    JSObject item = new JSObject();
                    item.put("contentHash", hash);
                    item.put("size", object.length());
                    item.put("modifiedAt", object.lastModified());
                    candidates.put(item);
                    if (candidates.length() == limit) {
                        JSObject result = new JSObject();
                        result.put("candidates", candidates);
                        result.put("scanned", scanned);
                        result.put("nextCursor", "objects|" + last + "|" + scanned);
                        call.resolve(result);
                        return;
                    }
                }
              }
            }
            JSObject result = new JSObject();
            result.put("candidates", candidates);
            result.put("scanned", scanned);
            call.resolve(result);
        });
    }

    /** Read one candidate's bounded metadata; only an explicit recovery re-hashes its original. */
    @PluginMethod
    public void inspectRecoveryObject(PluginCall call) {
        runIo(call, () -> {
            String hash = requiredHash(call.getString("contentHash"));
            long size = NativeBridgeNumber.bounded(call.getData().opt("size"), 0L, MAX_FILE_BYTES, "找回原件大小无效");
            call.resolve(NativeRecoveryMetadata.inspect(
                objectFile(hash), hash, size, call.getBoolean("verify", true)
            ));
        });
    }

    /** 返回已经按内容哈希校验落盘的应用私有文件；不通过 JS/Base64 复制内容。 */
    @PluginMethod
    public void getObjectPath(PluginCall call) {
        runIo(call, () -> {
            String contentHash = requiredHash(call.getString("contentHash"));
            long expectedSize = NativeBridgeNumber.bounded(
                call.getData().opt("size"),
                0L,
                MAX_FILE_BYTES,
                "原生资源大小无效"
            );
            File object = objectFile(contentHash);
            if (!object.isFile() || object.length() != expectedSize) {
                throw new IllegalStateException("Android 原生资源不存在或大小不一致");
            }
            JSObject result = new JSObject();
            result.put("path", Uri.fromFile(object).toString());
            result.put("size", object.length());
            call.resolve(result);
        });
    }

    /** Native version judgement for an unlocked IndexedDB catalog when its plaintext mirror is absent. */
    @PluginMethod
    public void matchCharacterCardCandidates(PluginCall call) {
        runIo(call, () -> {
            org.json.JSONObject parsed = call.getData().getJSONObject("parsedResource");
            com.getcapacitor.JSArray rows = call.getArray("candidates");
            if (rows == null || rows.length() > 200) throw new IllegalArgumentException("角色卡候选数量无效");
            JSObject result = new JSObject();
            result.put("candidates", NativeCharacterCardProcessor.matchParsedResource(
                parsed, required(call, "fileName", 240), new org.json.JSONArray(rows.toString()),
                call.getBoolean("sameNameCandidates", false)
            ));
            call.resolve(result);
        });
    }

    /** Begin a bounded temporary stream for native parsing of APK file-picker imports. */
    @PluginMethod
    public void beginCharacterCardParse(PluginCall call) {
        runIo(call, () -> {
            required(call, "fileName", 240);
            long size = NativeBridgeNumber.bounded(call.getData().opt("size"), 0L, MAX_FILE_BYTES, "角色卡文件大小无效");
            File root = characterCardParserRoot();
            cleanupStaleCharacterCardParserFiles(root);
            String token = UUID.randomUUID().toString();
            File input = new File(root, token + ".part");
            if (!input.createNewFile()) throw new IllegalStateException("无法创建原生解析暂存文件");
            JSObject result = new JSObject();
            result.put("token", token);
            result.put("size", size);
            call.resolve(result);
        });
    }

    /** Append one bounded chunk; the complete file is never materialized in the JS bridge. */
    @PluginMethod
    public void appendCharacterCardParse(PluginCall call) {
        runIo(call, () -> {
            String token = parserToken(call.getString("token"));
            long expected = NativeBridgeNumber.bounded(call.getData().opt("size"), 0L, MAX_FILE_BYTES, "角色卡文件大小无效");
            byte[] bytes = Base64.decode(required(call, "data", 1_400_000), Base64.NO_WRAP);
            if (bytes.length > 1024 * 1024) throw new IllegalArgumentException("角色卡解析分块超过 1 MiB");
            File input = new File(characterCardParserRoot(), token + ".part");
            if (!input.isFile() || input.length() + bytes.length > expected) throw new IllegalStateException("原生解析暂存文件大小不一致");
            try (FileOutputStream output = new FileOutputStream(input, true)) { output.write(bytes); }
            call.resolve();
        });
    }

    /** Parse a staged file on-device and retain only the small parsed sidecar until JS reads it. */
    @PluginMethod
    public void finishCharacterCardParse(PluginCall call) {
        runIo(call, () -> {
            String token = parserToken(call.getString("token"));
            String fileName = required(call, "fileName", 240);
            long expected = NativeBridgeNumber.bounded(call.getData().opt("size"), 0L, MAX_FILE_BYTES, "角色卡文件大小无效");
            File root = characterCardParserRoot();
            File input = new File(root, token + ".part");
            if (!input.isFile() || input.length() != expected) throw new IllegalStateException("原生解析暂存文件未完整写入");
            JSONObject parsed = NativeCharacterCardProcessor.parseOnly(input, fileName, new File(root, token + ".parsed.json"));
            input.delete();
            if (!"parsed".equals(parsed.optString("state"))) new File(root, token + ".parsed.json").delete();
            JSObject result = new JSObject();
            result.put("state", parsed.optString("state"));
            if (parsed.has("parsedResourceUri")) result.put("parsedResourceUri", parsed.optString("parsedResourceUri"));
            result.put("token", token);
            call.resolve(result);
        });
    }

    /** Parse an existing app-private shared file without copying its bytes through JS. */
    @PluginMethod
    public void parseCharacterCardUri(PluginCall call) {
        runIo(call, () -> {
            String fileName = required(call, "fileName", 240);
            File input = NativeFileAccess.resolve(getContext(), call.getString("uri"));
            File root = characterCardParserRoot();
            cleanupStaleCharacterCardParserFiles(root);
            String token = UUID.randomUUID().toString();
            JSONObject parsed = NativeCharacterCardProcessor.parseOnly(input, fileName,
                new File(root, token + ".parsed.json"));
            JSObject result = new JSObject();
            result.put("state", parsed.optString("state"));
            if ("parsed".equals(parsed.optString("state"))) {
                result.put("parsedResourceUri", parsed.optString("parsedResourceUri"));
                result.put("token", token);
            } else new File(root, token + ".parsed.json").delete();
            call.resolve(result);
        });
    }

    @PluginMethod
    public void cleanupCharacterCardParse(PluginCall call) {
        runIo(call, () -> {
            String token = parserToken(call.getString("token"));
            File root = characterCardParserRoot();
            new File(root, token + ".part").delete();
            new File(root, token + ".parsed.json").delete();
            call.resolve();
        });
    }

    private File characterCardParserRoot() {
        File root = new File(getContext().getFilesDir(), "srl-character-card-parser");
        if (!root.exists() && !root.mkdirs()) throw new IllegalStateException("无法创建角色卡解析目录");
        return root;
    }

    private void cleanupStaleCharacterCardParserFiles(File root) {
        File[] stale = root.listFiles(File::isFile);
        long cutoff = System.currentTimeMillis() - 24L * 60L * 60L * 1000L;
        if (stale != null) for (File file : stale) {
            if (file.getName().matches("[a-f0-9-]{36}\\.(?:part|parsed\\.json)") && file.lastModified() < cutoff) file.delete();
        }
    }

    private String parserToken(String value) {
        if (value == null || !value.matches("[a-f0-9-]{36}")) throw new IllegalArgumentException("角色卡解析令牌无效");
        return value;
    }

    /** 用已存在的内容寻址对象补齐 NativeLibrary 资源索引，不读取或复制原件。 */
    @PluginMethod
    public void linkObjects(PluginCall call) {
        runIo(call, () -> {
            com.getcapacitor.JSArray records = call.getArray("records");
            if (records == null || records.length() > 50_000) {
                throw new IllegalArgumentException("原生资源引用数量无效");
            }
            int linked = 0;
            com.getcapacitor.JSArray replacements = new com.getcapacitor.JSArray();
            for (int index = 0; index < records.length(); index++) {
                org.json.JSONObject record = records.getJSONObject(index);
                String scope = scope(record.optString("scope", ""));
                String id = record.optString("id", "");
                String requestedFileName = record.optString("fileName", "");
                if (id.isBlank() || id.length() > 200) throw new IllegalArgumentException("资源 ID 无效");
                if (requestedFileName.isBlank() || requestedFileName.length() > 240) {
                    throw new IllegalArgumentException("资源文件名无效");
                }
                String fileName = safeFileName(requestedFileName);
                String contentHash = requiredHash(record.optString("contentHash", ""));
                long size = record.optLong("size", -1L);
                if (size < 0 || size > MAX_FILE_BYTES) throw new IllegalArgumentException("资源文件大小无效");
                File object = objectFile(contentHash);
                if (!object.isFile() || object.length() != size) {
                    throw new IllegalStateException("原生恢复对象尚未完整落盘");
                }
                File entry = entryDirectory(scope, id);
                JSObject previous = readJson(new File(entry, "resource.json"));
                String previousHash = previous == null ? "" : previous.optString("contentHash", "");
                if (previousHash.matches("(?i)[a-f0-9]{64}") && !previousHash.equalsIgnoreCase(contentHash)) {
                    JSONObject replacement = new JSONObject();
                    replacement.put("scope", scope);
                    replacement.put("id", id);
                    replacement.put("contentHash", contentHash);
                    replacement.put("size", size);
                    replacement.put("replacedHashes", new org.json.JSONArray().put(previousHash));
                    replacements.put(replacement);
                }
                if (!entry.exists() && !entry.mkdirs()) throw new IllegalStateException("无法创建原生资源目录");
                writeMetadata(
                    new File(entry, "resource.json"), id, scope, fileName,
                    record.optString("mimeType", "application/octet-stream"),
                    record.optString("resourceType", "other"),
                    record.optBoolean("hiddenFromDocuments", false), contentHash, size,
                    record.optLong("updatedAt", System.currentTimeMillis())
                );
                linked++;
            }
            JSObject result = new JSObject();
            result.put("linked", linked);
            result.put("replacements", replacements);
            call.resolve(result);
        });
    }

    /**
     * 在释放 IndexedDB 镜像前逐项核验原生索引、大小与 SHA-256。任何一项不成立就
     * 整批拒绝，调用方必须保留网页副本；这个 API 本身从不删除或迁移文件。
     */
    @PluginMethod
    public void verifyLinkedObjects(PluginCall call) {
        runIo(call, () -> {
            com.getcapacitor.JSArray records = call.getArray("records");
            if (records == null || records.length() > 200) {
                throw new IllegalArgumentException("原生镜像核验数量无效");
            }
            for (int index = 0; index < records.length(); index++) {
                org.json.JSONObject record = records.getJSONObject(index);
                String scope = scope(record.optString("scope", ""));
                String id = record.optString("id", "");
                if (id.isBlank() || id.length() > 200) {
                    throw new IllegalArgumentException("资源 ID 无效");
                }
                String contentHash = requiredHash(record.optString("contentHash", ""));
                long size = record.optLong("size", -1L);
                if (size < 0 || size > MAX_FILE_BYTES) {
                    throw new IllegalArgumentException("原生镜像大小无效");
                }
                JSObject metadata = readJson(new File(entryDirectory(scope, id), "resource.json"));
                if (metadata == null
                    || !contentHash.equalsIgnoreCase(metadata.optString("contentHash", ""))
                    || metadata.optLong("size", -1L) != size
                    || !NativeCloudRestoreTransport.verifyFile(objectFile(contentHash), contentHash, size)) {
                    throw new IllegalStateException("原生镜像索引或原件校验失败，已保留网页副本");
                }
            }
            JSObject result = new JSObject();
            result.put("verified", records.length());
            call.resolve(result);
        });
    }

    /**
     * 只撤掉陈旧的 current/versions 索引元数据，不执行对象垃圾回收。
     * 用于“数据库已有同内容资源，但崩溃前旧 ID 仍残留”的找回收尾。
     */
    @PluginMethod
    public void unlinkEntries(PluginCall call) {
        runIo(call, () -> {
            com.getcapacitor.JSArray records = call.getArray("records");
            if (records == null || records.length() > 50_000) {
                throw new IllegalArgumentException("原生资源撤链数量无效");
            }
            int removed = 0;
            for (int index = 0; index < records.length(); index++) {
                org.json.JSONObject record = records.getJSONObject(index);
                String scope = scope(record.optString("scope", ""));
                String id = record.optString("id", "");
                if (id.isBlank() || id.length() > 200) {
                    throw new IllegalArgumentException("资源 ID 无效");
                }
                String contentHash = requiredHash(record.optString("contentHash", ""));
                File entry = entryDirectory(scope, id);
                JSObject metadata = readJson(new File(entry, "resource.json"));
                if (metadata == null) continue;
                if (!contentHash.equalsIgnoreCase(metadata.optString("contentHash", ""))) {
                    throw new IllegalStateException("陈旧原生索引已变化，停止撤链");
                }
                deleteRecursively(entry);
                removed++;
            }
            JSObject result = new JSObject();
            result.put("removed", removed);
            call.resolve(result);
        });
    }

    /** 只对账索引；记录缺失不证明原件可以删除，孤立原件留给恢复入口。 */
    @PluginMethod
    public void reconcileEntries(PluginCall call) {
        runIo(call, () -> {
            com.getcapacitor.JSArray currentIds = call.getArray("currentIds");
            com.getcapacitor.JSArray versionIds = call.getArray("versionIds");
            if (currentIds == null || versionIds == null ||
                currentIds.length() > 50_000 || versionIds.length() > 200_000) {
                throw new IllegalArgumentException("原生资源对账 ID 数量无效");
            }
            Set<String> expectedCurrent = jsonStringSet(currentIds);
            Set<String> expectedVersions = jsonStringSet(versionIds);
            int removedCurrent = removeStaleEntries(new File(libraryRoot(), "current"), expectedCurrent);
            int removedVersions = removeStaleEntries(new File(libraryRoot(), "versions"), expectedVersions);
            JSObject result = new JSObject();
            result.put("removedCurrent", removedCurrent);
            result.put("removedVersions", removedVersions);
            call.resolve(result);
        });
    }

    /**
     * Android 明确定义 cache/code_cache 为可丢弃缓存。手动触发时清空其内容，但保留目录本身；
     * 不会触及 app_webview、IndexedDB、原件目录或 external files。用户应在没有活跃上传、下载
     * 或导入任务时执行，避免中断仅存在缓存目录中的临时传输文件。
     * 显式 retiredTranslationModels 范围仅删除已停用的 ML Kit 翻译模型，不清理上述缓存。
     */
    @PluginMethod
    public void clearTemporaryCaches(PluginCall call) {
        runIo(call, () -> {
            String cleanupScope = call.getString("scope");
            long clearedBytes;
            if ("retiredTranslationModels".equals(cleanupScope)) {
                clearedBytes = clearRetiredTranslationModels(getContext().getNoBackupFilesDir());
            } else if (cleanupScope == null) {
                File cache = getContext().getCacheDir();
                File codeCache = getContext().getCodeCacheDir();
                clearedBytes = clearDirectoryContents(cache) + clearDirectoryContents(codeCache);
            } else {
                throw new IllegalArgumentException("未知清理范围，未删除文件");
            }
            JSObject result = new JSObject();
            result.put("clearedBytes", clearedBytes);
            call.resolve(result);
        });
    }

    @PluginMethod
    public void beginWrite(PluginCall call) {
        runIo(call, () -> {
            String scope = scope(call.getString("scope"));
            String id = required(call, "id", 200);
            String fileName = safeFileName(required(call, "fileName", 240));
            String contentHash = requiredHash(call.getString("contentHash"));
            long size = NativeBridgeNumber.bounded(
                call.getData().opt("size"),
                0L,
                MAX_FILE_BYTES,
                "资源文件大小无效（允许范围 0–8 TiB）"
            );
            long updatedAt = NativeBridgeNumber.boundedOrDefault(
                call.getData().opt("updatedAt"),
                System.currentTimeMillis(),
                0L,
                NativeBridgeNumber.MAX_SAFE_INTEGER,
                "资源更新时间无效"
            );
            String mimeType = call.getString("mimeType", "application/octet-stream");
            String resourceType = call.getString("resourceType", "other");
            boolean hiddenFromDocuments = call.getBoolean("hiddenFromDocuments", false);
            File entry = entryDirectory(scope, id);
            File metadata = new File(entry, "resource.json");
            JSObject existing = readJson(metadata);
            String replacedHash = existing == null ? "" : existing.optString("contentHash", "");
            File object = objectFile(contentHash);
            File legacyFile = existing == null ? null : new File(entry, safeFileName(existing.optString("storedName", "resource.bin")));
            if ((!object.isFile() || object.length() != size) && existing != null && legacyFile.isFile()
                && contentHash.equalsIgnoreCase(existing.optString("contentHash")) && legacyFile.length() == size) {
                File stagedLegacy = new File(object.getParentFile(), object.getName() + ".legacy.part");
                if (!object.getParentFile().exists() && !object.getParentFile().mkdirs())
                    throw new IllegalStateException("无法创建原生对象目录");
                copyFile(legacyFile, stagedLegacy);
                installObject(stagedLegacy, object, size);
            }
            if (object.isFile() && object.length() == size) {
                JSObject result = new JSObject();
                String token = "";
                if (call.getBoolean("deferCommit", false)) {
                    // Preparing an immutable object must not publish an unaccepted database write.
                    token = UUID.randomUUID().toString();
                    pendingWrites.put(token, new PendingWrite(token, scope, id, fileName, mimeType,
                        resourceType, hiddenFromDocuments, contentHash, size, updatedAt, null, null, null));
                } else {
                    if (!entry.exists() && !entry.mkdirs()) throw new IllegalStateException("无法创建原生资源目录");
                    writeMetadata(metadata, id, scope, fileName, mimeType, resourceType,
                        hiddenFromDocuments, contentHash, size, updatedAt);
                    deleteEntryPayloads(entry);
                }
                result.put("alreadyPresent", true);
                result.put("replacedHash", replacedHash);
                result.put("token", token);
                call.resolve(result);
                return;
            }

            File pending = new File(libraryRoot(), ".pending");
            if (!pending.exists() && !pending.mkdirs()) throw new IllegalStateException("无法创建原生资源暂存目录");
            deleteStalePending(pending);
            String token = UUID.randomUUID().toString();
            File temporary = new File(pending, token + ".part");
            PendingWrite write = new PendingWrite(
                token, scope, id, fileName, mimeType, resourceType, hiddenFromDocuments,
                contentHash, size, updatedAt,
                temporary, new FileOutputStream(temporary), MessageDigest.getInstance("SHA-256")
            );
            pendingWrites.put(token, write);
            JSObject result = new JSObject();
            result.put("alreadyPresent", false);
            result.put("replacedHash", replacedHash);
            result.put("token", token);
            call.resolve(result);
        });
    }

    @PluginMethod
    public void appendWrite(PluginCall call) {
        runIo(call, () -> {
            PendingWrite write = pending(call.getString("token"));
            String encoded = required(call, "data", MAX_CHUNK_BYTES * 2);
            byte[] bytes = Base64.decode(encoded, Base64.NO_WRAP);
            if (bytes.length > MAX_CHUNK_BYTES) throw new IllegalArgumentException("原生资源分块超过 1 MiB");
            synchronized (write) {
                if (write.written + bytes.length > write.expectedSize) throw new IllegalArgumentException("原生资源写入超过声明大小");
                write.output.write(bytes);
                write.digest.update(bytes);
                write.written += bytes.length;
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void commitWrite(PluginCall call) {
        runIo(call, () -> {
            PendingWrite write = pending(call.getString("token"));
            File object = objectFile(write.contentHash);
            synchronized (write) {
                if (write.output != null) {
                    write.output.flush();
                    write.output.close();
                    String actualHash = hex(write.digest.digest());
                    if (write.written != write.expectedSize || !actualHash.equalsIgnoreCase(write.contentHash)) {
                        write.temporary.delete();
                        throw new IllegalStateException("原生资源文件大小或 SHA-256 校验失败");
                    }
                    installObject(write.temporary, object, write.expectedSize);
                } else if (!object.isFile() || object.length() != write.expectedSize) {
                    throw new IllegalStateException("准备中的原生对象已变化，保留数据库原件");
                }
            }
            File entry = entryDirectory(write.scope, write.id);
            if (!entry.exists() && !entry.mkdirs()) throw new IllegalStateException("无法创建原生资源目录");
            writeMetadata(new File(entry, "resource.json"), write.id, write.scope, write.fileName,
                write.mimeType, write.resourceType, write.hiddenFromDocuments, write.contentHash,
                write.expectedSize, write.updatedAt);
            deleteEntryPayloads(entry);
            pendingWrites.remove(write.token);
            call.resolve();
        });
    }

    @PluginMethod
    public void abortWrite(PluginCall call) {
        runIo(call, () -> {
            String token = call.getString("token", "");
            PendingWrite write = pendingWrites.remove(token);
            if (write != null) {
                synchronized (write) {
                    try { if (write.output != null) write.output.close(); } catch (Exception ignored) {}
                    if (write.temporary != null) write.temporary.delete();
                }
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void deleteRecoveryCandidates(PluginCall call) {
        runIo(call, () -> {
            com.getcapacitor.JSArray candidates = call.getArray("candidates");
            if (!call.getBoolean("confirmed", false) || candidates == null || candidates.length() == 0 || candidates.length() > 100)
                throw new IllegalArgumentException("请先确认删除所选待找回原件");
            for (int i = 0; i < candidates.length(); i++) {
                JSONObject item = candidates.getJSONObject(i);
                requiredHash(item.getString("contentHash"));
                NativeBridgeNumber.bounded(item.opt("size"), 0L, MAX_FILE_BYTES, "原件大小无效");
                NativeBridgeNumber.bounded(item.opt("modifiedAt"), 0L, Long.MAX_VALUE, "原件时间无效");
                if (item.has("nativeId")) {
                    String id = item.getString("nativeId");
                    if (id.isBlank() || id.length() > 200 || !"current".equals(item.optString("nativeScope")))
                        throw new IllegalArgumentException("待删除原件索引标识无效");
                    item.put("entry", entryDirectory("current", id).getName());
                }
            }
            synchronized (NativeCloudRestoreWorker.class) {
              synchronized (NativeCloudTransferPlugin.class) {
                try (NativeAppDatabase database = new NativeAppDatabase(getContext())) {
                    JSONObject result = database.deleteUnreferencedRecoveryCandidates(candidates, protectedHashes -> {
                        protectedHashes.addAll(preparedObjectHashes());
                        return NativeRecoveryDeletion.delete(libraryRoot(), new File(getContext().getFilesDir(), "srl-cloud-jobs"), candidates, protectedHashes);
                    });
                    call.resolve(JSObject.fromJSONObject(result));
                }
              }
            }
        });
    }

    @PluginMethod
    public void remove(PluginCall call) {
        runIo(call, () -> {
            String scope = scope(call.getString("scope"));
            String id = required(call, "id", 200);
            File entry = entryDirectory(scope, id);
            JSObject metadata = readJson(new File(entry, "resource.json"));
            String contentHash = metadata == null ? "" : metadata.optString("contentHash", "");
            deleteRecursively(entry);
            garbageCollectObject(contentHash);
            call.resolve();
        });
    }

    @PluginMethod
    public void releaseReplacedObjects(PluginCall call) {
        runIo(call, () -> {
            com.getcapacitor.JSArray records = call.getArray("records");
            if (records == null || records.length() > 50_000) throw new IllegalArgumentException("旧原件清单无效");
            for (int i = 0; i < records.length(); i++) {
                JSONObject record = records.getJSONObject(i);
                record.put("entry", entryDirectory(scope(record.getString("scope")), record.getString("id")).getName());
                String hash = record.getString("contentHash");
                if (!hash.matches("(?i)[a-f0-9]{64}")) throw new IllegalArgumentException("新原件哈希无效");
                NativeBridgeNumber.bounded(record.opt("size"), 0L, MAX_FILE_BYTES, "原件大小无效");
            }
            long cleared;
            synchronized (NativeCloudTransferPlugin.class) {
                cleared = NativeReplacedObjectCleanup.release(libraryRoot(),
                    new File(getContext().getFilesDir(), "srl-cloud-jobs"),
                    records, preparedObjectHashes());
            }
            JSObject result = new JSObject();
            result.put("clearedBytes", cleared);
            call.resolve(result);
        });
    }

    /** Remove a bounded batch, scanning remaining references once rather than once per file. */
    @PluginMethod
    public void removeMany(PluginCall call) {
        runIo(call, () -> {
            com.getcapacitor.JSArray records = call.getArray("records");
            if (records == null || records.length() > 128) throw new IllegalArgumentException("删除批次数量无效");
            ArrayList<File> entries = new ArrayList<>();
            Set<String> hashes = new HashSet<>();
            // Resolve and validate the whole batch before changing any entry.
            for (int index = 0; index < records.length(); index++) {
                org.json.JSONObject record = records.getJSONObject(index);
                String id = record.optString("id", "");
                if (id.isBlank() || id.length() > 200) throw new IllegalArgumentException("资源 ID 无效");
                File entry = entryDirectory(scope(record.optString("scope", "")), id);
                entries.add(entry);
                JSObject metadata = readJson(new File(entry, "resource.json"));
                String hash = metadata == null ? "" : metadata.optString("contentHash", "").toLowerCase(Locale.ROOT);
                if (hash.matches("[a-f0-9]{64}")) hashes.add(hash);
            }
            for (File entry : entries) deleteRecursively(entry);
            garbageCollectObjects(hashes);
            call.resolve();
        });
    }

    @PluginMethod
    public void clear(PluginCall call) {
        runIo(call, () -> {
            for (PendingWrite write : pendingWrites.values()) {
                synchronized (write) {
                    try { if (write.output != null) write.output.close(); } catch (Exception ignored) {}
                    if (write.temporary != null) write.temporary.delete();
                }
            }
            pendingWrites.clear();
            File root = libraryRoot();
            deleteRecursively(new File(root, "current"));
            deleteRecursively(new File(root, "versions"));
            deleteRecursively(new File(root, "objects"));
            call.resolve();
        });
    }

    @Override
    protected void handleOnDestroy() {
        for (PendingWrite write : pendingWrites.values()) {
            synchronized (write) {
                try { if (write.output != null) write.output.close(); } catch (Exception ignored) {}
            }
        }
        pendingWrites.clear();
    }

    private void runIo(PluginCall call, NativeLibraryAction action) {
        NativeExecutors.ioSerial().execute(() -> {
            try {
                action.run();
            } catch (Exception error) {
                call.reject(error.getMessage() == null ? "原生资源操作失败" : error.getMessage(), error);
            }
        });
    }

    private File libraryRoot() {
        return libraryRoot(getContext());
    }

    static File libraryRoot(Context context) {
        File documents = context.getExternalFilesDir(Environment.DIRECTORY_DOCUMENTS);
        if (documents == null) documents = context.getFilesDir();
        File root = new File(documents, "SRL/library");
        if (!root.exists() && !root.mkdirs()) throw new IllegalStateException("无法创建 Android 本地资源目录");
        return root;
    }

    private File entryDirectory(String scope, String id) throws Exception {
        return new File(new File(libraryRoot(), scope), safeComponent(id));
    }

    private String safeComponent(String value) throws Exception {
        if (value.matches("[A-Za-z0-9._-]{1,160}")) return value;
        return hex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));
    }

    private String scope(String value) {
        if ("current".equals(value) || "versions".equals(value)) return value;
        throw new IllegalArgumentException("原生资源范围无效");
    }

    private String required(PluginCall call, String key, int maxLength) {
        String value = call.getString(key);
        if (value == null || value.isBlank() || value.length() > maxLength) throw new IllegalArgumentException(key + " 无效");
        return value;
    }

    private String requiredHash(String value) {
        if (value == null || !value.matches("(?i)[a-f0-9]{64}")) throw new IllegalArgumentException("资源 SHA-256 无效");
        return value.toLowerCase(Locale.ROOT);
    }

    private PendingWrite pending(String token) {
        PendingWrite write = token == null ? null : pendingWrites.get(token);
        if (write == null) throw new IllegalArgumentException("原生资源写入令牌已失效");
        return write;
    }

    private String safeFileName(String value) {
        String safe = value.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (safe.isBlank() || ".".equals(safe) || "..".equals(safe)) safe = "resource.bin";
        return safe.length() > 180 ? safe.substring(safe.length() - 180) : safe;
    }

    private void writeMetadata(File target, String id, String scope, String fileName,
                               String mimeType, String resourceType, boolean hiddenFromDocuments,
                               String contentHash, long size, long updatedAt) throws Exception {
        JSObject metadata = new JSObject();
        metadata.put("version", 3);
        metadata.put("id", id);
        metadata.put("scope", scope);
        metadata.put("fileName", fileName);
        metadata.put("mimeType", mimeType);
        metadata.put("resourceType", resourceType);
        metadata.put("hiddenFromDocuments", hiddenFromDocuments);
        metadata.put("contentHash", contentHash);
        metadata.put("objectPath", "objects/" + contentHash.substring(0, 2) + "/" + contentHash + ".bin");
        metadata.put("size", size);
        metadata.put("updatedAt", updatedAt);
        File temporary = new File(target.getParentFile(), "resource.json.tmp");
        try (FileOutputStream output = new FileOutputStream(temporary)) {
            output.write(metadata.toString(2).getBytes(StandardCharsets.UTF_8));
        }
        moveFile(temporary, target);
    }

    private JSObject readJson(File file) {
        if (!file.isFile() || file.length() > 64 * 1024) return null;
        try (FileInputStream input = new FileInputStream(file)) {
            byte[] bytes = new byte[(int) file.length()];
            int offset = 0;
            while (offset < bytes.length) {
                int read = input.read(bytes, offset, bytes.length - offset);
                if (read < 0) break;
                offset += read;
            }
            return new JSObject(new String(bytes, 0, offset, StandardCharsets.UTF_8));
        } catch (Exception ignored) {
            return null;
        }
    }

    private void deleteEntryPayloads(File entry) {
        File[] files = entry.listFiles();
        if (files == null) return;
        for (File file : files) if (!"resource.json".equals(file.getName())) deleteRecursively(file);
    }

    private int countEntries(File directory) {
        File[] files = directory.listFiles(File::isDirectory);
        return files == null ? 0 : files.length;
    }

    private boolean hasLegacyEntries(File directory) {
        File[] entries = directory.listFiles(File::isDirectory);
        if (entries == null) return false;
        for (File entry : entries) {
            JSObject metadata = readJson(new File(entry, "resource.json"));
            if (metadata == null || metadata.optInt("version", 1) < 3) return true;
        }
        return false;
    }

    private File objectFile(String contentHash) {
        return objectFile(getContext(), contentHash);
    }

    static File objectFile(Context context, String contentHash) {
        String normalized = contentHash.toLowerCase(Locale.ROOT);
        if (!normalized.matches("[a-f0-9]{64}")) throw new IllegalArgumentException("原生对象哈希无效");
        return new File(new File(new File(libraryRoot(context), "objects"), normalized.substring(0, 2)), normalized + ".bin");
    }

    private void installObject(File source, File destination, long expectedSize) throws Exception {
        if (destination.isFile()) {
            if (destination.length() != expectedSize) throw new IllegalStateException("原生对象库中存在大小异常的同名对象");
            if (!source.equals(destination)) source.delete();
            return;
        }
        File parent = destination.getParentFile();
        if (!parent.exists() && !parent.mkdirs()) throw new IllegalStateException("无法创建原生对象目录");
        moveFile(source, destination);
    }

    private void garbageCollectObject(String contentHash) throws Exception {
        if (!contentHash.matches("(?i)[a-f0-9]{64}")) return;
        garbageCollectObjects(Collections.singleton(contentHash.toLowerCase(Locale.ROOT)));
    }

    private Set<String> preparedObjectHashes() {
        Set<String> hashes = new HashSet<>();
        for (PendingWrite write : pendingWrites.values()) hashes.add(write.contentHash.toLowerCase(Locale.ROOT));
        return hashes;
    }

    private void garbageCollectObjects(Set<String> hashes) {
        try {
            synchronized (NativeCloudTransferPlugin.class) {
                NativeReplacedObjectCleanup.releaseUnreferenced(libraryRoot(),
                    new File(getContext().getFilesDir(), "srl-cloud-jobs"), hashes, preparedObjectHashes());
            }
        } catch (Exception unavailable) {
            // Deleting an index does not authorize deleting an object with unreadable references.
        }
    }

    private String manifestHash(File scopeRoot) throws Exception {
        ArrayList<String> records = new ArrayList<>();
        File[] entries = scopeRoot.listFiles(File::isDirectory);
        if (entries != null) for (File entry : entries) {
            JSObject metadata = readJson(new File(entry, "resource.json"));
            if (metadata == null) continue;
            String id = metadata.optString("id", "");
            String contentHash = metadata.optString("contentHash", "").toLowerCase(Locale.ROOT);
            if (!id.isBlank() && contentHash.matches("[a-f0-9]{64}")) records.add(id + "\0" + contentHash + "\n");
        }
        Collections.sort(records);
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        for (String record : records) digest.update(record.getBytes(StandardCharsets.UTF_8));
        return hex(digest.digest());
    }

    private Set<String> jsonStringSet(com.getcapacitor.JSArray values) throws Exception {
        Set<String> result = new HashSet<>();
        for (int index = 0; index < values.length(); index++) {
            String value = values.getString(index);
            if (value == null || value.isBlank() || value.length() > 200) {
                throw new IllegalArgumentException("原生资源对账 ID 无效");
            }
            result.add(value);
        }
        return result;
    }

    private int removeStaleEntries(File scopeRoot, Set<String> expectedIds) throws Exception {
        File[] entries = scopeRoot.listFiles(File::isDirectory);
        if (entries == null) return 0;
        int removed = 0;
        for (File entry : entries) {
            JSObject metadata = readJson(new File(entry, "resource.json"));
            String id = metadata == null ? entry.getName() : metadata.optString("id", entry.getName());
            if (expectedIds.contains(id)) continue;
            // Do not destroy legacy payloads or malformed/unknown entries on an empty/stale index.
            File[] files = entry.listFiles();
            if (metadata == null || files == null || files.length != 1
                || !"resource.json".equals(files[0].getName()) || !files[0].isFile()) continue;
            if (!files[0].delete()) throw new IllegalStateException("无法移除失效的原生索引");
            if (!entry.delete()) throw new IllegalStateException("无法移除空原生索引目录");
            // Explicit resource deletion still owns GC. Reconciliation is not deletion authority.
            removed++;
        }
        return removed;
    }

    private void collectReferencedHashes(File scopeRoot, Set<String> output) {
        File[] entries = scopeRoot.listFiles(File::isDirectory);
        if (entries == null) return;
        for (File entry : entries) {
            JSObject metadata = readJson(new File(entry, "resource.json"));
            if (metadata == null) continue;
            String hash = metadata.optString("contentHash", "").toLowerCase(Locale.ROOT);
            if (hash.matches("[a-f0-9]{64}")) output.add(hash);
        }
    }

    private void collectObjectFiles(File directory, ArrayList<File> output) {
        File[] files = directory.listFiles();
        if (files == null) return;
        for (File file : files) {
            if (file.isDirectory()) collectObjectFiles(file, output);
            else output.add(file);
        }
    }

    private int countObjectFiles(File directory) {
        File[] files = directory.listFiles();
        if (files == null) return 0;
        int count = 0;
        for (File file : files) count += file.isDirectory() ? countObjectFiles(file) : 1;
        return count;
    }

    private long countObjectBytes(File directory) {
        File[] files = directory.listFiles();
        if (files == null) return 0L;
        long bytes = 0L;
        for (File file : files) bytes += file.isDirectory() ? countObjectBytes(file) : file.length();
        return bytes;
    }

    private long directoryBytes(File directory) {
        if (directory == null || !directory.exists()) return 0L;
        File[] files = directory.listFiles();
        if (files == null) return directory.isFile() ? directory.length() : 0L;
        long bytes = 0L;
        for (File file : files) bytes += file.isDirectory() ? directoryBytes(file) : file.length();
        return bytes;
    }

    private long availableBytes(File primary, File secondary) {
        long primaryAvailable = availableBytes(primary);
        long secondaryAvailable = availableBytes(secondary);
        if (primaryAvailable <= 0L) return secondaryAvailable;
        if (secondaryAvailable <= 0L) return primaryAvailable;
        return Math.min(primaryAvailable, secondaryAvailable);
    }

    private long availableBytes(File directory) {
        if (directory == null || !directory.exists()) return 0L;
        try {
            return new StatFs(directory.getAbsolutePath()).getAvailableBytes();
        } catch (IllegalArgumentException ignored) {
            return 0L;
        }
    }

    private void deleteStalePending(File directory) {
        File[] files = directory.listFiles();
        if (files == null) return;
        long cutoff = System.currentTimeMillis() - STALE_PENDING_MS;
        for (File file : files) if (file.isFile() && file.lastModified() < cutoff) file.delete();
    }

    private void moveFile(File source, File destination) throws Exception {
        // All callers stage on the same filesystem. Do not delete the destination first:
        // a failed rename must leave the existing metadata/object intact.
        if (!source.renameTo(destination)) {
            throw new IllegalStateException("无法原子替换原生资源文件");
        }
    }

    private void copyFile(File source, File destination) throws Exception {
        try (FileInputStream input = new FileInputStream(source);
             FileOutputStream output = new FileOutputStream(destination)) {
            byte[] buffer = new byte[32 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
        }
    }

    private void deleteRecursively(File file) {
        if (!file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteRecursively(child);
        file.delete();
    }

    private long clearDirectoryContents(File directory) {
        File[] children = directory.listFiles();
        if (children == null) return 0L;
        long clearedBytes = 0L;
        for (File child : children) clearedBytes += deleteRecursivelyCountBytes(child);
        return clearedBytes;
    }

    static long clearRetiredTranslationModels(File noBackupDirectory) throws Exception {
        File parent = noBackupDirectory.getCanonicalFile();
        File models = new File(parent, "com.google.mlkit.translate.models");
        if (!models.exists()) return 0L;
        // Validate the whole fixed target before deleting anything; never follow links outside it.
        validateCleanupTree(models);
        long clearedBytes = deleteRecursivelyCountBytes(models);
        if (models.exists()) throw new java.io.IOException("旧翻译模型未完全删除，请重新检查剩余占用");
        return clearedBytes;
    }

    private static void validateCleanupTree(File file) throws Exception {
        if (!file.getAbsoluteFile().equals(file.getCanonicalFile())) {
            throw new java.io.IOException("旧翻译模型目录包含链接，未删除文件");
        }
        if (!file.isDirectory()) return;
        File[] children = file.listFiles();
        if (children == null) throw new java.io.IOException("无法检查旧翻译模型目录，未删除文件");
        for (File child : children) validateCleanupTree(child);
    }

    private static long deleteRecursivelyCountBytes(File file) {
        long clearedBytes = 0L;
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) clearedBytes += deleteRecursivelyCountBytes(child);
        }
        long bytes = file.isFile() ? file.length() : 0L;
        return file.delete() ? clearedBytes + bytes : clearedBytes;
    }

    private String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) result.append(String.format(Locale.ROOT, "%02x", value));
        return result.toString();
    }
}
