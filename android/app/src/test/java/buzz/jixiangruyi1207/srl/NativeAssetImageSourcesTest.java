package buzz.jixiangruyi1207.srl;

import static org.junit.Assert.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class NativeAssetImageSourcesTest {
    @Test public void selectsOnlyRequestedPreparedCardsAndNeverBypassesAnEncryptedParent() throws Exception {
        JSONObject plain=asset("a",false), encrypted=asset("b",true);
        plain.getJSONObject("value").put("thumbnailRefs",new JSONObject().put("card","small"));
        encrypted.getJSONObject("value").put("thumbnailRefs",new JSONObject().put("card","small"));
        JSONArray keys=new JSONArray().put("\"a\"").put("\"b\"");
        assertEquals("[\"\\\"small\\\"\",\"\\\"b\\\"\"]",NativeAssetImageSources.selectCardKeys(keys,new JSONArray().put(plain).put(encrypted),keys).toString());
        assertEquals(keys.toString(),NativeAssetImageSources.selectCardKeys(keys,new JSONArray().put(plain).put(encrypted),null).toString());
        plain.getJSONObject("value").put("mimeType","text/plain");
        assertEquals(keys.toString(),NativeAssetImageSources.selectCardKeys(keys,new JSONArray().put(plain).put(encrypted),keys).toString());
    }
    private JSONObject row(String id, JSONObject value) throws Exception {
        return new JSONObject().put("key", JSONObject.quote(id)).put("value", value);
    }
    private JSONObject asset(String id, boolean encrypted) throws Exception {
        return row(id, new JSONObject().put("assetId", id).put("encrypted", encrypted)
            .put("mimeType", "image/webp").put("size", 12));
    }
    private JSONObject descriptor() throws Exception {
        return new JSONObject().put("__srlAppDatabaseValueV1", "blob").put("blobOwnerKey", "staged-owner")
            .put("fieldPath", "/blob").put("mimeType", "image/webp").put("size", 12).put("sha256", "a".repeat(64));
    }
    private JSONObject file(String id) throws Exception {
        return row(id, new JSONObject().put("assetId", id).put("blob", descriptor()));
    }
    private JSONArray paths(JSONArray requested) throws Exception {
        assertEquals("staged-owner", requested.getJSONObject(0).getString("key"));
        return new JSONArray().put(new JSONObject().put("key", "staged-owner").put("fieldPath", "/blob")
            .put("blob", descriptor().put("path", "file:///data/private/blobs/a.bin")));
    }

    @Test public void batchesTheRequestedImagesAndKeepsStagedAttachmentIdentity() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        JSONArray result = NativeAssetImageSources.read(new JSONArray().put("\"a\"").put("\"b\""),
            new JSONArray().put(asset("a", false)).put(asset("b", false)),
            new JSONArray().put(file("a")).put(file("b")), references -> { calls.incrementAndGet(); return paths(references); });
        assertEquals(1, calls.get());
        assertEquals(2, result.length());
        assertTrue(result.getJSONObject(0).getJSONObject("blob").getString("path").startsWith("file:///"));
        assertFalse(result.getJSONObject(0).has("data"));
    }

    @Test public void neverRequestsPathsForEncryptedOrUnrecognizedRows() throws Exception {
        JSONArray result = NativeAssetImageSources.read(new JSONArray().put("\"a\"").put("\"missing\""),
            new JSONArray().put(asset("a", true)), new JSONArray().put(file("a")), references -> { fail("encrypted path exposed"); return null; });
        assertTrue(result.getJSONObject(0).getBoolean("fallback"));
        assertTrue(result.getJSONObject(1).getBoolean("fallback"));
    }

    @Test public void rejectsChangedHashSizeOrMimeWithoutReturningAPublicPath() throws Exception {
        for (String field : new String[] {"sha256", "size", "mimeType"}) {
            JSONArray result = NativeAssetImageSources.read(new JSONArray().put("\"a\""),
                new JSONArray().put(asset("a", false)), new JSONArray().put(file("a")), references -> {
                    JSONArray values = paths(references);
                    values.getJSONObject(0).getJSONObject("blob").put(field, "size".equals(field) ? 13 : "changed");
                    return values;
                });
            assertTrue(result.getJSONObject(0).has("error"));
            assertFalse(result.getJSONObject(0).has("blob"));
        }
    }

    @Test public void keepsMissingOrBrokenAttachmentsAsErrorsInsteadOfACompatibilityFallback() throws Exception {
        JSONArray result = NativeAssetImageSources.read(new JSONArray().put("\"a\""),
            new JSONArray().put(asset("a", false)), new JSONArray().put(file("a")), references -> new JSONArray());
        assertTrue(result.getJSONObject(0).has("error"));
        assertFalse(result.getJSONObject(0).has("fallback"));
    }

    @Test public void rejectsOversizedBatchesBeforeLookingUpPaths() throws Exception {
        JSONArray keys = new JSONArray(); for (int index = 0; index < 33; index++) keys.put("\"a\"");
        assertThrows(IllegalArgumentException.class, () -> NativeAssetImageSources.read(keys,
            new JSONArray(), new JSONArray(), references -> { fail("unexpected read"); return null; }));
    }
}
