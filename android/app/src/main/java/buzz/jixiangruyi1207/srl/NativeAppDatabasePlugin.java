package buzz.jixiangruyi1207.srl;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import android.util.Base64;
import org.json.JSONArray;
import org.json.JSONObject;

/** Bounded bridge for the app-private SQLite database shared with background Workers. */
@CapacitorPlugin(name = "NativeAppDatabase")
public final class NativeAppDatabasePlugin extends Plugin {
    private NativeAppDatabase database;

    @Override public void load() {
        super.load();
        database = new NativeAppDatabase(getContext());
    }

    @PluginMethod public void compact(PluginCall call) {
        runIo(call, () -> call.resolve(JSObject.fromJSONObject(database.compact())));
    }

    @PluginMethod public void getStatus(PluginCall call) {
        runIo(call, () -> {
            JSObject counts = new JSObject();
            String[] stores = new String[] {
                "resources", "resourceSummaries", "resourceListSummaries", "resourceVersions",
                "resourceVersionSummaries", "categories", "settings", "backupRecords", "externalApps",
                "externalAppRuntimes", "externalAppData", "externalAppDrafts", "frontendWorkshopProjects",
                "frontendWorkshopProjectLastGood", "frontendWorkshopSourceDocuments",
                "frontendWorkshopSourceDocumentLastGood", "frontendWorkshopSourceComponents",
                "generatedImages", "generatedImageFiles", "restoreStaging", "restoreStagingChunks",
                "assets", "assetFiles", "communitySources", "communitySourceMessages",
                "resourceSourceBindings", "cloudBackupJobs", "cloudBackupOrphans"
            };
            for (String store : stores) counts.put(store, database.countRecords(store));
            JSObject result = new JSObject();
            result.put("schemaVersion", NativeAppDatabase.SCHEMA_VERSION);
            result.put("counts", counts);
            call.resolve(result);
        });
    }

    @PluginMethod public void verifyStore(PluginCall call) {
        runIo(call, () -> call.resolve(JSObject.fromJSONObject(database.verifyStore(required(call, "store")))));
    }

    @PluginMethod public void getRecord(PluginCall call) {
        runIo(call, () -> {
            JSONObject value = database.getRecord(required(call, "store"), required(call, "key"));
            JSObject result = new JSObject();
            result.put("found", value != null);
            if (value != null) result.put("value", value);
            call.resolve(result);
        });
    }

    @PluginMethod public void getRecords(PluginCall call) {
        runIo(call, () -> {
            String store = required(call, "store");
            String afterKey = call.getString("afterKey", "");
            int limit = call.getInt("limit", 250);
            JSONArray rows = database.getRecords(store, afterKey, limit, call.getArray("fields"));
            JSObject result = new JSObject();
            result.put("rows", rows);
            result.put("nextKey", rows.length() == limit ? rows.getJSONObject(rows.length() - 1).getString("key") : JSONObject.NULL);
            call.resolve(result);
        });
    }

    @PluginMethod public void getRecentRecordsByIndex(PluginCall call) {
        runIo(call, () -> {
            JSObject result = new JSObject();
            result.put("rows", database.getRecentRecordsByIndex(
                required(call, "store"), required(call, "indexName"), call.getInt("limit", 100),
                call.getString("filterIndex"), call.getString("filterKey")));
            call.resolve(result);
        });
    }

    @PluginMethod public void getRecordKeys(PluginCall call) {
        runIo(call, () -> {
            String store = required(call, "store");
            String afterKey = call.getString("afterKey", "");
            int limit = call.getInt("limit", 500);
            JSONArray keys = database.getRecordKeys(store, afterKey, limit);
            JSObject result = new JSObject();
            result.put("keys", keys);
            result.put("nextKey", keys.length() == limit ? keys.getString(keys.length() - 1) : JSONObject.NULL);
            call.resolve(result);
        });
    }

