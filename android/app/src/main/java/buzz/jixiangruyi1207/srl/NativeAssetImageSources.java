package buzz.jixiangruyi1207.srl;

import java.util.HashMap;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

/** Read-only projection of the existing asset records; never exposes encrypted bytes. */
final class NativeAssetImageSources {
    static final int MAX_BATCH = 32;
    interface Paths { JSONArray read(JSONArray references) throws Exception; }

    static JSONArray selectCardKeys(JSONArray keys, JSONArray assets, JSONArray cardKeys) throws Exception {
        if(cardKeys!=null && cardKeys.length()>MAX_BATCH)throw new IllegalArgumentException("图片读取批次无效");
        java.util.Set<String> requested=new java.util.HashSet<>();
        if(cardKeys!=null)for(int index=0;index<cardKeys.length();index++)requested.add(cardKeys.getString(index));
        Map<String,JSONObject> byKey=rows(assets); JSONArray selected=new JSONArray();
        for(int index=0;index<keys.length();index++) {
            String key=keys.getString(index); JSONObject asset=byKey.get(key);
            JSONObject refs=asset==null?null:asset.optJSONObject("thumbnailRefs");
            String card=refs==null?"":refs.optString("card");
            selected.put(requested.contains(key) && asset!=null && !asset.optBoolean("encrypted")
                && JSONObject.quote(asset.optString("assetId")).equals(key)
                && asset.optString("mimeType").startsWith("image/")
                && !card.isEmpty() ? JSONObject.quote(card) : key);
        }
        return selected;
    }

    static JSONArray read(JSONArray keys, JSONArray assets, JSONArray files, Paths paths) throws Exception {
        if (keys == null || keys.length() > MAX_BATCH) throw new IllegalArgumentException("图片读取批次无效");
        Map<String, JSONObject> assetByKey = rows(assets), fileByKey = rows(files);
        Map<String, JSONObject> references = new HashMap<>();
        JSONArray requested = new JSONArray();
        for (int index = 0; index < keys.length(); index++) {
            String key = keys.getString(index);
            JSONObject asset = assetByKey.get(key), file = fileByKey.get(key);
            if (asset == null || file == null || asset.optBoolean("encrypted")
                    || !asset.optString("mimeType").startsWith("image/")) continue;
            JSONObject blob = file.optJSONObject("blob");
            if (blob == null || !("blob".equals(blob.optString("__srlAppDatabaseValueV1"))
                    || "file".equals(blob.optString("__srlAppDatabaseValueV1")))) continue;
            String id = asset.optString("assetId");
            if (id.isEmpty() || !id.equals(file.optString("assetId")) || !JSONObject.quote(id).equals(key)) continue;
            references.put(key, blob);
            requested.put(new JSONObject().put("key", blob.optString("blobOwnerKey", key))
                .put("fieldPath", blob.getString("fieldPath")));
        }
        Map<String, JSONObject> byReference = new HashMap<>();
        if (requested.length() > 0) {
            JSONArray found = paths.read(requested);
            for (int index = 0; index < found.length(); index++) {
                JSONObject row = found.getJSONObject(index);
                byReference.put(identity(row.getString("key"), row.getString("fieldPath")), row);
            }
        }
        JSONArray output = new JSONArray();
        for (int index = 0; index < keys.length(); index++) {
            String key = keys.getString(index);
            JSONObject row = new JSONObject().put("key", key), reference = references.get(key);
            if (reference == null) row.put("fallback", true);
            else {
                JSONObject found = byReference.get(identity(reference.optString("blobOwnerKey", key), reference.getString("fieldPath")));
                JSONObject blob = found == null ? null : found.optJSONObject("blob");
                JSONObject asset = assetByKey.get(key);
                if (blob == null) row.put("error", found == null ? "图片附件不存在" : found.optString("error", "图片附件不存在"));
                else if (!reference.optString("sha256").equals(blob.optString("sha256"))
                        || reference.optLong("size", -1) != blob.optLong("size", -2)
                        || !reference.optString("mimeType").equals(blob.optString("mimeType"))
                        || !asset.optString("mimeType").equals(blob.optString("mimeType"))
                        || asset.optLong("size", -1) != blob.optLong("size", -2))
                    row.put("error", "图片附件在读取期间已变化");
                else row.put("blob", blob);
            }
            output.put(row);
        }
        return output;
    }

    private static Map<String, JSONObject> rows(JSONArray rows) throws Exception {
        Map<String, JSONObject> result = new HashMap<>();
        for (int index = 0; index < rows.length(); index++) {
            JSONObject row = rows.getJSONObject(index);
            result.put(row.getString("key"), row.getJSONObject("value"));
        }
        return result;
    }

    static String identity(String key, String field) {
        return new JSONArray().put(key).put(field).toString();
    }
}
