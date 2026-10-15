package buzz.jixiangruyi1207.srl.nativeapp.preset

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

class NativePresetOrderTest {
    @Test
    fun usesGlobalGroupInsteadOfLongerOldGroupWithoutMutatingSource() {
        for (id in listOf(100001, "100001")) {
            val root = JSONObject().put("prompt_order", JSONArray()
                .put(group(100000, """[{"identifier":"a","enabled":true},{"identifier":"b","enabled":true},{"identifier":"c","enabled":true}]"""))
                .put(group(id, """[{"identifier":"b","enabled":false},{"identifier":"a","enabled":true}]""")))
            val original = root.toString()
            val order = NativePresetStitchService.readPresetOrder(root)
            assertEquals(2, order.length())
            assertEquals("b", order.getJSONObject(0).getString("identifier"))
            assertEquals(false, order.getJSONObject(0).getBoolean("enabled"))
            assertEquals("a", order.getJSONObject(1).getString("identifier"))
            assertEquals(original, root.toString())
        }
    }

    @Test
    fun emptyGlobalGroupDoesNotBorrowOldOrder() {
        val root = JSONObject().put("prompt_order", JSONArray()
            .put(group(100000, """[{"identifier":"a","enabled":true}]"""))
            .put(group(100001, "[]")))
        assertEquals(0, NativePresetStitchService.readPresetOrder(root).length())
    }

    @Test
    fun legacyGroupsUseFirstValidGroupAndMissingGroupsStayEmpty() {
        val root = JSONObject().put("prompt_order", JSONArray()
            .put(JSONObject().put("character_id", 8).put("order", JSONObject.NULL))
            .put(group(9, """[{"identifier":"b"}]"""))
            .put(group(10, """[{"identifier":"a"},{"identifier":"b"}]""")))
        val order = NativePresetStitchService.readPresetOrder(root)
        assertEquals(1, order.length())
        assertEquals("b", order.getJSONObject(0).getString("identifier"))
        assertEquals(0, NativePresetStitchService.readPresetOrder(JSONObject()).length())
    }

    private fun group(id: Any, order: String): JSONObject =
        JSONObject().put("character_id", id).put("order", JSONArray(order))
}