    @PluginMethod public void countRecords(PluginCall call) {
        runIo(call, () -> {
            JSObject result = new JSObject();
            result.put("count", database.countRecords(required(call, "store")));
            call.resolve(result);
        });
    }

    @PluginMethod public void getRecordsByKeys(PluginCall call) {
        runIo(call, () -> {
            JSArray keys = call.getArray("keys");
            if (keys == null) throw new IllegalArgumentException("原生数据库键批次缺失");
            JSObject result = new JSObject();
            result.put("rows", database.getRecordsByKeys(required(call, "store"), new JSONArray(keys.toString())));
            call.resolve(result);
        });
    }

    @PluginMethod public void haveSameRecordKeys(PluginCall call) {
        runIo(call, () -> {
            JSObject result = new JSObject();
            result.put("equal", database.haveSameRecordKeys(required(call, "leftStore"), required(call, "rightStore")));
            call.resolve(result);
        });
    }

    @PluginMethod public void countIndexEntries(PluginCall call) {
        runIo(call, () -> {
            JSObject result = new JSObject();
            result.put("count", database.countIndexEntries(required(call, "store"), required(call, "indexName"), call.getString("indexKey")));
            call.resolve(result);
        });
    }

    @PluginMethod public void getIndexEntries(PluginCall call) {
        runIo(call, () -> {
            String indexKey = call.getString("indexKey");
            JSONArray rows = database.getIndexEntries(
                required(call, "store"), required(call, "indexName"), indexKey);
            JSObject result = new JSObject(); result.put("rows", rows); call.resolve(result);
        });
    }

    @PluginMethod public void queryKeyPage(PluginCall call) {
        runIo(call, () -> {
            JSONObject result = database.queryKeyPage(required(call, "store"), call.getObject("query"));
            call.resolve(new JSObject(result.toString()));
        });
    }

    @PluginMethod public void putRecords(PluginCall call) {
        runIo(call, () -> {
            String store = required(call, "store");
            JSArray rows = call.getArray("rows");
            if (rows == null) throw new IllegalArgumentException("原生数据库写入批次缺失");
            database.putRecords(store, new JSONArray(rows.toString()));
            JSObject result = new JSObject(); result.put("written", rows.length()); call.resolve(result);
        });
    }

    @PluginMethod public void putRecordsWithState(PluginCall call) {
        runIo(call, () -> {
            String store = required(call, "store");
            JSArray rows = call.getArray("rows");
            if (rows == null) throw new IllegalArgumentException("原生数据库写入批次缺失");
            database.putRecordsWithState(store, new JSONArray(rows.toString()),
                required(call, "stateKey"), call.getString("stateValue", ""));
            JSObject result = new JSObject(); result.put("written", rows.length()); call.resolve(result);
        });
    }

    @PluginMethod public void applyBatch(PluginCall call) {
        runIo(call, () -> {
            JSArray operations = call.getArray("operations");
            if (operations == null) throw new IllegalArgumentException("原生数据库操作批次缺失");
            database.applyBatch(new JSONArray(operations.toString()), call.getBoolean("requireActiveLibrary", false), call.getObject("expectedRevisions"));
            JSObject result = new JSObject(); result.put("applied", operations.length()); call.resolve(result);
        });
    }

    @PluginMethod public void deleteRecords(PluginCall call) {
        runIo(call, () -> {
            String store = required(call, "store");
            JSArray keys = call.getArray("keys");
            if (keys == null) throw new IllegalArgumentException("原生数据库删除批次缺失");
            database.deleteRecords(store, new JSONArray(keys.toString()));
            JSObject result = new JSObject(); result.put("deleted", keys.length()); call.resolve(result);
        });
    }

    @PluginMethod public void clearStore(PluginCall call) {
        runIo(call, () -> {
            String store = required(call, "store");
            database.clearStore(store);
            call.resolve();
        });
    }

