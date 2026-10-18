package buzz.jixiangruyi1207.srl;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.util.Base64;
import java.io.File;
import java.io.FileInputStream;
import java.io.RandomAccessFile;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/** App-private native persistence used by the Capacitor database bridge and WorkManager. */
final class NativeAppDatabase extends SQLiteOpenHelper {
    static final int SCHEMA_VERSION = 5;
    static final String DATABASE_NAME = "srl-app-data.db";
    // Large restore/import transactions stay atomic in SQLite. Keep a generous safety cap,
    // rather than rejecting ordinary libraries once they cross an arbitrary 1,000 rows.
    static final int MAX_BATCH_SIZE = 50_000;
    static final int MAX_ROW_JSON_CHARS = 4 * 1024 * 1024;
    static final int MAX_BLOB_CHUNK_BYTES = 1024 * 1024;
    static final long MAX_BLOB_BYTES = 4L * 1024L * 1024L * 1024L * 1024L;
    private static final Set<String> STORES = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
        "resources", "resourceSummaries", "resourceListSummaries", "resourceVersions",
        "resourceVersionSummaries", "categories", "settings", "backupRecords", "externalApps",
        "externalAppRuntimes", "externalAppData", "externalAppDrafts", "frontendWorkshopProjects",
        "frontendWorkshopProjectLastGood", "frontendWorkshopSourceDocuments",
        "frontendWorkshopSourceDocumentLastGood", "frontendWorkshopSourceComponents",
        "generatedImages", "generatedImageFiles", "restoreStaging", "restoreStagingChunks",
        "assets", "assetFiles", "communitySources", "communitySourceMessages",
        "resourceSourceBindings", "cloudBackupJobs", "cloudBackupOrphans"
    )));
    private final Context context;
    interface CheckedOperation<T> { T run() throws Exception; }
    private final ThreadLocal<Map<String, Long>> readGuard = new ThreadLocal<>();
    <T> T withReadGuard(CheckedOperation<T> operation) throws Exception {
        if (readGuard.get() != null) return operation.run();
        readGuard.set(new HashMap<>());
        try { return operation.run(); } finally { readGuard.remove(); }
    }

    private long storeRevision(SQLiteDatabase database, String store) {
        try (Cursor cursor = database.query("app_state", new String[] {"state_value"}, "state_key = ?",
            new String[] {"revision:appdb:v1:" + store}, null, null, null, "1")) {
            return cursor.moveToFirst() ? Long.parseLong(cursor.getString(0)) : 0L;
        }
    }

    private void noteRead(String store) {
        Map<String, Long> expected = readGuard.get();
        if (expected != null && !expected.containsKey(store)) expected.put(store, storeRevision(getReadableDatabase(), store));
    }

    private void checkRevisions(SQLiteDatabase database, JSONObject revisions) {
        Map<String, Long> expected = new HashMap<>();
        if (readGuard.get() != null) expected.putAll(readGuard.get());
        if (revisions != null) {
            java.util.Iterator<String> keys = revisions.keys();
            while (keys.hasNext()) {
                String store = keys.next(); requireStore(store);
                long revision = revisions.optLong(store, -1);
                if (revision < 0) throw new IllegalArgumentException("原生数据库版本核验值无效");
                expected.put(store, revision);
            }
        }
        for (Map.Entry<String, Long> entry : expected.entrySet())
            if (storeRevision(database, entry.getKey()) != entry.getValue())
                throw new IllegalStateException("数据表 " + entry.getKey() + " 在操作期间已变化；未覆盖其他修改，请重新执行当前操作");
    }

    private void bumpRevision(SQLiteDatabase database, String store) {
        long next = storeRevision(database, store) + 1;
        ContentValues value = new ContentValues(); value.put("state_key", "revision:appdb:v1:" + store); value.put("state_value", Long.toString(next));
        if (database.insertWithOnConflict("app_state", null, value, SQLiteDatabase.CONFLICT_REPLACE) < 0)
            throw new IllegalStateException("原生数据库版本写入失败");
        if (readGuard.get() != null && readGuard.get().containsKey(store)) readGuard.get().put(store, next);
    }

    NativeAppDatabase(Context context) {
        this(context, DATABASE_NAME);
    }

    NativeAppDatabase(Context context, String name) {
        super(context.getApplicationContext(), name, null, SCHEMA_VERSION);
        this.context = context.getApplicationContext();
    }

    /** Explicit maintenance only. SQLite commits VACUUM atomically; originals stay untouched. */
    JSONObject compact() throws Exception {
        SQLiteDatabase database = getWritableDatabase();
        if (database.inTransaction()) throw new IllegalStateException("数据库正在写入，未执行空间回收");
        long before = android.database.DatabaseUtils.longForQuery(database, "PRAGMA page_count", null)
            * android.database.DatabaseUtils.longForQuery(database, "PRAGMA page_size", null);
        database.execSQL("VACUUM");
        long after = android.database.DatabaseUtils.longForQuery(database, "PRAGMA page_count", null)
            * android.database.DatabaseUtils.longForQuery(database, "PRAGMA page_size", null);
        return new JSONObject().put("beforeBytes", before).put("afterBytes", after);
    }

    /** Size/count diagnostics only: never create, migrate, checkpoint or read back payloads. */
    static JSONObject storageUsage(File file) throws Exception {
        if (!file.isFile()) return null;
        JSONObject result = new JSONObject();
        result.put("fileBytes", file.length());
        result.put("walBytes", new File(file.getPath() + "-wal").length());
        result.put("shmBytes", new File(file.getPath() + "-shm").length());
        try (SQLiteDatabase database = SQLiteDatabase.openDatabase(file.getPath(), null, SQLiteDatabase.OPEN_READONLY)) {
            long pageSize;
            try (Cursor cursor = database.rawQuery("PRAGMA page_size", null)) {
                cursor.moveToFirst(); pageSize = cursor.getLong(0);
            }
            try (Cursor cursor = database.rawQuery("PRAGMA freelist_count", null)) {
                cursor.moveToFirst(); result.put("freePageBytes", cursor.getLong(0) * pageSize);
            }
            try (Cursor cursor = database.rawQuery("PRAGMA page_count", null)) {
                cursor.moveToFirst(); result.put("pageBytes", cursor.getLong(0) * pageSize);
            }
            JSONArray stores = new JSONArray();
            // Aggregates are computed in SQLite; no keys, credentials or resource text cross the bridge.
            String query = "SELECT names.store_name, COALESCE(r.records,0), COALESCE(r.json_bytes,0), COALESCE(b.blob_bytes,0) "
                + "FROM (SELECT store_name FROM app_records UNION SELECT store_name FROM app_blobs) names "
                + "LEFT JOIN (SELECT store_name, COUNT(*) records, SUM(length(CAST(payload_json AS BLOB))) json_bytes FROM app_records GROUP BY store_name) r ON r.store_name=names.store_name "
                + "LEFT JOIN (SELECT store_name, SUM(byte_length) blob_bytes FROM app_blobs GROUP BY store_name) b ON b.store_name=names.store_name "
                + "ORDER BY COALESCE(r.json_bytes,0)+COALESCE(b.blob_bytes,0) DESC";
            try (Cursor cursor = database.rawQuery(query, null)) {
                while (cursor.moveToNext()) stores.put(new JSONObject().put("store", cursor.getString(0))
                    .put("records", cursor.getLong(1)).put("jsonBytes", cursor.getLong(2))
                    .put("blobReferenceBytes", cursor.getLong(3)));
            }
            result.put("stores", stores);
            try (Cursor cursor = database.rawQuery("SELECT COALESCE(SUM(size),0) FROM (SELECT MAX(byte_length) size FROM app_blobs GROUP BY sha256)", null)) {
                cursor.moveToFirst(); result.put("uniqueReferencedBlobBytes", cursor.getLong(0));
            }
            try (Cursor cursor = database.rawQuery("SELECT COUNT(*), COALESCE(SUM(expected_size),0) FROM app_blob_pending", null)) {
                cursor.moveToFirst(); result.put("pendingBlobCount", cursor.getLong(0));
                result.put("pendingExpectedBytes", cursor.getLong(1));
            }
        }
        return result;
    }

    @Override public void onCreate(SQLiteDatabase database) {
        database.execSQL("CREATE TABLE app_records (store_name TEXT NOT NULL, record_key TEXT NOT NULL, payload_json TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(store_name, record_key))");
        database.execSQL("CREATE INDEX app_records_store_updated ON app_records(store_name, updated_at, record_key)");
        database.execSQL("CREATE TABLE app_state (state_key TEXT PRIMARY KEY NOT NULL, state_value TEXT NOT NULL)");
        createIndexTables(database);
        createBlobTables(database);
        createOrderedKeys(database);
    }

    @Override public void onUpgrade(SQLiteDatabase database, int oldVersion, int newVersion) {
        // Native schema upgrades are append-only. Never drop migrated user data here.
        if (oldVersion < 1) onCreate(database);
        if (oldVersion < 2) createBlobTables(database);
        if (oldVersion < 3) createIndexTables(database);
        if (oldVersion >= 2 && oldVersion < 4) database.execSQL("ALTER TABLE app_blob_pending ADD COLUMN source_sha256 TEXT NOT NULL DEFAULT ''");
        if (oldVersion >= 1 && oldVersion < 5) createOrderedKeys(database);
    }

    private static void createIndexTables(SQLiteDatabase database) {
        database.execSQL("CREATE TABLE IF NOT EXISTS app_record_indexes (store_name TEXT NOT NULL, index_name TEXT NOT NULL, index_key TEXT NOT NULL, record_key TEXT NOT NULL, PRIMARY KEY(store_name, index_name, index_key, record_key))");
        database.execSQL("CREATE INDEX IF NOT EXISTS app_record_indexes_lookup ON app_record_indexes(store_name, index_name, index_key, record_key)");
    }

    private static void createBlobTables(SQLiteDatabase database) {
        database.execSQL("CREATE TABLE IF NOT EXISTS app_blobs (store_name TEXT NOT NULL, record_key TEXT NOT NULL, field_path TEXT NOT NULL, mime_type TEXT NOT NULL, byte_length INTEGER NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(store_name, record_key, field_path))");
        database.execSQL("CREATE INDEX IF NOT EXISTS app_blobs_sha256 ON app_blobs(sha256)");
        database.execSQL("CREATE TABLE IF NOT EXISTS app_blob_pending (token TEXT PRIMARY KEY NOT NULL, store_name TEXT NOT NULL, record_key TEXT NOT NULL, field_path TEXT NOT NULL, mime_type TEXT NOT NULL, expected_size INTEGER NOT NULL, relative_path TEXT NOT NULL, source_sha256 TEXT NOT NULL DEFAULT '', UNIQUE(store_name, record_key, field_path))");
    }

    static final class BlobTransfer {
        final String token;
        final long offset;
        final boolean alreadyStored;
        final String sha256;
        final long size;
        final String mimeType;
        BlobTransfer(String token, long offset, boolean alreadyStored, String sha256, long size, String mimeType) {
            this.token = token; this.offset = offset; this.alreadyStored = alreadyStored;
            this.sha256 = sha256; this.size = size; this.mimeType = mimeType;
        }
    }

    BlobTransfer beginBlob(String store, String key, String fieldPath, long size, String mimeType) {
        return beginBlob(store, key, fieldPath, size, mimeType, "");
    }

    private static void createOrderedKeys(SQLiteDatabase database) {
        database.execSQL("ALTER TABLE app_records ADD COLUMN record_sort_key TEXT NOT NULL DEFAULT ''");
        database.execSQL("ALTER TABLE app_record_indexes ADD COLUMN index_sort_key TEXT NOT NULL DEFAULT ''");
        database.execSQL("ALTER TABLE app_record_indexes ADD COLUMN record_sort_key TEXT NOT NULL DEFAULT ''");
        // Stream only existing keys once on upgrade. Payloads and attachment bytes remain untouched.
        try (Cursor cursor = database.rawQuery("SELECT store_name, record_key FROM app_records", null)) {
            while (cursor.moveToNext()) {
                ContentValues value = new ContentValues(); value.put("record_sort_key", NativeDatabaseKeyOrder.key(cursor.getString(1)));
                database.update("app_records", value, "store_name = ? AND record_key = ?", new String[] {cursor.getString(0), cursor.getString(1)});
            }
        }
        try (Cursor cursor = database.rawQuery("SELECT store_name, index_name, index_key, record_key FROM app_record_indexes", null)) {
            while (cursor.moveToNext()) {
                ContentValues value = new ContentValues();
                value.put("index_sort_key", NativeDatabaseKeyOrder.key(cursor.getString(2)));
                value.put("record_sort_key", NativeDatabaseKeyOrder.key(cursor.getString(3)));
                database.update("app_record_indexes", value, "store_name = ? AND index_name = ? AND index_key = ? AND record_key = ?",
                    new String[] {cursor.getString(0), cursor.getString(1), cursor.getString(2), cursor.getString(3)});
            }
        }
        database.execSQL("CREATE INDEX app_records_order ON app_records(store_name, record_sort_key, record_key)");
        database.execSQL("CREATE INDEX app_record_indexes_order ON app_record_indexes(store_name, index_name, index_sort_key, record_sort_key, index_key, record_key)");
    }

    BlobTransfer beginBlob(String store, String key, String fieldPath, long size, String mimeType, String sourceSha256) {
        requireStore(store); requireKey(key); requireFieldPath(fieldPath);
        String sourceHash = sourceSha256 == null ? "" : sourceSha256;
        if (!sourceHash.isEmpty() && !sourceHash.matches("[a-f0-9]{64}")) throw new IllegalArgumentException("原生二进制来源哈希无效");
        if (size < 0 || size > MAX_BLOB_BYTES) throw new IllegalArgumentException("原生二进制大小无效");
        String type = mimeType == null ? "" : mimeType.substring(0, Math.min(mimeType.length(), 256));
        SQLiteDatabase database = getWritableDatabase();
        try (Cursor cursor = database.query("app_blob_pending", new String[] {"token", "mime_type", "expected_size", "relative_path", "source_sha256"}, "store_name = ? AND record_key = ? AND field_path = ?", new String[] {store, key, fieldPath}, null, null, null, "1")) {
            if (cursor.moveToFirst() && cursor.getLong(2) == size && cursor.getString(1).equals(type) && sourceHash.equals(cursor.getString(4))) {
                String token = cursor.getString(0);
                File partial = blobFile(cursor.getString(3));
                if (partial.isFile() && partial.length() <= size) return new BlobTransfer(token, partial.length(), false, null, size, type);
            }
        } catch (Exception error) { throw new IllegalStateException("原生二进制迁移状态读取失败", error); }

        deletePendingForField(database, store, key, fieldPath);
        String token = java.util.UUID.randomUUID().toString();
        String relativePath = "pending/" + token + ".part";
        File partial = blobFile(relativePath);
        File parent = partial.getParentFile();
        try {
            if ((parent == null || (!parent.isDirectory() && !parent.mkdirs())) || !partial.createNewFile())
                throw new IllegalStateException("无法创建原生二进制暂存文件");
        } catch (java.io.IOException error) { throw new IllegalStateException("无法创建原生二进制暂存文件", error); }
        ContentValues values = new ContentValues();
        values.put("token", token); values.put("store_name", store); values.put("record_key", key);
        values.put("field_path", fieldPath); values.put("mime_type", type); values.put("expected_size", size);
        values.put("relative_path", relativePath);
        values.put("source_sha256", sourceHash);
        if (database.insertOrThrow("app_blob_pending", null, values) < 0) throw new IllegalStateException("无法记录原生二进制迁移状态");
        return new BlobTransfer(token, 0L, false, null, size, type);
    }

    long appendBlob(String token, long offset, byte[] bytes) {
        if (token == null || !token.matches("[a-f0-9-]{36}") || bytes == null || bytes.length == 0 || bytes.length > MAX_BLOB_CHUNK_BYTES)
            throw new IllegalArgumentException("原生二进制数据块无效");
        JSONObject pending = getPendingBlob(token);
        File partial = blobFile(pending.optString("relativePath"));
        try (RandomAccessFile output = new RandomAccessFile(partial, "rw")) {
            if (offset != output.length() || offset + bytes.length > pending.getLong("expectedSize"))
                throw new IllegalStateException("原生二进制续传位置不一致");
            output.seek(offset); output.write(bytes); output.getFD().sync();
            return output.length();
        } catch (Exception error) { throw new IllegalStateException("原生二进制数据块写入失败", error); }
    }

    JSONObject completeBlob(String token) {
        JSONObject pending = getPendingBlob(token);
        String store = pending.optString("store"); String key = pending.optString("key");
        String fieldPath = pending.optString("fieldPath"); String mimeType = pending.optString("mimeType");
        long expected = pending.optLong("expectedSize", -1L);
        File partial = blobFile(pending.optString("relativePath"));
        if (!partial.isFile() || partial.length() != expected) throw new IllegalStateException("原生二进制文件尚未完整写入");
        String hash;
        try (FileInputStream input = new FileInputStream(partial)) {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[128 * 1024]; int count;
            while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
            hash = toHex(digest.digest());
        } catch (Exception error) { throw new IllegalStateException("原生二进制校验失败", error); }

        String sourceHash = pending.optString("sourceSha256", "");
        if (!sourceHash.isEmpty() && !sourceHash.equals(hash)) throw new IllegalStateException("原生二进制来源校验失败；保留未提交文件");

        String relativePath = "blobs/" + hash.substring(0, 2) + "/" + hash + ".bin";
        File target = blobFile(relativePath); File parent = target.getParentFile();
        if (parent == null || (!parent.isDirectory() && !parent.mkdirs())) throw new IllegalStateException("无法创建原生二进制目录");
        if (target.exists()) {
            if (target.length() != expected) throw new IllegalStateException("原生二进制内容寻址文件大小冲突");
            if (!partial.delete()) throw new IllegalStateException("无法清理原生二进制暂存文件");
        } else if (!partial.renameTo(target)) throw new IllegalStateException("原生二进制文件提交失败");

        JSONObject previous = blobMetadata(store, key, fieldPath);
        SQLiteDatabase database = getWritableDatabase(); database.beginTransaction();
        try {
            ContentValues blob = new ContentValues(); blob.put("store_name", store); blob.put("record_key", key);
            blob.put("field_path", fieldPath); blob.put("mime_type", mimeType); blob.put("byte_length", expected); blob.put("sha256", hash);
            database.insertWithOnConflict("app_blobs", null, blob, SQLiteDatabase.CONFLICT_REPLACE);
            database.delete("app_blob_pending", "token = ?", new String[] {token});
            database.setTransactionSuccessful();
        } finally { database.endTransaction(); }
        if (previous != null && !hash.equals(previous.optString("sha256"))) removeUnreferencedBlob(previous.optString("sha256"));
        return blobMetadata(store, key, fieldPath);
    }

    JSONObject getBlobPath(String store, String key, String fieldPath) {
        JSONObject metadata = blobMetadata(store, key, fieldPath);
        if (metadata == null) return null;
        return validatedBlobPath(metadata);
    }

    private JSONObject validatedBlobPath(JSONObject metadata) {
        String hash = metadata.optString("sha256");
        if (!hash.matches("[a-f0-9]{64}")) throw new IllegalStateException("原生二进制哈希无效");
        File source = blobFile("blobs/" + hash.substring(0, 2) + "/" + hash + ".bin");
        if (!source.isFile() || source.length() != metadata.optLong("size"))
            throw new IllegalStateException("原生二进制文件缺失或大小校验失败");
        try { return metadata.put("path", android.net.Uri.fromFile(source).toString()); }
        catch (Exception error) { throw new IllegalStateException("原生二进制路径读取失败", error); }
    }

    JSONArray getAssetImageSources(JSONArray keys) throws Exception {
        return getAssetImageSources(keys, null);
    }

    JSONArray getAssetImageSources(JSONArray keys, JSONArray cardKeys) throws Exception {
        if (keys == null || keys.length() > NativeAssetImageSources.MAX_BATCH)
            throw new IllegalArgumentException("图片读取批次无效");
        // One SQLite snapshot for both records and attachment identities, including background writers.
        SQLiteDatabase database = getReadableDatabase();
        database.beginTransactionNonExclusive();
        try {
            JSONArray assets = getRecordsByKeys("assets", keys);
            JSONArray selected = NativeAssetImageSources.selectCardKeys(keys, assets, cardKeys);
            java.util.LinkedHashSet<String> union = new java.util.LinkedHashSet<>();
            for (int index=0;index<keys.length();index++) union.add(keys.getString(index));
            JSONArray extra = new JSONArray();
            for (int index=0;index<selected.length();index++) {
                String key=selected.getString(index);
                if (union.add(key)) extra.put(key);
            }
            if (extra.length()>0) {
                JSONArray variants=getRecordsByKeys("assets", extra);
                for(int index=0;index<variants.length();index++)assets.put(variants.get(index));
            }
            JSONArray output=NativeAssetImageSources.read(selected, assets,
                getRecordsByKeys("assetFiles", selected), this::getAssetBlobPaths);
            JSONArray fallback=new JSONArray();
            for(int index=0;index<keys.length();index++) {
                if(!keys.getString(index).equals(selected.getString(index)) && !output.getJSONObject(index).has("blob"))
                    fallback.put(keys.getString(index));
                output.getJSONObject(index).put("key",keys.getString(index));
            }
            if(fallback.length()>0) {
                JSONArray parents=NativeAssetImageSources.read(fallback, assets,
                    getRecordsByKeys("assetFiles",fallback),this::getAssetBlobPaths);
                java.util.Map<String,JSONObject> byKey=new java.util.HashMap<>();
                for(int index=0;index<parents.length();index++)byKey.put(parents.getJSONObject(index).getString("key"),parents.getJSONObject(index));
                for(int index=0;index<output.length();index++) {
                    JSONObject parent=byKey.get(keys.getString(index));
                    if(parent!=null)output.put(index,parent);
                }
            }
            return output;
        } finally { database.endTransaction(); }
    }

    private JSONArray getAssetBlobPaths(JSONArray references) throws Exception {
        StringBuilder selection = new StringBuilder("store_name = ? AND (");
        String[] arguments = new String[1 + references.length() * 2]; arguments[0] = "assetFiles";
        for (int index = 0; index < references.length(); index++) {
            JSONObject reference = references.getJSONObject(index);
            String key = reference.getString("key"), field = reference.getString("fieldPath");
            requireKey(key); requireFieldPath(field);
            if (index > 0) selection.append(" OR ");
            selection.append("(record_key = ? AND field_path = ?)");
            arguments[1 + index * 2] = key; arguments[2 + index * 2] = field;
        }
        selection.append(')');
        JSONArray output = new JSONArray();
        try (Cursor cursor = getReadableDatabase().query("app_blobs",
                new String[] {"record_key", "field_path", "mime_type", "byte_length", "sha256"},
                selection.toString(), arguments, null, null, null)) {
            while (cursor.moveToNext()) {
                JSONObject row = new JSONObject().put("key", cursor.getString(0)).put("fieldPath", cursor.getString(1));
                try {
                    row.put("blob", validatedBlobPath(new JSONObject().put("mimeType", cursor.getString(2))
                        .put("size", cursor.getLong(3)).put("sha256", cursor.getString(4))));
                } catch (Exception error) { row.put("error", error.getMessage()); }
                output.put(row);
            }
        }
        return output;
    }

    JSONObject readBlobChunk(String store, String key, String fieldPath, long offset, int requestedBytes) {
        JSONObject metadata = blobMetadata(store, key, fieldPath);
        if (metadata == null) return null;
        int length = (int) Math.max(0, Math.min(Math.min(requestedBytes, MAX_BLOB_CHUNK_BYTES), metadata.optLong("size") - offset));
        if (offset < 0 || offset > metadata.optLong("size") || requestedBytes < 1) throw new IllegalArgumentException("原生二进制读取范围无效");
        byte[] bytes = new byte[length];
        String hash = metadata.optString("sha256");
        File source = blobFile("blobs/" + hash.substring(0, 2) + "/" + hash + ".bin");
        try (RandomAccessFile input = new RandomAccessFile(source, "r")) {
            if (source.length() != metadata.optLong("size")) throw new IllegalStateException("原生二进制文件大小校验失败");
            input.seek(offset); input.readFully(bytes);
            metadata.put("offset", offset); metadata.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
            metadata.put("eof", offset + length >= metadata.optLong("size"));
            return metadata;
        } catch (Exception error) { throw new IllegalStateException("原生二进制读取失败", error); }
    }

    void deleteBlob(String store, String key, String fieldPath) {
        requireStore(store); requireKey(key); requireFieldPath(fieldPath);
        JSONObject metadata = blobMetadata(store, key, fieldPath);
        SQLiteDatabase database = getWritableDatabase();
        String pendingPath = null;
        try (Cursor cursor = database.query("app_blob_pending", new String[] {"relative_path"},
            "store_name = ? AND record_key = ? AND field_path = ?",
            new String[] {store, key, fieldPath}, null, null, null, "1")) {
            if (cursor.moveToFirst()) pendingPath = cursor.getString(0);
        }
        database.beginTransaction();
        try {
            database.delete("app_blobs", "store_name = ? AND record_key = ? AND field_path = ?", new String[] {store, key, fieldPath});
            database.delete("app_blob_pending", "store_name = ? AND record_key = ? AND field_path = ?", new String[] {store, key, fieldPath});
            database.setTransactionSuccessful();
        } finally { database.endTransaction(); }
        if (pendingPath != null) blobFile(pendingPath).delete();
        if (metadata != null) removeUnreferencedBlob(metadata.optString("sha256"));
    }

    private void removeUnreferencedBlob(String hash) {
        if (hash == null || !hash.matches("[a-f0-9]{64}")) return;
        try (Cursor cursor = getReadableDatabase().rawQuery("SELECT COUNT(*) FROM app_blobs WHERE sha256 = ?", new String[] {hash})) {
            if (cursor.moveToFirst() && cursor.getLong(0) == 0) blobFile("blobs/" + hash.substring(0, 2) + "/" + hash + ".bin").delete();
        }
    }

    private JSONObject blobMetadata(String store, String key, String fieldPath) {
        requireStore(store); requireKey(key); requireFieldPath(fieldPath);
        try (Cursor cursor = getReadableDatabase().query("app_blobs", new String[] {"mime_type", "byte_length", "sha256"}, "store_name = ? AND record_key = ? AND field_path = ?", new String[] {store, key, fieldPath}, null, null, null, "1")) {
            if (!cursor.moveToFirst()) return null;
            return new JSONObject().put("store", store).put("key", key).put("fieldPath", fieldPath)
                .put("mimeType", cursor.getString(0)).put("size", cursor.getLong(1)).put("sha256", cursor.getString(2));
        } catch (Exception error) { throw new IllegalStateException("原生二进制索引读取失败", error); }
    }

    private JSONObject getPendingBlob(String token) {
        try (Cursor cursor = getReadableDatabase().query("app_blob_pending", new String[] {"store_name", "record_key", "field_path", "mime_type", "expected_size", "relative_path", "source_sha256"}, "token = ?", new String[] {token}, null, null, null, "1")) {
            if (!cursor.moveToFirst()) throw new IllegalArgumentException("原生二进制迁移令牌无效");
            return new JSONObject().put("store", cursor.getString(0)).put("key", cursor.getString(1)).put("fieldPath", cursor.getString(2))
                .put("mimeType", cursor.getString(3)).put("expectedSize", cursor.getLong(4)).put("relativePath", cursor.getString(5)).put("sourceSha256", cursor.getString(6));
        } catch (IllegalArgumentException error) { throw error; }
        catch (Exception error) { throw new IllegalStateException("原生二进制迁移状态读取失败", error); }
    }

    private void deletePendingForField(SQLiteDatabase database, String store, String key, String fieldPath) {
        try (Cursor cursor = database.query("app_blob_pending", new String[] {"relative_path"}, "store_name = ? AND record_key = ? AND field_path = ?", new String[] {store, key, fieldPath}, null, null, null, "1")) {
            if (cursor.moveToFirst()) blobFile(cursor.getString(0)).delete();
        }
        database.delete("app_blob_pending", "store_name = ? AND record_key = ? AND field_path = ?", new String[] {store, key, fieldPath});
    }

    private File blobFile(String relativePath) {
        if (relativePath == null || relativePath.startsWith("/") || relativePath.contains("..") || !relativePath.matches("[A-Za-z0-9._/-]{1,256}"))
            throw new IllegalArgumentException("原生二进制路径无效");
        File root = new File(context.getFilesDir(), "srl-app-data");
        File file = new File(root, relativePath);
        try { if (!file.getCanonicalPath().startsWith(root.getCanonicalPath() + File.separator)) throw new IllegalArgumentException("原生二进制路径越界"); }
        catch (java.io.IOException error) { throw new IllegalStateException("原生二进制路径校验失败", error); }
        return file;
    }

    private static void requireFieldPath(String value) {
        if (value == null || value.isBlank() || value.length() > 2048) throw new IllegalArgumentException("原生二进制字段路径无效");
    }

    private static String toHex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) result.append(String.format(java.util.Locale.ROOT, "%02x", value & 0xff));
        return result.toString();
    }

    static void requireStore(String store) {
        if (store == null || !STORES.contains(store)) throw new IllegalArgumentException("原生数据库表名无效");
    }

    static void requireKey(String key) {
        if (key == null || key.isEmpty() || key.length() > 2048) throw new IllegalArgumentException("原生数据库记录键无效");
    }

    JSONObject getRecord(String store, String key) {
        requireStore(store); requireKey(key);
        noteRead(store);
        try (Cursor cursor = getReadableDatabase().query("app_records", new String[] {"payload_json"}, "store_name = ? AND record_key = ?", new String[] {store, key}, null, null, null, "1")) {
            return cursor.moveToFirst() ? new JSONObject(cursor.getString(0)) : null;
        } catch (Exception error) { throw new IllegalStateException("原生数据库记录读取失败", error); }
    }

    JSONArray getRecords(String store, String afterKey, int limit) {
        return getRecords(store, afterKey, limit, null);
    }

    static JSONObject projectRecord(JSONObject source, JSONArray fields) throws Exception {
        if (fields == null) return source;
        if (fields.length() > 32) throw new IllegalArgumentException("元数据字段数量无效");
        JSONObject result = new JSONObject();
        for (int index = 0; index < fields.length(); index++) {
            String path = fields.getString(index);
            if (path.length() > 128 || !path.matches("[A-Za-z_][A-Za-z0-9_]*(\\.[A-Za-z_][A-Za-z0-9_]*)*"))
                throw new IllegalArgumentException("元数据字段路径无效");
            String[] segments = path.split("\\."); JSONObject input = source, output = result;
            for (int segment = 0; segment < segments.length; segment++) {
                String key = segments[segment];
                if (!input.has(key)) break;
                if (segment == segments.length - 1) { output.put(key, input.get(key)); break; }
                input = input.optJSONObject(key); if (input == null) break;
                JSONObject child = output.optJSONObject(key);
                if (child == null) { child = new JSONObject(); output.put(key, child); }
                output = child;
            }
        }
        return result;
    }

    JSONArray getRecords(String store, String afterKey, int limit, JSONArray fields) {
        requireStore(store);
        noteRead(store);
        if (limit < 1 || limit > MAX_BATCH_SIZE) throw new IllegalArgumentException("原生数据库分页大小无效");
        try (Cursor cursor = afterKey == null || afterKey.isEmpty()
            ? getReadableDatabase().query("app_records", new String[] {"record_key", "payload_json"}, "store_name = ?", new String[] {store}, null, null, "record_key ASC", String.valueOf(limit))
            : getReadableDatabase().query("app_records", new String[] {"record_key", "payload_json"}, "store_name = ? AND record_key > ?", new String[] {store, afterKey}, null, null, "record_key ASC", String.valueOf(limit))) {
            JSONArray rows = new JSONArray();
            while (cursor.moveToNext()) rows.put(new JSONObject().put("key", cursor.getString(0)).put("value", projectRecord(new JSONObject(cursor.getString(1)), fields)));
            return rows;
        } catch (Exception error) { throw new IllegalStateException("原生数据库分页读取失败", error); }
    }

    JSONArray getRecordKeys(String store, String afterKey, int limit) {
        requireStore(store);
        noteRead(store);
        if (limit < 1 || limit > MAX_BATCH_SIZE) throw new IllegalArgumentException("原生数据库键分页大小无效");
        String selection = "store_name = ?";
        String[] arguments;
        if (afterKey == null || afterKey.isEmpty()) arguments = new String[] {store};
        else { selection += " AND record_key > ?"; arguments = new String[] {store, afterKey}; }
        try (Cursor cursor = getReadableDatabase().query("app_records", new String[] {"record_key"},
            selection, arguments, null, null, "record_key ASC", String.valueOf(limit))) {
            JSONArray keys = new JSONArray();
            while (cursor.moveToNext()) keys.put(cursor.getString(0));
            return keys;
        } catch (Exception error) { throw new IllegalStateException("原生数据库键分页读取失败", error); }
    }

    JSONArray getRecentRecordsByIndex(String store, String indexName, int limit) {
        return getRecentRecordsByIndex(store, indexName, limit, null, null);
    }

    JSONArray getRecentRecordsByIndex(String store, String indexName, int limit, String filterIndex, String filterKey) {
        requireStore(store);
        noteRead(store);
        if ("communitySources".equals(store)) noteRead("resourceSourceBindings");
        if (indexName == null || indexName.isBlank() || indexName.length() > 256 || limit < 1 || limit > 200)
            throw new IllegalArgumentException("原生数据库最近记录查询参数无效");
        String unboundSource = "communitySources".equals(store)
            ? " AND NOT EXISTS (SELECT 1 FROM app_record_indexes b WHERE b.store_name = 'resourceSourceBindings' " +
                "AND b.index_name = 'sourceId' AND b.index_key = r.record_key)"
            : "";
        String filter = filterIndex == null ? "" : " AND EXISTS (SELECT 1 FROM app_record_indexes f " +
            "WHERE f.store_name = r.store_name AND f.record_key = r.record_key AND f.index_name = ? AND f.index_key = ?)";
        if (filterIndex != null) { requireKey(filterIndex); requireKey(filterKey); }
        String[] arguments = filterIndex == null ? new String[] {store, store, indexName, String.valueOf(limit)}
            : new String[] {store, store, indexName, filterIndex, filterKey, String.valueOf(limit)};
        if (filterIndex != null && "updatedAt".equals(indexName)) {
            // Seek lightweight timestamp/type indexes before loading the selected five payloads.
            try (Cursor cursor = getReadableDatabase().rawQuery(
                "SELECT r.record_key, r.payload_json FROM (SELECT i.record_key, i.index_sort_key, i.record_sort_key FROM app_record_indexes i " +
                "WHERE i.store_name = ? AND i.index_name = ? AND EXISTS " +
                "(SELECT 1 FROM app_record_indexes f WHERE f.store_name = i.store_name AND f.record_key = i.record_key " +
                "AND f.index_name = ? AND f.index_key = ?) ORDER BY i.index_sort_key DESC, i.record_sort_key DESC LIMIT ?) recent " +
                "JOIN app_records r ON r.store_name = ? AND r.record_key = recent.record_key ORDER BY recent.index_sort_key DESC, recent.record_sort_key DESC",
                new String[]{store, indexName, filterIndex, filterKey, String.valueOf(limit), store})) {
                JSONArray rows = new JSONArray();
                while (cursor.moveToNext()) rows.put(new JSONObject().put("key", cursor.getString(0)).put("value", new JSONObject(cursor.getString(1))));
                return rows;
            } catch (Exception error) { throw new IllegalStateException("原生数据库最近记录读取失败", error); }
        }
        try (Cursor cursor = getReadableDatabase().rawQuery(
            "SELECT r.record_key, r.payload_json FROM app_records r " +
                "JOIN app_record_indexes i ON i.store_name = r.store_name AND i.record_key = r.record_key " +
                "WHERE r.store_name = ? AND i.store_name = ? AND i.index_name = ? " + unboundSource + filter + " " +
                "GROUP BY r.record_key ORDER BY CAST(trim(i.index_key, '\"') AS INTEGER) DESC, r.record_key DESC LIMIT ?",
            arguments)) {
            JSONArray rows = new JSONArray();
            while (cursor.moveToNext()) rows.put(new JSONObject()
                .put("key", cursor.getString(0)).put("value", new JSONObject(cursor.getString(1))));
            return rows;
        } catch (Exception error) { throw new IllegalStateException("原生数据库最近记录读取失败", error); }
    }

    JSONArray getRecordsByKeys(String store, JSONArray keys) {
        requireStore(store);
        noteRead(store);
        if (keys == null || keys.length() > 900) throw new IllegalArgumentException("原生数据库键批次无效");
        if (keys.length() == 0) return new JSONArray();
        StringBuilder placeholders = new StringBuilder();
        String[] arguments = new String[keys.length() + 1]; arguments[0] = store;
        for (int index = 0; index < keys.length(); index++) {
            String key = keys.optString(index, ""); requireKey(key);
            if (index > 0) placeholders.append(',');
            placeholders.append('?'); arguments[index + 1] = key;
        }
        try (Cursor cursor = getReadableDatabase().query("app_records", new String[] {"record_key", "payload_json"},
            "store_name = ? AND record_key IN (" + placeholders + ")", arguments, null, null, "record_key ASC")) {
            JSONArray rows = new JSONArray();
            while (cursor.moveToNext()) rows.put(new JSONObject().put("key", cursor.getString(0)).put("value", new JSONObject(cursor.getString(1))));
            return rows;
        } catch (Exception error) { throw new IllegalStateException("原生数据库批量核验读取失败", error); }
    }

    boolean haveSameRecordKeys(String leftStore, String rightStore) {
        requireStore(leftStore); requireStore(rightStore);
        noteRead(leftStore); noteRead(rightStore);
        // Compare the existing covering primary-key index inside SQLite. Equal counts alone
        // cannot detect a missing summary paired with an unrelated stale summary.
        String sql = "SELECT NOT EXISTS (SELECT 1 FROM app_records a WHERE a.store_name = ? " +
            "AND NOT EXISTS (SELECT 1 FROM app_records b WHERE b.store_name = ? AND b.record_key = a.record_key)) " +
            "AND NOT EXISTS (SELECT 1 FROM app_records a WHERE a.store_name = ? " +
            "AND NOT EXISTS (SELECT 1 FROM app_records b WHERE b.store_name = ? AND b.record_key = a.record_key))";
        try (Cursor cursor = getReadableDatabase().rawQuery(sql,
                new String[] {leftStore, rightStore, rightStore, leftStore})) {
            return cursor.moveToFirst() && cursor.getInt(0) == 1;
        }
    }

    long countIndexEntries(String store, String indexName, String indexKey) {
        noteRead(store);
        requireStore(store);
        if (indexName == null || indexName.isBlank() || indexName.length() > 256)
            throw new IllegalArgumentException("原生数据库索引名无效");
        String selection = "store_name = ? AND index_name = ?";
        String[] arguments = new String[] {store, indexName};
        if (indexKey != null) {
            requireKey(indexKey);
            selection += " AND index_key = ?";
            arguments = new String[] {store, indexName, indexKey};
        }
        try (Cursor cursor = getReadableDatabase().rawQuery("SELECT COUNT(*) FROM app_record_indexes WHERE " + selection, arguments)) {
            return cursor.moveToFirst() ? cursor.getLong(0) : 0L;
        }
    }

    JSONArray getIndexEntries(String store, String indexName, String indexKey) {
        noteRead(store);
        requireStore(store);
        if (indexName == null || indexName.isBlank() || indexName.length() > 256)
            throw new IllegalArgumentException("原生数据库索引名无效");
        String selection = "store_name = ? AND index_name = ?";
        String[] arguments;
        if (indexKey == null) arguments = new String[] {store, indexName};
        else { selection += " AND index_key = ?"; arguments = new String[] {store, indexName, indexKey}; }
        try (Cursor cursor = getReadableDatabase().query("app_record_indexes",
            new String[] {"index_key", "record_key"}, selection, arguments, null, null,
            "index_key ASC, record_key ASC")) {
            JSONArray rows = new JSONArray();
            while (cursor.moveToNext()) rows.put(new JSONObject()
                .put("indexKey", cursor.getString(0)).put("primaryKey", cursor.getString(1)));
            return rows;
        } catch (Exception error) { throw new IllegalStateException("原生数据库索引读取失败", error); }
    }

    /** Explicit pre-cleanup audit: stream records/files locally, never bridge their payloads. */
    JSONObject verifyStore(String store) {
        requireStore(store);
        SQLiteDatabase database = getWritableDatabase();
        database.beginTransaction();
        try {
            try (Cursor check = database.rawQuery("PRAGMA quick_check", null)) {
                if (!check.moveToFirst() || !"ok".equals(check.getString(0)))
                    throw new IllegalStateException("原生数据库完整性检查未通过；保留旧副本");
            }
            Map<String, Long> verifiedHashes = new HashMap<>();
            long bytes = 0L;
            int records = 0;
            try (Cursor cursor = database.query("app_records", new String[] {"record_key", "payload_json"},
                    "store_name = ?", new String[] {store}, null, null, "record_key ASC")) {
                while (cursor.moveToNext()) {
                    JSONObject row = new JSONObject(cursor.getString(1));
                    String key = cursor.getString(0);
                    bytes += verifyBlobReferences(store, key, row, verifiedHashes);
                    if (("resources".equals(store) || "resourceVersions".equals(store)) && row.has("nativeOriginal")) {
                        JSONObject original = row.getJSONObject("nativeOriginal");
                        if (original.getInt("version") != 1) throw new IllegalStateException("原生原件引用版本无法识别");
                        String hash = readSmallEncodedString(store, key, original.get("contentHash"));
                        long size = original.getLong("size");
                        String identity = "library:" + hash;
                        Long previousSize = verifiedHashes.putIfAbsent(identity, size);
                        if (previousSize != null && previousSize.longValue() != size)
                            throw new IllegalStateException("同一原生原件存在不一致的大小声明");
                        if (previousSize == null) {
                            if (!NativeCloudRestoreTransport.verifyFile(NativeLibraryPlugin.objectFile(context, hash), hash, size))
                                throw new IllegalStateException("原生资源原件缺失或内容校验失败：" + store + "/" + key);
                            bytes += size;
                        }
                    }
                    records++;
                }
            }
            database.setTransactionSuccessful();
            return new JSONObject().put("records", records).put("files", verifiedHashes.size()).put("bytes", bytes);
        } catch (Exception error) { throw new IllegalStateException("原生数据校验失败；旧 IndexedDB 副本未清理：" + error.getMessage(), error); }
        finally { database.endTransaction(); }
    }

    private String readSmallEncodedString(String store, String key, Object value) throws Exception {
        if (value instanceof String) return (String) value;
        if (value instanceof JSONObject) {
            JSONObject encoded = (JSONObject) value;
            if ("text".equals(encoded.optString("__srlAppDatabaseValueV1")) && encoded.getLong("size") <= 1024L) {
                JSONObject chunk = readBlobChunk(store, key, encoded.getString("fieldPath"), 0L, 1024);
                if (chunk != null && chunk.optBoolean("eof"))
                    return new String(Base64.decode(chunk.getString("data"), Base64.NO_WRAP), java.nio.charset.StandardCharsets.UTF_8);
            }
        }
        throw new IllegalStateException("原生原件内容身份无法识别");
    }

    private long verifyBlobReferences(String store, String key, Object value, Map<String, Long> verified) throws Exception {
        long bytes = 0L;
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value;
            String kind = object.optString("__srlAppDatabaseValueV1", "");
            if (Arrays.asList("blob", "file", "text", "array-buffer", "typed-array").contains(kind)) {
                // Older background imports left the final record key in this marker.
                // Only that exact owner is compatible; metadata and full file hashes
                // below still gate deletion of the old IndexedDB copy.
                if (object.has("blobOwnerKey") && !key.equals(object.optString("blobOwnerKey")))
                    throw new IllegalStateException("存在未提交的附件引用");
                JSONObject metadata = blobMetadata(store, key, object.getString("fieldPath"));
                String expected = object.getString("sha256");
                long size = object.getLong("size");
                if (metadata == null || !expected.equals(metadata.getString("sha256")) || size != metadata.getLong("size") ||
                    !object.getString("mimeType").equals(metadata.getString("mimeType")))
                    throw new IllegalStateException("附件索引缺失或不一致：" + store + "/" + key);
                if (!expected.matches("[a-f0-9]{64}")) throw new IllegalStateException("附件哈希无效");
                Long previousSize = verified.putIfAbsent(expected, size);
                if (previousSize != null && previousSize.longValue() != size)
                    throw new IllegalStateException("同一原生附件存在不一致的大小声明");
                if (previousSize == null) {
                    File source = blobFile("blobs/" + expected.substring(0, 2) + "/" + expected + ".bin");
                    if (!source.isFile() || source.length() != size) throw new IllegalStateException("附件文件缺失或大小不一致");
                    MessageDigest digest = MessageDigest.getInstance("SHA-256");
                    try (FileInputStream input = new FileInputStream(source)) {
                        byte[] buffer = new byte[128 * 1024]; int count;
                        while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
                    }
                    if (!expected.equals(toHex(digest.digest()))) throw new IllegalStateException("附件内容校验失败");
                    bytes += size;
                }
            } else {
                java.util.Iterator<String> keys = object.keys();
                while (keys.hasNext()) bytes += verifyBlobReferences(store, key, object.opt(keys.next()), verified);
            }
        } else if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value;
            for (int i = 0; i < array.length(); i++) bytes += verifyBlobReferences(store, key, array.opt(i), verified);
        }
        return bytes;
    }

    void putRecords(String store, JSONArray rows) {
        requireStore(store);
        if (rows == null || rows.length() > MAX_BATCH_SIZE) throw new IllegalArgumentException("原生数据库写入批次无效");
        SQLiteDatabase database = getWritableDatabase();
        Set<String> hashes = new HashSet<>();
        database.beginTransaction();
        try {
            checkRevisions(database, null);
            putRecordsWithinTransaction(database, store, rows, hashes);
            database.setTransactionSuccessful();
        } finally { database.endTransaction(); }
        for (String hash : hashes) removeUnreferencedBlob(hash);
    }

    void putRecordsWithState(String store, JSONArray rows, String stateKey, String stateValue) {
        requireStore(store);
        requireKey(stateKey);
        if (rows == null || rows.length() > MAX_BATCH_SIZE)
            throw new IllegalArgumentException("原生数据库写入批次无效");
        SQLiteDatabase database = getWritableDatabase();
        Set<String> hashes = new HashSet<>();
        database.beginTransaction();
        try {
            checkRevisions(database, null);
            putRecordsWithinTransaction(database, store, rows, hashes);
            ContentValues state = new ContentValues();
            state.put("state_key", stateKey);
            state.put("state_value", stateValue == null ? "" : stateValue);
            database.insertWithOnConflict("app_state", null, state, SQLiteDatabase.CONFLICT_REPLACE);
            database.setTransactionSuccessful();
        } finally { database.endTransaction(); }
        for (String hash : hashes) removeUnreferencedBlob(hash);
    }

    /** Apply coordinated records from multiple stores in one SQLite transaction. */
    void applyBatch(JSONArray operations) {
        applyBatch(operations, false);
    }

    /** Optionally prevent background imports from committing while the library is rolling back. */
    void applyBatch(JSONArray operations, boolean requireActiveLibrary) {
        applyBatch(operations, requireActiveLibrary, null);
    }

    JSONObject queryKeyPage(String store, JSONObject request) {
        requireStore(store); noteRead(store);
        if (request == null) throw new IllegalArgumentException("原生范围查询缺失");
        SQLiteDatabase database = getWritableDatabase();
        database.beginTransactionNonExclusive();
        try {
            String revision = getState("revision:appdb:v1:" + store);
            if (revision == null) revision = "0";
            if (request.has("revision") && !revision.equals(request.optString("revision")))
                throw new IllegalStateException("原生查询期间数据已变化，请重新打开列表");
            JSONObject result = NativeDatabaseKeyQuery.query(database, store, request).put("revision", revision);
            database.setTransactionSuccessful();
            return result;
        } catch (Exception error) { throw new IllegalStateException("原生范围查询失败", error); }
        finally { database.endTransaction(); }
    }

    void applyBatch(JSONArray operations, boolean requireActiveLibrary, JSONObject expectedRevisions) {
        if (operations == null || operations.length() == 0 || operations.length() > 100)
            throw new IllegalArgumentException("原生数据库操作批次无效");
        SQLiteDatabase database = getWritableDatabase();
        Set<String> hashes = new HashSet<>();
        Set<String> pendingPaths = new HashSet<>();
        database.beginTransaction();
        Map<String, Long> previousGuard = readGuard.get() == null ? null : new HashMap<>(readGuard.get());
        boolean committed = false;
        try {
            if (requireActiveLibrary) requireActiveLibrary(database);
            checkRevisions(database, expectedRevisions);
            for (int index = 0; index < operations.length(); index++) {
                JSONObject operation = operations.optJSONObject(index);
                if (operation == null) throw new IllegalArgumentException("原生数据库操作格式无效");
                String store = operation.optString("store", "");
                requireStore(store);
                String type = operation.optString("type", "");
                if ("put".equals(type)) {
                    JSONArray rows = operation.optJSONArray("rows");
                    if (rows == null || rows.length() > MAX_BATCH_SIZE)
                        throw new IllegalArgumentException("原生数据库写入批次无效");
                    putRecordsWithinTransaction(database, store, rows, hashes);
                } else if ("delete".equals(type)) {
                    JSONArray keys = operation.optJSONArray("keys");
                    if (keys == null || keys.length() > MAX_BATCH_SIZE)
                        throw new IllegalArgumentException("原生数据库删除批次无效");
                    deleteRecordsWithinTransaction(database, store, keys, hashes);
                } else if ("moveBlobs".equals(type)) {
                    String fromStore = operation.optString("fromStore", "");
                    String fromKey = operation.optString("fromKey", "");
                    String toStore = operation.optString("toStore", "");
                    String toKey = operation.optString("toKey", "");
                    requireStore(fromStore); requireKey(fromKey);
                    requireStore(toStore); requireKey(toKey);
                    moveBlobReferencesWithinTransaction(database, fromStore, fromKey, toStore, toKey);
                } else if ("clear".equals(type)) {
                    collectStoreBlobHashes(database, store, hashes);
                    collectStorePendingPaths(database, store, pendingPaths);
                    database.delete("app_records", "store_name = ?", new String[] {store});
                    database.delete("app_record_indexes", "store_name = ?", new String[] {store});
                    database.delete("app_blobs", "store_name = ?", new String[] {store});
                    database.delete("app_blob_pending", "store_name = ?", new String[] {store});
                    bumpRevision(database, store);
                } else {
                    throw new IllegalArgumentException("原生数据库操作类型无效");
                }
            }
            database.setTransactionSuccessful();
            committed = true;
        } finally {
            database.endTransaction();
            if (!committed && previousGuard != null) readGuard.set(previousGuard);
        }
        for (String path : pendingPaths) blobFile(path).delete();
        for (String hash : hashes) removeUnreferencedBlob(hash);
    }

    /** Hold the existing SQLite writer lock across reference checks and the selected filesystem action. */
    JSONObject deleteUnreferencedRecoveryCandidates(JSONArray candidates, RecoveryDeletionAction action) throws Exception {
        SQLiteDatabase database = getWritableDatabase();
        database.beginTransaction();
        try {
            requireActiveLibrary(database);
            Set<String> protectedHashes = new HashSet<>();
            for (int i = 0; i < candidates.length(); i++) {
                JSONObject item = candidates.getJSONObject(i);
                String hash = item.getString("contentHash");
                JSONObject query = new JSONObject().put("indexName", "contentHash").put("lower", JSONObject.quote(hash))
                    .put("upper", JSONObject.quote(hash)).put("countOnly", true);
                if (NativeDatabaseKeyQuery.query(database, "resources", query).getLong("count") > 0
                    || NativeDatabaseKeyQuery.query(database, "resourceVersions", query).getLong("count") > 0
                    || (item.has("nativeId") && getRecord("resources", JSONObject.quote(item.getString("nativeId"))) != null)) protectedHashes.add(hash);
            }
            for (String store : new String[] { "settings", "restoreStaging" }) {
                String after = null;
                JSONArray fields = new JSONArray(store.equals("settings") ? "[\"id\",\"value.contentHash\"]" : "[\"record.resource.contentHash\",\"record.resource.nativeOriginal.contentHash\"]");
                for (;;) {
                    JSONArray rows = getRecords(store, after, 100, fields);
                    for (int i = 0; i < rows.length(); i++) {
                        JSONObject value = rows.getJSONObject(i).getJSONObject("value");
                        if (store.equals("settings")) {
                            if (value.optString("id").startsWith("native-recovery-link:") && value.optJSONObject("value") != null)
                                protectedHashes.add(value.getJSONObject("value").optString("contentHash"));
                        } else if (value.optJSONObject("record") != null) {
                            JSONObject record = value.getJSONObject("record").optJSONObject("resource");
                            if (record != null) {
                                protectedHashes.add(record.optString("contentHash"));
                                if (record.optJSONObject("nativeOriginal") != null) protectedHashes.add(record.getJSONObject("nativeOriginal").optString("contentHash"));
                            }
                        }
                    }
                    if (rows.length() < 100) break;
                    after = rows.getJSONObject(rows.length() - 1).getString("key");
                }
            }
            JSONObject result = action.run(protectedHashes);
            database.setTransactionSuccessful();
            return result;
        } finally { database.endTransaction(); }
    }

    interface RecoveryDeletionAction { JSONObject run(Set<String> protectedHashes) throws Exception; }

    private static void requireActiveLibrary(SQLiteDatabase database) {
        try (Cursor cursor = database.query("app_state", new String[] {"state_value"},
            "state_key = ?", new String[] {"migration:appdb:v1:active"}, null, null, null)) {
            if (!cursor.moveToFirst()) throw new IllegalStateException("原生资源库尚未启用");
            JSONObject state = new JSONObject(cursor.getString(0));
            String mode = state.optString("mode", "active");
            if (state.optInt("version") != 1 || !("active".equals(mode) || "".equals(mode)))
                throw new IllegalStateException("原生资源库正在切换存储，后台导入已暂停");
        } catch (org.json.JSONException error) {
            throw new IllegalStateException("原生资源库状态无效，后台导入已暂停", error);
        }
        try (Cursor cursor = database.query("app_state", new String[] {"state_value"},
            "state_key = ?", new String[] {"migration:appdb:indexes:v1:active"}, null, null, null)) {
            if (!cursor.moveToFirst() || !"verified-v1".equals(cursor.getString(0)))
                throw new IllegalStateException("原生资源库索引正在初始化，后台写入已暂停");
        }
    }

    private void putRecordsWithinTransaction(SQLiteDatabase database, String store, JSONArray rows,
                                             Set<String> cleanupHashes) {
        for (int index = 0; index < rows.length(); index++) {
            JSONObject row = rows.optJSONObject(index);
            if (row == null) throw new IllegalArgumentException("原生数据库记录格式无效");
            String key = row.optString("key", "");
            JSONObject value = row.optJSONObject("value");
            requireKey(key);
            if (value == null || value.toString().length() > MAX_ROW_JSON_CHARS)
                throw new IllegalArgumentException("原生数据库记录内容无效或过大");
            // Never mutate the request object: SQLite may roll back this batch, and the caller
            // may retry with the same in-memory descriptor that still needs its staging owner.
            JSONObject storedValue;
            try { storedValue = new JSONObject(value.toString()); }
            catch (Exception error) { throw new IllegalArgumentException("原生数据库记录内容无效", error); }
            attachStagedBlobReferences(database, store, key, storedValue, cleanupHashes);
            Set<String> attachmentPaths = new HashSet<>();
            collectBlobFieldPaths(storedValue, attachmentPaths);
            ArrayList<String[]> staleAttachments = new ArrayList<>();
            try (Cursor cursor = database.query("app_blobs", new String[] {"field_path", "sha256"},
                "store_name = ? AND record_key = ?", new String[] {store, key}, null, null, null)) {
                while (cursor.moveToNext()) {
                    String path = cursor.getString(0);
                    if (!attachmentPaths.contains(path)) {
                        staleAttachments.add(new String[] {path, cursor.getString(1)});
                    }
                }
            }
            for (String[] attachment : staleAttachments) {
                cleanupHashes.add(attachment[1]);
                database.delete("app_blobs", "store_name = ? AND record_key = ? AND field_path = ?",
                    new String[] {store, key, attachment[0]});
            }
            ContentValues values = new ContentValues();
            values.put("store_name", store);
            values.put("record_key", key);
            values.put("record_sort_key", NativeDatabaseKeyOrder.key(key));
            values.put("payload_json", storedValue.toString());
            values.put("updated_at", System.currentTimeMillis());
            if (database.insertWithOnConflict("app_records", null, values, SQLiteDatabase.CONFLICT_REPLACE) < 0)
                throw new IllegalStateException("原生数据库记录写入失败");
            replaceIndexEntries(database, store, key, row.optJSONArray("indexes"));
        }
        if (rows.length() > 0) bumpRevision(database, store);
    }

    private void replaceIndexEntries(SQLiteDatabase database, String store, String key, JSONArray indexes) {
        database.delete("app_record_indexes", "store_name = ? AND record_key = ?", new String[] {store, key});
        if (indexes == null) return;
        String recordOrder = NativeDatabaseKeyOrder.key(key);
        for (int index = 0; index < indexes.length(); index++) {
            JSONObject entry = indexes.optJSONObject(index);
            if (entry == null) throw new IllegalArgumentException("原生数据库索引条目无效");
            String name = entry.optString("name", "");
            JSONArray keys = entry.optJSONArray("keys");
            if (name.isBlank() || name.length() > 256 || keys == null || keys.length() > MAX_BATCH_SIZE)
                throw new IllegalArgumentException("原生数据库索引内容无效");
            for (int keyIndex = 0; keyIndex < keys.length(); keyIndex++) {
                String encodedKey = keys.optString(keyIndex, "");
                if (encodedKey.isEmpty() || encodedKey.length() > 2048)
                    throw new IllegalArgumentException("原生数据库索引键无效");
                ContentValues values = new ContentValues();
                values.put("store_name", store); values.put("index_name", name);
                values.put("index_key", encodedKey); values.put("record_key", key);
                values.put("index_sort_key", NativeDatabaseKeyOrder.key(encodedKey));
                values.put("record_sort_key", recordOrder);
                database.insertWithOnConflict("app_record_indexes", null, values, SQLiteDatabase.CONFLICT_REPLACE);
            }
        }
    }

    private static void moveBlobReferencesWithinTransaction(SQLiteDatabase database, String fromStore,
                                                             String fromKey, String toStore, String toKey) {
        ArrayList<ContentValues> references = new ArrayList<>();
        try (Cursor cursor = database.query("app_blobs",
            new String[] {"field_path", "mime_type", "byte_length", "sha256"},
            "store_name = ? AND record_key = ?", new String[] {fromStore, fromKey}, null, null, null)) {
            while (cursor.moveToNext()) {
                ContentValues target = new ContentValues();
                target.put("store_name", toStore); target.put("record_key", toKey);
                target.put("field_path", cursor.getString(0)); target.put("mime_type", cursor.getString(1));
                target.put("byte_length", cursor.getLong(2)); target.put("sha256", cursor.getString(3));
                references.add(target);
            }
        }
        for (ContentValues reference : references) {
            if (database.insertWithOnConflict("app_blobs", null, reference, SQLiteDatabase.CONFLICT_REPLACE) < 0)
                throw new IllegalStateException("原生资源版本附件关联失败");
        }
        database.delete("app_blobs", "store_name = ? AND record_key = ?", new String[] {fromStore, fromKey});
    }

    private void attachStagedBlobReferences(SQLiteDatabase database, String store, String key,
                                            Object value, Set<String> cleanupHashes) {
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value;
            String kind = object.optString("__srlAppDatabaseValueV1", "");
            String fieldPath = object.optString("fieldPath", "");
            String ownerKey = object.optString("blobOwnerKey", key);
            if (Arrays.asList("blob", "file", "text", "array-buffer", "typed-array").contains(kind)
                && !fieldPath.isEmpty() && object.has("blobOwnerKey")) {
                requireKey(ownerKey);
                String mimeType;
                long byteLength;
                String sha256;
                try (Cursor source = database.query("app_blobs", new String[] {"mime_type", "byte_length", "sha256"},
                    "store_name = ? AND record_key = ? AND field_path = ?",
                    new String[] {store, ownerKey, fieldPath}, null, null, null, "1")) {
                    if (!source.moveToFirst()) throw new IllegalStateException("事务暂存附件已丢失");
                    mimeType = source.getString(0);
                    byteLength = source.getLong(1);
                    sha256 = source.getString(2);
                }
                if (!sha256.equals(object.optString("sha256")) || byteLength != object.optLong("size", -1L)
                    || !mimeType.equals(object.optString("mimeType")))
                    throw new IllegalStateException("附件索引缺失或不一致：" + store + "/" + key);
                if (key.equals(ownerKey)) {
                    object.remove("blobOwnerKey");
                    return;
                }
                try (Cursor previous = database.query("app_blobs", new String[] {"sha256"},
                    "store_name = ? AND record_key = ? AND field_path = ?",
                    new String[] {store, key, fieldPath}, null, null, null, "1")) {
                    if (previous.moveToFirst() && !sha256.equals(previous.getString(0)))
                        cleanupHashes.add(previous.getString(0));
                }
                ContentValues target = new ContentValues();
                target.put("store_name", store);
                target.put("record_key", key);
                target.put("field_path", fieldPath);
                target.put("mime_type", mimeType);
                target.put("byte_length", byteLength);
                target.put("sha256", sha256);
                database.insertWithOnConflict("app_blobs", null, target, SQLiteDatabase.CONFLICT_REPLACE);
                database.delete("app_blobs", "store_name = ? AND record_key = ? AND field_path = ?",
                    new String[] {store, ownerKey, fieldPath});
                object.remove("blobOwnerKey");
            }
            ArrayList<String> keys = new ArrayList<>();
            java.util.Iterator<String> iterator = object.keys();
            while (iterator.hasNext()) keys.add(iterator.next());
            for (String child : keys) attachStagedBlobReferences(database, store, key, object.opt(child), cleanupHashes);
        } else if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value;
            for (int index = 0; index < array.length(); index++)
                attachStagedBlobReferences(database, store, key, array.opt(index), cleanupHashes);
        }
    }

    private void collectBlobFieldPaths(Object value, Set<String> paths) {
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value;
            String kind = object.optString("__srlAppDatabaseValueV1", "");
            String path = object.optString("fieldPath", "");
            if (Arrays.asList("blob", "file", "text", "array-buffer", "typed-array").contains(kind)
                && !path.isEmpty()) paths.add(path);
            java.util.Iterator<String> keys = object.keys();
            while (keys.hasNext()) collectBlobFieldPaths(object.opt(keys.next()), paths);
        } else if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value;
            for (int index = 0; index < array.length(); index++) collectBlobFieldPaths(array.opt(index), paths);
        }
    }

    private void deleteRecordsWithinTransaction(SQLiteDatabase database, String store, JSONArray keys,
                                                Set<String> hashes) {
        for (int index = 0; index < keys.length(); index++) {
            String key = keys.optString(index, ""); requireKey(key);
            try (Cursor cursor = database.query("app_blobs", new String[] {"sha256"}, "store_name = ? AND record_key = ?", new String[] {store, key}, null, null, null)) {
                while (cursor.moveToNext()) hashes.add(cursor.getString(0));
            }
            database.delete("app_blobs", "store_name = ? AND record_key = ?", new String[] {store, key});
            database.delete("app_record_indexes", "store_name = ? AND record_key = ?", new String[] {store, key});
            database.delete("app_records", "store_name = ? AND record_key = ?", new String[] {store, key});
        }
        if (keys.length() > 0) bumpRevision(database, store);
    }

    private void collectStoreBlobHashes(SQLiteDatabase database, String store, Set<String> hashes) {
        try (Cursor cursor = database.query("app_blobs", new String[] {"sha256"}, "store_name = ?", new String[] {store}, null, null, null)) {
            while (cursor.moveToNext()) hashes.add(cursor.getString(0));
        }
    }

    private void collectStorePendingPaths(SQLiteDatabase database, String store, Set<String> paths) {
        try (Cursor cursor = database.query("app_blob_pending", new String[] {"relative_path"}, "store_name = ?", new String[] {store}, null, null, null)) {
            while (cursor.moveToNext()) paths.add(cursor.getString(0));
        }
    }

    void deleteRecords(String store, JSONArray keys) {
        requireStore(store);
        if (keys == null || keys.length() > MAX_BATCH_SIZE) throw new IllegalArgumentException("原生数据库删除批次无效");
        SQLiteDatabase database = getWritableDatabase();
        Set<String> hashes = new HashSet<>();
        database.beginTransaction();
        try {
            checkRevisions(database, null);
            deleteRecordsWithinTransaction(database, store, keys, hashes);
            database.setTransactionSuccessful();
        } finally { database.endTransaction(); }
        for (String hash : hashes) removeUnreferencedBlob(hash);
    }

    long countRecords(String store) {
        requireStore(store);
        noteRead(store);
        try (Cursor cursor = getReadableDatabase().rawQuery("SELECT COUNT(*) FROM app_records WHERE store_name = ?", new String[] {store})) {
            return cursor.moveToFirst() ? cursor.getLong(0) : 0L;
        }
    }

    String getState(String key) {
        requireStateKey(key);
        try (Cursor cursor = getReadableDatabase().query("app_state", new String[] {"state_value"}, "state_key = ?", new String[] {key}, null, null, null, "1")) {
            return cursor.moveToFirst() ? cursor.getString(0) : null;
        }
    }

    void putState(String key, String value) {
        requireStateKey(key);
        if (value == null || value.length() > 65_536) throw new IllegalArgumentException("原生数据库状态无效");
        ContentValues values = new ContentValues(); values.put("state_key", key); values.put("state_value", value);
        if (getWritableDatabase().insertWithOnConflict("app_state", null, values, SQLiteDatabase.CONFLICT_REPLACE) < 0)
            throw new IllegalStateException("原生数据库状态写入失败");
    }

    private static void requireStateKey(String key) {
        if (key == null || !key.matches("[A-Za-z0-9_.:-]{1,200}")) throw new IllegalArgumentException("原生数据库状态键无效");
    }

    void clearStore(String store) {
        requireStore(store);
        SQLiteDatabase database = getWritableDatabase();
        Set<String> hashes = new HashSet<>();
        Set<String> pendingPaths = new HashSet<>();
        database.beginTransaction();
        try {
            checkRevisions(database, null);
            try (Cursor cursor = database.query("app_blobs", new String[] {"sha256"}, "store_name = ?", new String[] {store}, null, null, null)) {
                while (cursor.moveToNext()) hashes.add(cursor.getString(0));
            }
            try (Cursor cursor = database.query("app_blob_pending", new String[] {"relative_path"}, "store_name = ?", new String[] {store}, null, null, null)) {
                while (cursor.moveToNext()) pendingPaths.add(cursor.getString(0));
            }
            database.delete("app_records", "store_name = ?", new String[] {store});
            database.delete("app_record_indexes", "store_name = ?", new String[] {store});
            database.delete("app_blobs", "store_name = ?", new String[] {store});
            database.delete("app_blob_pending", "store_name = ?", new String[] {store});
            bumpRevision(database, store);
            database.setTransactionSuccessful();
        } finally { database.endTransaction(); }
        for (String path : pendingPaths) blobFile(path).delete();
        for (String hash : hashes) removeUnreferencedBlob(hash);
    }

    void clearIndexes(String store) {
        requireStore(store);
        SQLiteDatabase database = getWritableDatabase(); database.beginTransaction();
        try {
            checkRevisions(database, null);
            database.delete("app_record_indexes", "store_name = ?", new String[] {store});
            bumpRevision(database, store);
            database.setTransactionSuccessful();
        } finally { database.endTransaction(); }
    }
}
