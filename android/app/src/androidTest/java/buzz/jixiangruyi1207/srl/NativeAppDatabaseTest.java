package buzz.jixiangruyi1207.srl;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertEquals;

import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import android.util.Base64;
import java.util.UUID;
import java.io.File;
import java.io.FileOutputStream;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public final class NativeAppDatabaseTest {
    @Test public void readsRequestedImagePathsWithEncryptedAndStagedReferences() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String name = "srl-app-image-sources-" + UUID.randomUUID();
        NativeAppDatabase database = new NativeAppDatabase(context, name);
        try {
            byte[] bytes = Base64.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZkAAAAASUVORK5CYII=", Base64.NO_WRAP);
            JSONArray assets = new JSONArray(), files = new JSONArray();
            for (String id : new String[] {"visible", "encrypted", "unrequested", "card"}) {
                byte[] imageBytes="card".equals(id)?java.util.Arrays.copyOf(bytes,bytes.length+1):bytes;
                String key = JSONObject.quote(id);
                String owner = "staged-" + id;
                NativeAppDatabase.BlobTransfer transfer = database.beginBlob("assetFiles", owner, "/blob", imageBytes.length, "image/png");
                database.appendBlob(transfer.token, 0, imageBytes);
                JSONObject blob = database.completeBlob(transfer.token).put("__srlAppDatabaseValueV1", "blob")
                    .put("fieldPath", "/blob").put("blobOwnerKey", owner);
                assets.put(new JSONObject().put("key", key).put("value", new JSONObject().put("assetId", id)
                    .put("mimeType", "image/png").put("size", imageBytes.length).put("encrypted", "encrypted".equals(id))
                    .put("thumbnailRefs",new JSONObject().put("card","card"))));
                files.put(new JSONObject().put("key", key).put("value", new JSONObject().put("assetId", id).put("blob", blob)));
            }
            database.putRecords("assets", assets); database.putRecords("assetFiles", files);
            JSONArray result = database.getAssetImageSources(new JSONArray().put("\"visible\"").put("\"encrypted\""));
            assertEquals(2, result.length());
            JSONObject direct = result.getJSONObject(0).getJSONObject("blob");
            assertEquals(bytes.length, direct.getLong("size"));
            assertTrue(new File(android.net.Uri.parse(direct.getString("path")).getPath()).isFile());
            assertTrue(result.getJSONObject(1).getBoolean("fallback"));
            JSONArray selected=database.getAssetImageSources(new JSONArray().put("\"visible\"").put("\"encrypted\""),new JSONArray().put("\"visible\"").put("\"encrypted\""));
            assertEquals(bytes.length+1,selected.getJSONObject(0).getJSONObject("blob").getLong("size"));
            assertTrue(selected.getJSONObject(1).getBoolean("fallback"));
            assertTrue(NativeFileAccess.resolveImage(context,selected.getJSONObject(0).getJSONObject("blob").getString("path")).isFile());
            assertThrows(Exception.class,()->NativeFileAccess.resolveImage(context,new File(context.getFilesDir(),"not-an-image").toURI().toString()));
            JSONObject brokenCard=database.getRecord("assets","\"card\"");
            brokenCard.put("size",999);
            database.putRecords("assets",new JSONArray().put(new JSONObject().put("key","\"card\"").put("value",brokenCard)));
            assertEquals(bytes.length,database.getAssetImageSources(new JSONArray().put("\"visible\""),new JSONArray().put("\"visible\"")).getJSONObject(0).getJSONObject("blob").getLong("size"));
            assertFalse(result.getJSONObject(1).has("blob"));
        } finally { database.close(); context.deleteDatabase(name); }
    }

    @Test public void retiredTranslationCleanupKeepsSiblingDataAndRejectsLinks() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File parent = new File(context.getCacheDir(), "retired-model-test-" + UUID.randomUUID());
        assertTrue(parent.mkdirs());
        File models = new File(parent, "com.google.mlkit.translate.models");
        File sibling = new File(parent, "keep-data");
        try {
            assertTrue(models.mkdir());
            try (FileOutputStream output = new FileOutputStream(sibling)) { output.write(new byte[7]); }
            File model = new File(models, "model.bin");
            try (FileOutputStream output = new FileOutputStream(model)) { output.write(new byte[13]); }
            File link = new File(models, "link");
            android.system.Os.symlink(sibling.getAbsolutePath(), link.getAbsolutePath());
            assertThrows(java.io.IOException.class, () -> NativeLibraryPlugin.clearRetiredTranslationModels(parent));
            assertTrue(model.exists());
            assertEquals(7, sibling.length());
            assertTrue(link.delete());
            assertEquals(13, NativeLibraryPlugin.clearRetiredTranslationModels(parent));
            assertFalse(models.exists());
            assertEquals(7, sibling.length());
            assertEquals(0, NativeLibraryPlugin.clearRetiredTranslationModels(parent));
        } finally {
            new File(models, "link").delete();
            new File(models, "model.bin").delete();
            models.delete();
            sibling.delete();
            parent.delete();
        }
    }
    @Test public void compactionReclaimsPagesWithoutChangingAuthoritativeRows() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String name = "srl-compaction-test-" + UUID.randomUUID();
        NativeAppDatabase database = new NativeAppDatabase(context, name);
        JSONObject original = new JSONObject().put("id", "keep").put("content", "完整原件");
        try {
            database.putRecords("resources", new JSONArray().put(new JSONObject().put("key", "\"keep\"").put("value", original)));
            String repeated = new String(new char[256 * 1024]).replace('\0', 'x');
            database.putRecords("resourceSummaries", new JSONArray().put(new JSONObject().put("key", "\"keep\"").put("value", new JSONObject().put("id", "keep").put("content", repeated))));
            database.putRecords("resourceSummaries", new JSONArray().put(new JSONObject().put("key", "\"keep\"").put("value", new JSONObject().put("id", "keep"))));
            JSONObject report = database.compact();
            assertTrue(report.getLong("afterBytes") < report.getLong("beforeBytes"));
            assertEquals(1, database.countRecords("resources"));
            assertEquals(original.toString(), database.getRecord("resources", "\"keep\"").toString());
            assertEquals(1, database.countRecords("resourceSummaries"));
        } finally { database.close(); context.deleteDatabase(name); }
    }
    @Test public void storageUsageIsReadOnlyAndCountsUtf8AndSharedBlobReferences() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String name = "srl-size-diagnostic-" + UUID.randomUUID();
        File file = context.getDatabasePath(name);
        assertNull(NativeAppDatabase.storageUsage(file));
        assertFalse(file.exists());
        NativeAppDatabase helper = new NativeAppDatabase(context, name);
        String payload = "{\"private\":\"私密内容🔒\"}";
        try {
            android.database.sqlite.SQLiteDatabase database = helper.getWritableDatabase();
            database.execSQL("INSERT INTO app_records(store_name,record_key,payload_json,updated_at) VALUES(?,?,?,?)",
                new Object[] {"resources", "private-id", payload, 1});
            database.execSQL("INSERT INTO app_blobs VALUES(?,?,?,?,?,?)",
                new Object[] {"resources", "private-id", "file", "image/png", 100, "shared-hash"});
            database.execSQL("INSERT INTO app_blobs VALUES(?,?,?,?,?,?)",
                new Object[] {"assetFiles", "private-asset-id", "file", "image/png", 100, "shared-hash"});
            int version = database.getVersion();
            JSONObject usage = NativeAppDatabase.storageUsage(file);
            assertEquals(version, database.getVersion());
            assertEquals(1, helper.countRecords("resources"));
            assertEquals(100, usage.getLong("uniqueReferencedBlobBytes"));
            assertEquals(0, usage.getLong("pendingBlobCount"));
            JSONArray stores = usage.getJSONArray("stores");
            assertEquals(2, stores.length());
            JSONObject resources = stores.getJSONObject(0);
            assertEquals("resources", resources.getString("store"));
            assertEquals(1, resources.getLong("records"));
            assertEquals(payload.getBytes(java.nio.charset.StandardCharsets.UTF_8).length, resources.getLong("jsonBytes"));
            assertEquals(100, resources.getLong("blobReferenceBytes"));
            assertTrue(usage.getLong("pageBytes") > 0);
            assertFalse(usage.toString().contains("private-id"));
            assertFalse(usage.toString().contains("私密内容"));
            try (android.database.Cursor cursor = database.rawQuery("SELECT payload_json FROM app_records", null)) {
                assertTrue(cursor.moveToFirst()); assertEquals(payload, cursor.getString(0));
            }
        } finally { helper.close(); context.deleteDatabase(name); }
    }

    private static void recreatePreV5KeyTables(android.database.sqlite.SQLiteDatabase database) {
        database.execSQL("ALTER TABLE app_records RENAME TO test_records_v5");
        database.execSQL("CREATE TABLE app_records (store_name TEXT NOT NULL, record_key TEXT NOT NULL, payload_json TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(store_name, record_key))");
        database.execSQL("INSERT INTO app_records SELECT store_name, record_key, payload_json, updated_at FROM test_records_v5");
        database.execSQL("DROP TABLE test_records_v5");
        database.execSQL("CREATE INDEX app_records_store_updated ON app_records(store_name, updated_at, record_key)");
        database.execSQL("ALTER TABLE app_record_indexes RENAME TO test_indexes_v5");
        database.execSQL("CREATE TABLE app_record_indexes (store_name TEXT NOT NULL, index_name TEXT NOT NULL, index_key TEXT NOT NULL, record_key TEXT NOT NULL, PRIMARY KEY(store_name, index_name, index_key, record_key))");
        database.execSQL("INSERT INTO app_record_indexes SELECT store_name, index_name, index_key, record_key FROM test_indexes_v5");
        database.execSQL("DROP TABLE test_indexes_v5");
        database.execSQL("CREATE INDEX app_record_indexes_lookup ON app_record_indexes(store_name, index_name, index_key, record_key)");
    }

    @Test public void upgradesV4KeyOrderingAndKeepsPayloadsWithBoundedPages() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String name = "srl-key-order-upgrade-" + UUID.randomUUID();
        NativeAppDatabase before = new NativeAppDatabase(context, name);
        JSONArray rows = new JSONArray();
        for (int value : new int[] {10, 2, -1}) rows.put(new JSONObject().put("key", Integer.toString(value))
            .put("value", new JSONObject().put("id", value).put("note", "保留内容"))
            .put("indexes", new JSONArray().put(new JSONObject().put("name", "updatedAt").put("keys", new JSONArray().put(Integer.toString(value))))));
        before.putRecords("settings", rows);
        String revision = before.getState("revision:appdb:v1:settings");
        recreatePreV5KeyTables(before.getWritableDatabase());
        before.getWritableDatabase().setVersion(4);
        before.close();
        NativeAppDatabase after = new NativeAppDatabase(context, name);
        try {
            assertEquals(5, after.getWritableDatabase().getVersion());
            assertEquals(revision, after.getState("revision:appdb:v1:settings"));
            assertEquals("保留内容", after.getRecord("settings", "2").getString("note"));
            JSONArray page = after.queryKeyPage("settings", new JSONObject().put("limit", 2)).getJSONArray("rows");
            assertEquals(2, page.length()); assertEquals("-1", page.getJSONObject(0).getString("primaryKey"));
            assertEquals("2", page.getJSONObject(1).getString("primaryKey"));
            JSONObject request = new JSONObject().put("indexName", "updatedAt").put("lower", "2")
                .put("lowerOpen", true).put("upper", "10").put("reverse", true).put("limit", 1).put("revision", revision);
            assertEquals("10", after.queryKeyPage("settings", request).getJSONArray("rows").getJSONObject(0).getString("primaryKey"));
            assertEquals(2, after.queryKeyPage("settings", new JSONObject().put("lower", "2").put("countOnly", true)).getLong("count"));
            after.putRecords("settings", new JSONArray().put(new JSONObject().put("key", "11").put("value", new JSONObject().put("id", 11))));
            assertThrows(IllegalStateException.class, () -> after.queryKeyPage("settings", request));
        } finally { after.close(); context.deleteDatabase(name); }
    }

    @Test public void comparesActualKeySetsInsteadOfOnlyTheirCounts() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String name = "srl-app-key-set-test-" + UUID.randomUUID();
        NativeAppDatabase database = new NativeAppDatabase(context, name);
        JSONObject first = new JSONObject().put("key", "\"a\"").put("value", new JSONObject().put("id", "a"));
        JSONObject stale = new JSONObject().put("key", "\"stale\"").put("value", new JSONObject().put("id", "stale"));
        try {
            assertTrue(database.haveSameRecordKeys("resources", "resourceListSummaries"));
            database.putRecords("resources", new JSONArray().put(first));
            assertFalse(database.haveSameRecordKeys("resources", "resourceListSummaries"));
            database.putRecords("resourceListSummaries", new JSONArray().put(stale));
            assertFalse(database.haveSameRecordKeys("resources", "resourceListSummaries"));
            database.clearStore("resourceListSummaries");
            database.putRecords("resourceListSummaries", new JSONArray().put(first));
            assertTrue(database.haveSameRecordKeys("resources", "resourceListSummaries"));
            database.close(); database = new NativeAppDatabase(context, name);
            assertTrue(database.haveSameRecordKeys("resources", "resourceListSummaries"));
        } finally { database.close(); context.deleteDatabase(name); }
    }
    @Test public void checksForegroundRevisionsInsideTheAtomicCommit() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String name = "srl-app-foreground-cas-test-" + UUID.randomUUID();
        NativeAppDatabase database = new NativeAppDatabase(context, name);
        String key = JSONObject.quote("editing");
        try {
            database.putRecords("settings", new JSONArray().put(new JSONObject().put("key", key).put("value", new JSONObject().put("id", "editing").put("value", "before"))));
            JSONObject expected = new JSONObject().put("settings", Long.parseLong(database.getState("revision:appdb:v1:settings")));
            database.putRecords("settings", new JSONArray().put(new JSONObject().put("key", key).put("value", new JSONObject().put("id", "editing").put("value", "background update"))));
            JSONArray operations = new JSONArray().put(new JSONObject().put("type", "put").put("store", "resources").put("rows", new JSONArray().put(new JSONObject().put("key", key).put("value", new JSONObject().put("id", "editing")))));
            assertThrows(IllegalStateException.class, () -> database.applyBatch(operations, false, expected));
            assertEquals(0, database.countRecords("resources"));
            assertEquals("background update", database.getRecord("settings", key).getString("value"));
        } finally { database.close(); context.deleteDatabase(name); }
    }

    @Test public void rollsBackRevisionCountersAndReadGuardsWithFailedBatches() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String name = "srl-app-cas-rollback-test-" + UUID.randomUUID();
        NativeAppDatabase database = new NativeAppDatabase(context, name);
        String key = JSONObject.quote("editing");
        try {
            database.putRecords("settings", new JSONArray().put(new JSONObject().put("key", key).put("value", new JSONObject().put("id", "editing").put("value", "before"))));
            database.withReadGuard(() -> {
                JSONObject value = database.getRecord("settings", key); value.put("value", "after");
                JSONObject valid = new JSONObject().put("type", "put").put("store", "settings").put("rows", new JSONArray().put(new JSONObject().put("key", key).put("value", value)));
                assertThrows(IllegalArgumentException.class, () -> database.applyBatch(new JSONArray().put(valid).put(new JSONObject().put("type", "clear").put("store", "not-a-store"))));
                assertEquals("before", database.getRecord("settings", key).getString("value"));
                database.applyBatch(new JSONArray().put(valid));
                return value;
            });
            assertEquals("after", database.getRecord("settings", key).getString("value"));
        } finally { database.close(); context.deleteDatabase(name); }
    }
    @Test public void rejectsStaleBackgroundWritesAfterAnotherConnectionChangesReadData() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String name = "srl-app-concurrent-test-" + UUID.randomUUID();
        NativeAppDatabase background = new NativeAppDatabase(context, name);
        NativeAppDatabase foreground = new NativeAppDatabase(context, name);
        String key = JSONObject.quote("edited");
        try {
            background.putRecords("settings", new JSONArray().put(new JSONObject().put("key", key).put("value", new JSONObject().put("id", "edited").put("value", "before"))));
            assertThrows(IllegalStateException.class, () -> background.withReadGuard(() -> {
                JSONObject stale = background.getRecord("settings", key);
                foreground.putRecords("settings", new JSONArray().put(new JSONObject().put("key", key).put("value", new JSONObject().put("id", "edited").put("value", "foreground edit"))));
                background.applyBatch(new JSONArray().put(new JSONObject().put("type", "put").put("store", "settings").put("rows", new JSONArray().put(new JSONObject().put("key", key).put("value", stale)))));
                return stale;
            }));
            assertEquals("foreground edit", foreground.getRecord("settings", key).getString("value"));
        } finally { background.close(); foreground.close(); context.deleteDatabase(name); }
    }
    @Test public void readsWritesIndexesAndReopensAllMigrationStores() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String name = "srl-app-all-stores-test-" + UUID.randomUUID();
        String[] stores = { "resources", "resourceSummaries", "resourceListSummaries", "resourceVersions", "resourceVersionSummaries", "categories", "settings", "backupRecords", "externalApps", "externalAppRuntimes", "externalAppData", "externalAppDrafts", "frontendWorkshopProjects", "frontendWorkshopProjectLastGood", "frontendWorkshopSourceDocuments", "frontendWorkshopSourceDocumentLastGood", "frontendWorkshopSourceComponents", "generatedImages", "generatedImageFiles", "restoreStaging", "restoreStagingChunks", "assets", "assetFiles", "communitySources", "communitySourceMessages", "resourceSourceBindings", "cloudBackupJobs", "cloudBackupOrphans" };
        NativeAppDatabase database = new NativeAppDatabase(context, name);
        try {
            for (String store : stores) {
                String key = JSONObject.quote(store + "-中文");
                JSONObject value = new JSONObject().put("id", store + "-中文").put("updatedAt", 2).put("content", "内容未改变");
                JSONArray indexes = new JSONArray().put(new JSONObject().put("name", "updatedAt").put("keys", new JSONArray().put("2")));
                database.putRecords(store, new JSONArray().put(new JSONObject().put("key", key).put("value", value).put("indexes", indexes)));
                assertEquals(1, database.countRecords(store));
                assertEquals(key, database.getRecordKeys(store, null, 10).getString(0));
                assertEquals("内容未改变", database.getRecordsByKeys(store, new JSONArray().put(key)).getJSONObject(0).getJSONObject("value").getString("content"));
                assertEquals(1, database.getIndexEntries(store, "updatedAt", "2").length());
                assertEquals(1, database.verifyStore(store).getInt("records"));
            }
            database.close(); database = new NativeAppDatabase(context, name);
            for (String store : stores) assertEquals("内容未改变", database.getRecord(store, JSONObject.quote(store + "-中文")).getString("content"));
        } finally { database.close(); context.deleteDatabase(name); }
    }
    private static String sourceHash(byte[] bytes) throws Exception {
        byte[] digest = java.security.MessageDigest.getInstance("SHA-256").digest(bytes);
        StringBuilder result = new StringBuilder();
        for (byte value : digest) result.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
        return result.toString();
    }

    @Test public void resumesOnlyTheSameBlobSourceAndRejectsChangedBytes() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String name = "srl-app-source-test-" + UUID.randomUUID();
        NativeAppDatabase database = new NativeAppDatabase(context, name);
        byte[] first = "abcdef".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        byte[] second = "UVWXYZ".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        try {
            NativeAppDatabase.BlobTransfer initial = database.beginBlob("assetFiles", "source", "$/blob", first.length, "text/plain", sourceHash(first));
            database.appendBlob(initial.token, 0, java.util.Arrays.copyOf(first, 3));
            NativeAppDatabase.BlobTransfer changed = database.beginBlob("assetFiles", "source", "$/blob", second.length, "text/plain", sourceHash(second));
            assertEquals(0, changed.offset);
            assertFalse(initial.token.equals(changed.token));
            database.appendBlob(changed.token, 0, java.util.Arrays.copyOf(second, 2));
            NativeAppDatabase.BlobTransfer same = database.beginBlob("assetFiles", "source", "$/blob", second.length, "text/plain", sourceHash(second));
            assertEquals(changed.token, same.token);
            assertEquals(2, same.offset);
            database.appendBlob(same.token, 2, java.util.Arrays.copyOfRange(second, 2, second.length));
            assertEquals(sourceHash(second), database.completeBlob(same.token).getString("sha256"));
            NativeAppDatabase.BlobTransfer wrong = database.beginBlob("assetFiles", "source", "$/blob", first.length, "text/plain", sourceHash(first));
            database.appendBlob(wrong.token, 0, second);
            assertThrows(IllegalStateException.class, () -> database.completeBlob(wrong.token));
            assertEquals(sourceHash(second), database.readBlobChunk("assetFiles", "source", "$/blob", 0, 16).getString("sha256"));
        } finally { database.clearStore("assetFiles"); database.close(); context.deleteDatabase(name); }
    }

    @Test public void upgradesV3WithoutChangingRecordsOrDroppingOldPendingTransfers() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String name = "srl-app-upgrade-test-" + UUID.randomUUID();
        NativeAppDatabase initial = new NativeAppDatabase(context, name);
        initial.putRecords("settings", new JSONArray().put(new JSONObject().put("key", JSONObject.quote("kept")).put("value", new JSONObject().put("id", "kept").put("value", "保留内容"))));
        NativeAppDatabase.BlobTransfer pending = initial.beginBlob("assetFiles", "legacy", "blob", 3, "text/plain");
        initial.appendBlob(pending.token, 0, new byte[] {97});
        android.database.sqlite.SQLiteDatabase sql = initial.getWritableDatabase();
        sql.execSQL("ALTER TABLE app_blob_pending RENAME TO test_pending_v4");
        sql.execSQL("CREATE TABLE app_blob_pending (token TEXT PRIMARY KEY NOT NULL, store_name TEXT NOT NULL, record_key TEXT NOT NULL, field_path TEXT NOT NULL, mime_type TEXT NOT NULL, expected_size INTEGER NOT NULL, relative_path TEXT NOT NULL, UNIQUE(store_name, record_key, field_path))");
        sql.execSQL("INSERT INTO app_blob_pending SELECT token, store_name, record_key, field_path, mime_type, expected_size, relative_path FROM test_pending_v4");
        sql.execSQL("DROP TABLE test_pending_v4");
        recreatePreV5KeyTables(sql);
        sql.setVersion(3);
        initial.close();
        NativeAppDatabase upgraded = new NativeAppDatabase(context, name);
        try {
            assertEquals(5, upgraded.getWritableDatabase().getVersion());
            assertEquals("保留内容", upgraded.getRecord("settings", JSONObject.quote("kept")).getString("value"));
            NativeAppDatabase.BlobTransfer preserved = upgraded.beginBlob("assetFiles", "legacy", "blob", 3, "text/plain");
            assertEquals(pending.token, preserved.token);
            assertEquals(1, preserved.offset);
            NativeAppDatabase.BlobTransfer transfer = upgraded.beginBlob("assetFiles", "after", "blob", 0, "", sourceHash(new byte[0]));
            assertEquals(sourceHash(new byte[0]), upgraded.completeBlob(transfer.token).getString("sha256"));
        } finally { upgraded.clearStore("assetFiles"); upgraded.close(); context.deleteDatabase(name); }
    }

    @Test public void enumeratesKeysWithoutPayloadsAndAuditsBeforeOldCopyCleanup() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String name = "srl-app-data-cleanup-test-" + UUID.randomUUID();
        NativeAppDatabase database = new NativeAppDatabase(context, name);
        String key = JSONObject.quote("cleanup-a");
        String path = "$/originalBlob";
        byte[] content = ("cleanup-audit-" + UUID.randomUUID()).getBytes(java.nio.charset.StandardCharsets.UTF_8);
        NativeAppDatabase.BlobTransfer transfer = database.beginBlob("resources", key, path, content.length, "image/png");
        database.appendBlob(transfer.token, 0L, content);
        JSONObject metadata = database.completeBlob(transfer.token);
        JSONObject reference = new JSONObject().put("__srlAppDatabaseValueV1", "blob")
            .put("fieldPath", path).put("sha256", metadata.getString("sha256"))
            .put("size", content.length).put("mimeType", "image/png").put("blobOwnerKey", key);
        database.putRecords("resources", new JSONArray()
            .put(new JSONObject().put("key", key).put("value", new JSONObject().put("id", "cleanup-a").put("originalBlob", reference)))
            .put(new JSONObject().put("key", JSONObject.quote("cleanup-b")).put("value", new JSONObject().put("id", "cleanup-b"))));
        JSONArray first = database.getRecordKeys("resources", null, 1);
        assertEquals(key, first.getString(0));
        assertEquals(JSONObject.quote("cleanup-b"), database.getRecordKeys("resources", key, 1).getString(0));
        JSONObject audit = database.verifyStore("resources");
        assertEquals(2, audit.getInt("records"));
        assertEquals(1, audit.getInt("files"));
        assertEquals(content.length, audit.getLong("bytes"));
        assertFalse(database.getRecord("resources", key).getJSONObject("originalBlob").has("blobOwnerKey"));
        // Recreate an already-published background import's payload without rewriting
        // its committed attachment. Compatibility must still verify the actual bytes.
        JSONObject legacy = database.getRecord("resources", key);
        legacy.getJSONObject("originalBlob").put("blobOwnerKey", key);
        android.content.ContentValues values = new android.content.ContentValues();
        values.put("payload_json", legacy.toString());
        database.getWritableDatabase().update("app_records", values,
            "store_name = ? AND record_key = ?", new String[] {"resources", key});
        assertEquals(content.length, database.verifyStore("resources").getLong("bytes"));
        legacy.getJSONObject("originalBlob").put("blobOwnerKey", JSONObject.quote("uncommitted-owner"));
        values.put("payload_json", legacy.toString());
        database.getWritableDatabase().update("app_records", values,
            "store_name = ? AND record_key = ?", new String[] {"resources", key});
        assertThrows(IllegalStateException.class, () -> database.verifyStore("resources"));
        legacy.getJSONObject("originalBlob").put("blobOwnerKey", key);
        values.put("payload_json", legacy.toString());
        database.getWritableDatabase().update("app_records", values,
            "store_name = ? AND record_key = ?", new String[] {"resources", key});
        String hash = metadata.getString("sha256");
        File blob = new File(context.getFilesDir(), "srl-app-data/blobs/" + hash.substring(0, 2) + "/" + hash + ".bin");
        // Same size, different bytes: size-only checks must never unlock old-copy deletion.
        try (FileOutputStream output = new FileOutputStream(blob)) { output.write(new byte[content.length]); }
        assertThrows(IllegalStateException.class, () -> database.verifyStore("resources"));
        assertNotNull(database.getRecord("resources", key));
        database.clearStore("resources");
        database.close(); context.deleteDatabase(name);
    }

    @Test public void auditProtectsNativeOriginalReferencesAndUsesIndexCounts() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String name = "srl-app-data-native-original-audit-" + UUID.randomUUID();
        NativeAppDatabase database = new NativeAppDatabase(context, name);
        byte[] content = ("native-original-audit-" + UUID.randomUUID()).getBytes(java.nio.charset.StandardCharsets.UTF_8);
        byte[] digest = java.security.MessageDigest.getInstance("SHA-256").digest(content);
        StringBuilder hex = new StringBuilder();
        for (byte value : digest) hex.append(String.format(java.util.Locale.ROOT, "%02x", value & 0xff));
        String hash = hex.toString();
        File original = NativeLibraryPlugin.objectFile(context, hash);
        assertTrue(original.getParentFile().isDirectory() || original.getParentFile().mkdirs());
        try (FileOutputStream output = new FileOutputStream(original)) { output.write(content); }
        JSONObject value = new JSONObject().put("id", "native-original").put("nativeOriginal",
            new JSONObject().put("version", 1).put("contentHash", hash).put("size", content.length));
        database.putRecords("resources", new JSONArray().put(new JSONObject().put("key", JSONObject.quote("native-original"))
            .put("value", value).put("indexes", new JSONArray().put(new JSONObject().put("name", "type")
                .put("keys", new JSONArray().put(JSONObject.quote("characterCard")))))));
        assertEquals(1L, database.countIndexEntries("resources", "type", JSONObject.quote("characterCard")));
        assertEquals(0L, database.countIndexEntries("resources", "type", JSONObject.quote("chat")));
        assertEquals(content.length, database.verifyStore("resources").getLong("bytes"));
        assertTrue(original.delete());
        assertThrows(IllegalStateException.class, () -> database.verifyStore("resources"));
        assertNotNull(database.getRecord("resources", JSONObject.quote("native-original")));
        database.clearStore("resources"); database.close(); context.deleteDatabase(name);
    }

    @Test public void persistsPagedRowsAndDeletesOnlyRequestedKeys() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String name = "srl-app-data-test-" + UUID.randomUUID();
        NativeAppDatabase database = new NativeAppDatabase(context, name);
        database.putRecords("settings", new JSONArray()
            .put(new JSONObject().put("key", "a").put("value", new JSONObject().put("id", "a").put("value", true)))
            .put(new JSONObject().put("key", "b").put("value", new JSONObject().put("id", "b").put("value", 2))));

        assertEquals(2L, database.countRecords("settings"));
        database.putState("migration:settings", "{\"copied\":2}");
        JSONArray firstPage = database.getRecords("settings", null, 1);
        assertEquals("a", firstPage.getJSONObject(0).getString("key"));
        JSONArray secondPage = database.getRecords("settings", "a", 1);
        assertEquals("b", secondPage.getJSONObject(0).getString("key"));
        assertEquals(1, secondPage.length());

        database.close();
        database = new NativeAppDatabase(context, name);
        assertEquals(2L, database.countRecords("settings"));
        assertEquals("{\"copied\":2}", database.getState("migration:settings"));
        assertEquals(2, database.getRecordsByKeys("settings", new JSONArray().put("a").put("b")).length());
        assertNotNull(database.getRecord("settings", "a"));
        database.deleteRecords("settings", new JSONArray().put("a"));
        assertEquals(1L, database.countRecords("settings"));
        assertNull(database.getRecord("settings", "a"));
        assertTrue(database.getRecord("settings", "b") != null);
        database.close();
        context.deleteDatabase(name);
    }

    @Test public void readsOnlyRecentUnboundCommunitySourcesThroughIndexes() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String name = "srl-app-data-test-" + UUID.randomUUID();
        NativeAppDatabase database = new NativeAppDatabase(context, name);
        for (int index = 1; index <= 3; index++) {
            String id = "source-" + index;
            JSONObject value = new JSONObject().put("id", id).put("title", id).put("updatedAt", index * 100L);
            JSONArray indexes = new JSONArray()
                .put(new JSONObject().put("name", "updatedAt").put("keys", new JSONArray().put(String.valueOf(index * 100L))));
            if (index == 2)
                indexes.put(new JSONObject().put("name", "id").put("keys", new JSONArray().put(JSONObject.quote(id))));
            database.putRecords("communitySources", new JSONArray().put(new JSONObject()
                .put("key", JSONObject.quote(id)).put("value", value).put("indexes", indexes)));
        }
        database.putRecords("resourceSourceBindings", new JSONArray().put(new JSONObject()
            .put("key", JSONObject.quote("binding-2"))
            .put("value", new JSONObject().put("id", "binding-2").put("sourceId", "source-2"))
            .put("indexes", new JSONArray().put(new JSONObject().put("name", "sourceId")
                .put("keys", new JSONArray().put(JSONObject.quote("source-2")))))));

        JSONArray recent = database.getRecentRecordsByIndex("communitySources", "updatedAt", 2);
        assertEquals(2, recent.length());
        assertEquals("source-3", recent.getJSONObject(0).getJSONObject("value").getString("id"));
        assertEquals("source-1", recent.getJSONObject(1).getJSONObject("value").getString("id"));
        database.close();
        context.deleteDatabase(name);
    }

    @Test public void rejectsUnknownStoresAndRollsBackMalformedBatches() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String name = "srl-app-data-test-" + UUID.randomUUID();
        NativeAppDatabase database = new NativeAppDatabase(context, name);
        assertThrows(IllegalArgumentException.class, () -> database.countRecords("arbitrary"));

        JSONArray rows = new JSONArray()
            .put(new JSONObject().put("key", "first").put("value", new JSONObject().put("id", "first")))
            .put(new JSONObject().put("key", "invalid").put("value", "not-an-object"));
        assertThrows(IllegalArgumentException.class, () -> database.putRecords("resources", rows));
        assertEquals(0L, database.countRecords("resources"));
        database.close();
        context.deleteDatabase(name);
    }

    @Test public void appliesCrossStoreChangesAtomically() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String name = "srl-app-data-test-" + UUID.randomUUID();
        NativeAppDatabase database = new NativeAppDatabase(context, name);
        JSONArray operations = new JSONArray()
            .put(new JSONObject().put("type", "put").put("store", "resources")
                .put("rows", new JSONArray().put(new JSONObject().put("key", "r1")
                    .put("value", new JSONObject().put("id", "r1")))))
            .put(new JSONObject().put("type", "put").put("store", "resourceSummaries")
                .put("rows", new JSONArray().put(new JSONObject().put("key", "r1")
                    .put("value", new JSONObject().put("id", "r1")))))
            .put(new JSONObject().put("type", "delete").put("store", "resourceListSummaries")
                .put("keys", new JSONArray().put("stale")));
        database.applyBatch(operations);
        assertNotNull(database.getRecord("resources", "r1"));
        assertNotNull(database.getRecord("resourceSummaries", "r1"));

        JSONArray invalid = new JSONArray()
            .put(new JSONObject().put("type", "put").put("store", "resources")
                .put("rows", new JSONArray().put(new JSONObject().put("key", "r2")
                    .put("value", new JSONObject().put("id", "r2")))))
            .put(new JSONObject().put("type", "invalid").put("store", "categories"));
        assertThrows(IllegalArgumentException.class, () -> database.applyBatch(invalid));
        assertNull(database.getRecord("resources", "r2"));
        assertEquals(1L, database.countRecords("resources"));
        database.close();
        context.deleteDatabase(name);
    }

    @Test public void appliesRestoreSizedWriteWithoutSplittingItsTransaction() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String name = "srl-app-data-large-batch-test-" + UUID.randomUUID();
        NativeAppDatabase database = new NativeAppDatabase(context, name);
        JSONArray rows = new JSONArray();
        for (int index = 0; index < 1_001; index++) {
            String id = "setting-" + index;
            rows.put(new JSONObject().put("key", JSONObject.quote(id))
                .put("value", new JSONObject().put("id", id).put("value", index)));
        }
        database.applyBatch(new JSONArray().put(new JSONObject()
            .put("type", "put").put("store", "settings").put("rows", rows)));

        assertEquals(1_001L, database.countRecords("settings"));
        assertEquals(1_001, database.getRecords("settings", null, 1_001).length());
        database.close();
        context.deleteDatabase(name);
    }

    @Test public void replacesAndDeletesSecondaryIndexEntriesWithTheirRecords() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String name = "srl-app-data-index-test-" + UUID.randomUUID();
        NativeAppDatabase database = new NativeAppDatabase(context, name);
        JSONObject row = new JSONObject().put("key", "resource-1")
            .put("value", new JSONObject().put("id", "resource-1").put("type", "characterCard"))
            .put("indexes", new JSONArray().put(new JSONObject().put("name", "type")
                .put("keys", new JSONArray().put(JSONObject.quote("characterCard")))));
        database.putRecords("resources", new JSONArray().put(row));
        assertEquals(1, database.getIndexEntries("resources", "type", JSONObject.quote("characterCard")).length());
        assertEquals(0, database.getIndexEntries("resources", "type", JSONObject.quote("chat")).length());

        database.deleteRecords("resources", new JSONArray().put("resource-1"));
        assertEquals(0, database.getIndexEntries("resources", "type", JSONObject.quote("characterCard")).length());
        database.close();
        context.deleteDatabase(name);
    }

    @Test public void guardedBackgroundBatchCannotCommitDuringRollbackAndClearRemovesIndexes() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String name = "srl-app-data-guard-test-" + UUID.randomUUID();
        NativeAppDatabase database = new NativeAppDatabase(context, name);
        JSONObject active = new JSONObject().put("version", 1).put("mode", "active");
        database.putState("migration:appdb:v1:active", active.toString());
        database.putState("migration:appdb:indexes:v1:active", "verified-v1");
        JSONArray rows = new JSONArray().put(new JSONObject().put("key", "r1")
            .put("value", new JSONObject().put("id", "r1"))
            .put("indexes", new JSONArray().put(new JSONObject().put("name", "type")
                .put("keys", new JSONArray().put(JSONObject.quote("characterCard"))))));
        JSONArray write = new JSONArray().put(new JSONObject().put("type", "put")
            .put("store", "resources").put("rows", rows));

        database.applyBatch(write, true);
        assertEquals(1, database.getIndexEntries("resources", "type", JSONObject.quote("characterCard")).length());
        database.putState("migration:appdb:v1:active",
            new JSONObject().put("version", 1).put("mode", "rolling-back").toString());
        assertThrows(IllegalStateException.class, () -> database.applyBatch(write, true));
        assertEquals(1L, database.countRecords("resources"));

        database.applyBatch(new JSONArray().put(new JSONObject().put("type", "clear")
            .put("store", "resources")));
        assertEquals(0, database.getIndexEntries("resources", "type", JSONObject.quote("characterCard")).length());
        database.close();
        context.deleteDatabase(name);
    }

    @Test public void importsParsedCloudCardDirectlyAndIdempotentlyIntoNativeLibrary() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String name = "srl-app-data-import-test-" + UUID.randomUUID();
        NativeAppDatabase database = new NativeAppDatabase(context, name);
        database.putState("migration:appdb:v1:active",
            new JSONObject().put("version", 1).put("databaseVersion", 25).put("activatedAt", 1).toString());
        database.putState("migration:appdb:indexes:v1:active", "verified-v1");
        File payload = new File(context.getCacheDir(), "native-import-" + UUID.randomUUID() + ".json");
        File parsed = new File(context.getCacheDir(), "native-import-" + UUID.randomUUID() + ".parsed.json");
        try {
            try (FileOutputStream output = new FileOutputStream(payload)) {
                output.write("{\"spec\":\"chara_card_v2\",\"data\":{\"name\":\"Mira\",\"description\":\"A test card\",\"creator\":\"SRL\",\"tags\":[\"test\"]}}"
                    .getBytes(java.nio.charset.StandardCharsets.UTF_8));
            }
            JSONObject card = new JSONObject().put("spec", "chara_card_v2")
                .put("data", new JSONObject().put("name", "Mira").put("description", "A test card")
                    .put("creator", "SRL").put("tags", new JSONArray().put("test")));
            JSONObject metadata = new JSONObject().put("card", card).put("cardContentHash", "a".repeat(64))
                .put("cardCoreHash", "b".repeat(64)).put("characterVersion", "1");
            try (FileOutputStream output = new FileOutputStream(parsed)) {
                output.write(new JSONObject().put("type", "characterCard").put("name", "Mira")
                    .put("description", "A test card").put("tags", new JSONArray().put("test"))
                    .put("metadata", metadata).toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
            }

            JSONObject imported = NativeBackgroundResourceImporter.importIfSafe(
                context, database, payload, parsed, "Mira.json", "application/json");
            assertEquals("imported", imported.getString("state"));
            String key = JSONObject.quote(imported.getString("resourceId"));
            JSONObject resource = database.getRecord("resources", key);
            assertEquals("characterCard", resource.getString("type"));
            assertEquals("Mira", resource.getString("name"));
            assertEquals("blob", resource.getJSONObject("originalBlob").getString("__srlAppDatabaseValueV1"));
            assertEquals("Mira", database.getRecord("resourceSummaries", key).getString("name"));
            assertEquals("Mira", database.getRecord("resourceListSummaries", key).getString("name"));
            assertEquals(1, database.getIndexEntries("resourceSummaries", "type",
                JSONObject.quote("characterCard")).length());
            assertEquals(1, database.getIndexEntries("resourceSummaries", "contentHash",
                JSONObject.quote(resource.getString("contentHash"))).length());

            JSONObject duplicate = NativeBackgroundResourceImporter.importIfSafe(
                context, database, payload, parsed, "Mira.json", "application/json");
            assertEquals("duplicate_file", duplicate.getString("state"));
            assertEquals(1L, database.countRecords("resources"));
        } finally {
            payload.delete(); parsed.delete(); database.close(); context.deleteDatabase(name);
        }
    }

    @Test public void activeExactCardDuplicateSkipsUnrelatedHistoricalRows() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String name = "srl-app-data-import-shortcut-test-" + UUID.randomUUID();
        NativeAppDatabase database = new NativeAppDatabase(context, name);
        database.putState("migration:appdb:v1:active",
            new JSONObject().put("version", 1).put("databaseVersion", 25).put("activatedAt", 1).toString());
        database.putState("migration:appdb:indexes:v1:active", "verified-v1");
        File payload = new File(context.getCacheDir(), "native-import-shortcut-" + UUID.randomUUID() + ".json");
        File parsed = new File(context.getCacheDir(), "native-import-shortcut-" + UUID.randomUUID() + ".parsed.json");
        try {
            try (FileOutputStream output = new FileOutputStream(payload)) {
                output.write("{\"spec\":\"chara_card_v2\",\"data\":{\"name\":\"Mira\",\"description\":\"A test card\",\"creator\":\"SRL\"}}"
                    .getBytes(java.nio.charset.StandardCharsets.UTF_8));
            }
            NativeCharacterCardProcessor.parseOnly(payload, "Mira.json", parsed);
            JSONObject existing = NativeShareImportService.readMetadata(parsed)
                .put("id", "existing-card").put("fileName", "Mira.json")
                .put("contentHash", "0".repeat(64));
            JSONArray indexes = new JSONArray()
                .put(new JSONObject().put("name", "type")
                    .put("keys", new JSONArray().put(JSONObject.quote("characterCard"))))
                .put(new JSONObject().put("name", "contentHash")
                    .put("keys", new JSONArray().put(JSONObject.quote("0".repeat(64)))));
            database.putRecords("resourceSummaries", new JSONArray().put(new JSONObject()
                .put("key", JSONObject.quote("existing-card")).put("value", existing).put("indexes", indexes)));
            database.putRecords("resourceVersionSummaries", new JSONArray().put(new JSONObject()
                .put("key", JSONObject.quote("unrelated-history"))
                .put("value", new JSONObject().put("encrypted", true))));

            JSONObject result = NativeBackgroundResourceImporter.importIfSafe(
                context, database, payload, parsed, "Mira.json", "application/json");
            assertEquals("duplicate_card", result.getString("state"));
        } finally {
            payload.delete(); parsed.delete(); database.close(); context.deleteDatabase(name);
        }
    }

    @Test public void resumesLargeBlobTransferAndVerifiesContentBeforePublishing() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String name = "srl-app-data-test-" + UUID.randomUUID();
        NativeAppDatabase database = new NativeAppDatabase(context, name);
        byte[] first = "hello ".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        byte[] second = "world".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        NativeAppDatabase.BlobTransfer started = database.beginBlob("assetFiles", "asset-1", "blob", 11L, "text/plain");
        assertEquals(0L, started.offset);
        assertEquals(6L, database.appendBlob(started.token, 0L, first));
        database.close();

        database = new NativeAppDatabase(context, name);
        NativeAppDatabase.BlobTransfer resumed = database.beginBlob("assetFiles", "asset-1", "blob", 11L, "text/plain");
        assertEquals(started.token, resumed.token);
        assertEquals(6L, resumed.offset);
        assertEquals(11L, database.appendBlob(resumed.token, 6L, second));
        JSONObject metadata = database.completeBlob(resumed.token);
        assertEquals("b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9", metadata.getString("sha256"));
        JSONObject chunk = database.readBlobChunk("assetFiles", "asset-1", "blob", 0L, 11);
        assertEquals("hello world", new String(Base64.decode(chunk.getString("data"), Base64.NO_WRAP), java.nio.charset.StandardCharsets.UTF_8));
        assertTrue(chunk.getBoolean("eof"));
        JSONObject direct = database.getBlobPath("assetFiles", "asset-1", "blob");
        assertEquals(11L, direct.getLong("size"));
        assertEquals(metadata.getString("sha256"), direct.getString("sha256"));
        File directFile = new File(android.net.Uri.parse(direct.getString("path")).getPath());
        assertEquals("hello world", new String(java.nio.file.Files.readAllBytes(directFile.toPath()), java.nio.charset.StandardCharsets.UTF_8));
        assertFalse(direct.has("data"));
        database.putRecords("assetFiles", new JSONArray().put(new JSONObject().put("key", "asset-1")
            .put("value", new JSONObject().put("assetId", "asset-1").put("blob", new JSONObject()
                .put("__srlAppDatabaseValueV1", "blob").put("fieldPath", "blob")
                .put("sha256", metadata.getString("sha256"))))));
        database.putRecords("assetFiles", new JSONArray().put(new JSONObject()
            .put("key", "asset-1").put("value", new JSONObject().put("assetId", "asset-1"))));
        assertNull(database.readBlobChunk("assetFiles", "asset-1", "blob", 0L, 11));
        assertNull(database.getBlobPath("assetFiles", "asset-1", "blob"));
        database.deleteRecords("assetFiles", new JSONArray().put("asset-1"));
        assertEquals(0L, database.countRecords("assetFiles"));
        assertNull(database.readBlobChunk("assetFiles", "asset-1", "blob", 0L, 11));
        database.close();
        context.deleteDatabase(name);
    }

    @Test public void acceptsOneMegabyteBlobChunks() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String name = "srl-app-data-test-" + UUID.randomUUID();
        NativeAppDatabase database = new NativeAppDatabase(context, name);
        byte[] chunk = new byte[NativeAppDatabase.MAX_BLOB_CHUNK_BYTES];
        java.util.Arrays.fill(chunk, (byte) 0x5a);
        NativeAppDatabase.BlobTransfer transfer = database.beginBlob(
            "assetFiles", "asset-1", "blob", chunk.length + 1L, "application/octet-stream");
        assertEquals((long) chunk.length,
            database.appendBlob(transfer.token, 0L, chunk));
        assertEquals(chunk.length + 1L,
            database.appendBlob(transfer.token, chunk.length, new byte[] {0x2a}));
        JSONObject metadata = database.completeBlob(transfer.token);
        assertEquals(chunk.length + 1L, metadata.getLong("size"));
        database.deleteBlob("assetFiles", "asset-1", "blob");
        database.close();
        context.deleteDatabase(name);
    }

    @Test public void stagedBlobReferencesMoveOnlyWithCommittedRows() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String name = "srl-app-data-test-" + UUID.randomUUID();
        NativeAppDatabase database = new NativeAppDatabase(context, name);
        String stagingKey = "__srl_tx_" + UUID.randomUUID();
        String destinationKey = "resource-1";
        String fieldPath = "$/originalBlob";
        byte[] contents = "staged attachment".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        NativeAppDatabase.BlobTransfer transfer = database.beginBlob(
            "resources", stagingKey, fieldPath, contents.length, "application/octet-stream");
        database.appendBlob(transfer.token, 0L, contents);
        JSONObject staged = database.completeBlob(transfer.token);

        JSONObject descriptor = new JSONObject()
            .put("__srlAppDatabaseValueV1", "blob")
            .put("fieldPath", fieldPath)
            .put("blobOwnerKey", stagingKey)
            .put("size", contents.length)
            .put("mimeType", "application/octet-stream")
            .put("sha256", staged.getString("sha256"));
        JSONArray rejected = new JSONArray()
            .put(new JSONObject().put("type", "put").put("store", "resources")
                .put("rows", new JSONArray().put(new JSONObject().put("key", destinationKey)
                    .put("value", new JSONObject().put("id", destinationKey).put("original", descriptor)))))
            .put(new JSONObject().put("type", "invalid").put("store", "categories"));
        assertThrows(IllegalArgumentException.class, () -> database.applyBatch(rejected));
        assertNull(database.getRecord("resources", destinationKey));
        JSONObject stillStaged = database.readBlobChunk("resources", stagingKey, fieldPath, 0L, contents.length);
        assertNotNull(stillStaged);

        JSONArray committed = new JSONArray().put(new JSONObject()
            .put("type", "put").put("store", "resources")
            .put("rows", new JSONArray().put(new JSONObject().put("key", destinationKey)
                .put("value", new JSONObject().put("id", destinationKey).put("original", descriptor)))));
        database.applyBatch(committed);
        assertNull(database.readBlobChunk("resources", stagingKey, fieldPath, 0L, contents.length));
        JSONObject attached = database.readBlobChunk("resources", destinationKey, fieldPath, 0L, contents.length);
        assertEquals(new String(contents, java.nio.charset.StandardCharsets.UTF_8),
            new String(Base64.decode(attached.getString("data"), Base64.NO_WRAP), java.nio.charset.StandardCharsets.UTF_8));
        assertFalse(database.getRecord("resources", destinationKey).getJSONObject("original").has("blobOwnerKey"));

        database.deleteRecords("resources", new JSONArray().put(destinationKey));
        assertNull(database.readBlobChunk("resources", destinationKey, fieldPath, 0L, contents.length));
        database.close();
        context.deleteDatabase(name);
    }
}