    @PluginMethod public void clearIndexes(PluginCall call) {
        runIo(call, () -> {
            database.clearIndexes(required(call, "store"));
            call.resolve();
        });
    }

    @PluginMethod public void getState(PluginCall call) {
        runIo(call, () -> {
            String value = database.getState(required(call, "key"));
            JSObject result = new JSObject(); result.put("found", value != null);
            if (value != null) result.put("value", value);
            call.resolve(result);
        });
    }

    @PluginMethod public void putState(PluginCall call) {
        runIo(call, () -> {
            database.putState(required(call, "key"), call.getString("value", ""));
            call.resolve();
        });
    }

    @PluginMethod public void beginBlob(PluginCall call) {
        runIo(call, () -> {
            long size = call.getData().optLong("size", -1L);
            NativeAppDatabase.BlobTransfer transfer = database.beginBlob(
                required(call, "store"), required(call, "key"), required(call, "fieldPath"), size,
                call.getString("mimeType", ""), call.getString("sourceSha256", "")
            );
            JSObject result = new JSObject(); result.put("token", transfer.token); result.put("offset", transfer.offset);
            result.put("alreadyStored", transfer.alreadyStored); call.resolve(result);
        });
    }

    @PluginMethod public void appendBlob(PluginCall call) {
        runIo(call, () -> {
            String data = required(call, "data");
            if (data.length() > ((NativeAppDatabase.MAX_BLOB_CHUNK_BYTES + 2) / 3) * 4 + 8)
                throw new IllegalArgumentException("原生二进制数据块过大");
            byte[] bytes = Base64.decode(data, Base64.NO_WRAP);
            long offset = call.getData().optLong("offset", -1L);
            JSObject result = new JSObject(); result.put("offset", database.appendBlob(required(call, "token"), offset, bytes));
            call.resolve(result);
        });
    }

    @PluginMethod public void completeBlob(PluginCall call) {
        runIo(call, () -> call.resolve(new JSObject(database.completeBlob(required(call, "token")).toString())));
    }

    @PluginMethod public void getAssetImageSources(PluginCall call) {
        runIo(call, () -> {
            JSObject result = new JSObject();
            result.put("rows", database.getAssetImageSources(call.getArray("keys"), call.getArray("cardKeys")));
            call.resolve(result);
        });
    }

    @PluginMethod public void getBlobPath(PluginCall call) {
        runIo(call, () -> {
            JSONObject result = database.getBlobPath(required(call, "store"), required(call, "key"), required(call, "fieldPath"));
            JSObject response = new JSObject();
            response.put("found", result != null);
            if (result != null) response.put("blob", new JSObject(result.toString()));
            call.resolve(response);
        });
    }

    @PluginMethod public void readBlobChunk(PluginCall call) {
        runIo(call, () -> {
            long offset = call.getData().optLong("offset", 0L);
            int length = call.getInt("length", NativeAppDatabase.MAX_BLOB_CHUNK_BYTES);
            JSONObject result = database.readBlobChunk(required(call, "store"), required(call, "key"), required(call, "fieldPath"), offset, length);
            JSObject response = new JSObject();
            response.put("found", result != null);
            if (result != null) response.put("blob", new JSObject(result.toString()));
            call.resolve(response);
        });
    }

    @PluginMethod public void deleteBlob(PluginCall call) {
        runIo(call, () -> {
            database.deleteBlob(required(call, "store"), required(call, "key"), required(call, "fieldPath"));
            call.resolve();
        });
    }

    private String required(PluginCall call, String key) {
        String value = call.getString(key, "");
        if (value.isBlank()) throw new IllegalArgumentException("原生数据库参数无效");
        return value;
    }

    private void runIo(PluginCall call, NativeLibraryAction action) {
        NativeExecutors.ioSerial().execute(() -> {
            try { action.run(); }
            catch (Exception error) { call.reject(error.getMessage() == null ? "原生数据库操作失败" : error.getMessage(), error); }
        });
    }
}
