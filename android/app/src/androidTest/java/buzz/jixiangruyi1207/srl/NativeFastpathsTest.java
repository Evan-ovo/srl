package buzz.jixiangruyi1207.srl;

import static org.junit.Assert.assertEquals;
import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public final class NativeFastpathsTest {
    @Test public void recentCardIndexKeepsTieOrderAndMeasuresDenseAndSparseLibraries() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        for (int size : new int[]{1000, 10000}) for (boolean sparse : new boolean[]{false, true}) {
            String name = "srl-recent-index-" + UUID.randomUUID();
            NativeAppDatabase database = new NativeAppDatabase(context, name);
            try {
                JSONArray records = new JSONArray();
                for (int index = 0; index < size; index++) {
                    String id = String.format(java.util.Locale.ROOT, "row-%05d", index);
                    // The same five cards appear at the top/bottom of the timestamp index.
                    String type = index < 5 ? "characterCard" : "chat";
                    long time = index < 5 ? (sparse ? 1 : size + 2) : index + 2;
                    records.put(new JSONObject().put("key", JSONObject.quote(id))
                        .put("value", new JSONObject().put("id", id).put("type", type)
                            .put("name", "查询夹具 " + id).put("updatedAt", time))
                        .put("indexes", new JSONArray()
                            .put(new JSONObject().put("name", "updatedAt").put("keys", new JSONArray().put(String.valueOf(time))))
                            .put(new JSONObject().put("name", "type").put("keys", new JSONArray().put(JSONObject.quote(type))))));
                }
                database.putRecords("resourceListSummaries", records);
                long[] baseline = new long[7], indexed = new long[7];
                int[] payloadReads = new int[1];
                for (int iteration = 0; iteration < 7; iteration++) {
                    for (int step = 0; step < 2; step++) {
                        boolean useIndex = (iteration + step) % 2 == 0;
                        long started = System.nanoTime();
                        JSONArray rows = useIndex
                            ? database.getRecentRecordsByIndex("resourceListSummaries", "updatedAt", 5, "type", JSONObject.quote("characterCard"))
                            : scanRecentCardRows(database, payloadReads);
                        long elapsed = System.nanoTime() - started;
                        (useIndex ? indexed : baseline)[iteration] = elapsed;
                        assertEquals(5, rows.length());
                        for (int i = 0; i < 5; i++) assertEquals(
                            String.format(java.util.Locale.ROOT, "row-%05d", 4 - i),
                            rows.getJSONObject(i).getJSONObject("value").getString("id"));
                    }
                }
                assertEquals(sparse ? size : 5, payloadReads[0]);
                long baselineFirst = baseline[0], indexedFirst = indexed[0];
                java.util.Arrays.sort(baseline); java.util.Arrays.sort(indexed);
                String metrics = "size=" + size + " sparse=" + sparse + " rows=" + payloadReads[0] + "->5"
                    + " firstNs=" + baselineFirst + "/" + indexedFirst
                    + " medianNs=" + baseline[3] + "/" + indexed[3] + " maxNs=" + baseline[6] + "/" + indexed[6];
                android.os.Bundle evidence = new android.os.Bundle(); evidence.putString("recentIndexMetrics", metrics);
                InstrumentationRegistry.getInstrumentation().sendStatus(2, evidence);
                // Timing is evidence, never a flaky speed assertion.
                assertEquals(0, database.getRecentRecordsByIndex("resourceListSummaries", "updatedAt", 5, "type", JSONObject.quote("regex")).length());
            } finally { database.close(); context.deleteDatabase(name); }
        }
    }

    private static JSONArray scanRecentCardRows(NativeAppDatabase database, int[] payloadReads) throws Exception {
        JSONObject query = new JSONObject().put("indexName", "updatedAt").put("reverse", true).put("limit", 100);
        JSONArray selected = new JSONArray();
        payloadReads[0] = 0;
        while (true) {
            JSONArray page = database.queryKeyPage("resourceListSummaries", query).getJSONArray("rows");
            for (int i = 0; i < page.length(); i++) {
                JSONObject key = page.getJSONObject(i);
                String primary = key.getString("primaryKey");
                JSONObject row = database.getRecord("resourceListSummaries", primary);
                payloadReads[0]++;
                if (row != null && "characterCard".equals(row.optString("type"))) {
                    selected.put(new JSONObject().put("key", primary).put("value", row));
                    if (selected.length() == 5) return selected;
                }
            }
            if (page.length() < 100) return selected;
            JSONObject last = page.getJSONObject(page.length() - 1);
            query.put("afterKey", last.getString("indexKey")).put("afterPrimaryKey", last.getString("primaryKey"));
        }
    }


}
