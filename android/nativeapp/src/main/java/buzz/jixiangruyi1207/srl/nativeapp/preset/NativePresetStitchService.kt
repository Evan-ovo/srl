package buzz.jixiangruyi1207.srl.nativeapp.preset

import buzz.jixiangruyi1207.srl.nativeapp.data.NativeResourceStore
import buzz.jixiangruyi1207.srl.nativeapp.model.NativeResource
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.util.UUID

data class NativePresetSegment(
    val sourceResourceId: String,
    val sourceName: String,
    val identifier: String,
    val name: String,
    val role: String,
    val content: String,
    val enabled: Boolean,
    val marker: Boolean,
    val inOrder: Boolean,
    val promptJson: String,
)

data class NativeStitchRequest(
    val baseResourceId: String,
    val pickedSegments: List<NativePresetSegment>,
    val regexSourceIds: List<String>,
    val productName: String,
)

class NativePresetStitchService(private val store: NativeResourceStore) {
    fun presetResources(): List<NativeResource> = store.loadResources().filter { it.type == "preset" }

    fun listSegments(resourceId: String): List<NativePresetSegment> {
        val resource = presetResources().firstOrNull { it.id == resourceId } ?: throw IllegalArgumentException("预设资源不存在")
        val root = readPreset(resourceId)
        val prompts = root.optJSONArray("prompts") ?: JSONArray()
        val promptById = mutableMapOf<String, JSONObject>()
        for (index in 0 until prompts.length()) {
            val prompt = prompts.optJSONObject(index) ?: continue
            promptById[prompt.optString("identifier")] = prompt
        }
        val order = readPresetOrder(root)
        val seen = mutableSetOf<String>()
        val result = mutableListOf<NativePresetSegment>()
        for (index in 0 until order.length()) {
            val orderItem = order.optJSONObject(index) ?: continue
            val identifier = orderItem.optString("identifier")
            val prompt = promptById[identifier] ?: continue
            if (!seen.add(identifier)) continue
            result += segment(resource, prompt, orderItem.optBoolean("enabled", true), true)
        }
        for (index in 0 until prompts.length()) {
            val prompt = prompts.optJSONObject(index) ?: continue
            val identifier = prompt.optString("identifier")
            if (!seen.add(identifier)) continue
            result += segment(resource, prompt, false, false)
        }
        return result
    }

    fun regexCount(resourceId: String): Int = regexScripts(readPreset(resourceId)).length()

    fun stitch(request: NativeStitchRequest): NativeResource {
        require(request.productName.trim().isNotBlank()) { "先给自缝版预设起个名字" }
        require(request.pickedSegments.isNotEmpty() || request.regexSourceIds.isNotEmpty()) { "至少选择一个提示词段或一组正则" }
        val baseResource = presetResources().firstOrNull { it.id == request.baseResourceId }
            ?: throw IllegalArgumentException("主预设已经不存在")
        request.pickedSegments.forEach { auditContent(it.name, it.content) }
        val base = readPreset(baseResource.id)
        val preset = JSONObject(base.toString())
        val prompts = preset.optJSONArray("prompts") ?: JSONArray().also { preset.put("prompts", it) }
        val usedIdentifiers = mutableSetOf<String>()
        for (index in 0 until prompts.length()) prompts.optJSONObject(index)?.optString("identifier")?.let(usedIdentifiers::add)
        val provenance = JSONArray()
        val finalIdentifiers = mutableListOf<Pair<NativePresetSegment, String>>()
        request.pickedSegments.forEach { picked ->
            val clone = JSONObject(picked.promptJson)
            var identifier = picked.identifier
            var name = picked.name
            if (identifier.isBlank() || identifier in usedIdentifiers) {
                identifier = UUID.randomUUID().toString()
                if (name.isNotBlank()) name += "·缝"
            }
            usedIdentifiers += identifier
            clone.put("identifier", identifier).put("name", name).put("role", picked.role).put("content", picked.content)
            prompts.put(clone)
            finalIdentifiers += picked to identifier
            provenance.put(JSONObject().put("kind", "segment").put("resourceId", picked.sourceResourceId)
                .put("resourceName", picked.sourceName).put("identifier", picked.identifier)
                .put("finalIdentifier", identifier).put("name", picked.name))
        }
        rebuildOrders(preset, base, finalIdentifiers)
        mergeRegex(preset, request.regexSourceIds, provenance)
        if (!preset.has("name") || preset.opt("name") is String) preset.put("name", request.productName.trim())
        val safeName = request.productName.trim().replace(Regex("[\\/:*?\"<>|]"), "_").take(120).ifBlank { "stitched-preset" }
        val result = store.importGeneratedJson("$safeName.json", "${preset.toString(2)}\n")
        require(result.type == "preset") { "缝合结果没有通过 SillyTavern 预设格式校验" }
        val sourceIds = (listOf(baseResource.id) + request.pickedSegments.map { it.sourceResourceId } + request.regexSourceIds).distinct()
        store.annotateResource(result.id, JSONObject().put("stitchedFrom", provenance).put("baseResourceId", baseResource.id), sourceIds)
        return store.loadResources().first { it.id == result.id }
    }

    private fun rebuildOrders(preset: JSONObject, base: JSONObject, picks: List<Pair<NativePresetSegment, String>>) {
        val baseOrder = readPresetOrder(base)
        val baseOrderIds = (0 until baseOrder.length()).mapNotNull { baseOrder.optJSONObject(it)?.optString("identifier") }.toSet()
        val groups = preset.optJSONArray("prompt_order")
        if (groups == null || groups.length() == 0) {
            val order = JSONArray()
            for (index in 0 until baseOrder.length()) order.put(JSONObject(baseOrder.getJSONObject(index).toString()))
            picks.forEach { (entry, identifier) -> order.put(JSONObject().put("identifier", identifier).put("enabled", entry.enabled)) }
            preset.put("prompt_order", JSONArray().put(JSONObject().put("character_id", 100001).put("order", order)))
            return
        }
        for (groupIndex in 0 until groups.length()) {
            val group = groups.optJSONObject(groupIndex) ?: continue
            val oldOrder = group.optJSONArray("order") ?: JSONArray()
            val originalById = mutableMapOf<String, JSONObject>()
            for (index in 0 until oldOrder.length()) oldOrder.optJSONObject(index)?.let { originalById[it.optString("identifier")] = it }
            val rebuilt = JSONArray()
            for (index in 0 until baseOrder.length()) {
                val baseItem = baseOrder.getJSONObject(index)
                val id = baseItem.optString("identifier")
                val source = originalById[id] ?: baseItem
                rebuilt.put(JSONObject(source.toString()))
            }
            picks.forEach { (entry, identifier) -> rebuilt.put(JSONObject().put("identifier", identifier).put("enabled", entry.enabled)) }
            for (index in 0 until oldOrder.length()) {
                val item = oldOrder.optJSONObject(index) ?: continue
                if (item.optString("identifier") !in baseOrderIds) rebuilt.put(JSONObject(item.toString()))
            }
            group.put("order", rebuilt)
        }
    }

    private fun mergeRegex(preset: JSONObject, sourceIds: List<String>, provenance: JSONArray) {
        if (sourceIds.isEmpty()) return
        val extensions = preset.optJSONObject("extensions") ?: JSONObject().also { preset.put("extensions", it) }
        val target = extensions.optJSONArray("regex_scripts") ?: JSONArray().also { extensions.put("regex_scripts", it) }
        val usedIds = mutableSetOf<String>()
        for (index in 0 until target.length()) target.optJSONObject(index)?.optString("id")?.let(usedIds::add)
        sourceIds.distinct().forEach { sourceId ->
            val sourceResource = presetResources().firstOrNull { it.id == sourceId } ?: return@forEach
            val scripts = regexScripts(readPreset(sourceId))
            for (index in 0 until scripts.length()) {
                val source = scripts.optJSONObject(index) ?: continue
                val clone = JSONObject(source.toString())
                val originalId = clone.optString("id")
                val finalId = originalId.takeIf { it.isNotBlank() && it !in usedIds } ?: UUID.randomUUID().toString()
                usedIds += finalId
                clone.put("id", finalId)
                target.put(clone)
                provenance.put(JSONObject().put("kind", "regex").put("resourceId", sourceId).put("resourceName", sourceResource.name)
                    .put("identifier", originalId).put("finalIdentifier", finalId)
                    .put("name", clone.optString("scriptName", clone.optString("script_name", "未命名正则"))))
            }
        }
    }

    private fun readPreset(resourceId: String): JSONObject {
        val root = runCatching { JSONTokener(store.readResourceText(resourceId)).nextValue() as? JSONObject }.getOrNull()
            ?: throw IllegalArgumentException("预设 JSON 已损坏")
        require(root.opt("prompts") is JSONArray || root.opt("prompt_order") is JSONArray) { "资源不是可缝制的提示词预设" }
        return root
    }

    companion object {
        // 与 Web 的 PresetStitcher 一致：使用酒馆全局组，旧文件才取首个有效组。
        internal fun readPresetOrder(root: JSONObject): JSONArray {
            val groups = root.optJSONArray("prompt_order") ?: return JSONArray()
            var firstOrder: JSONArray? = null
            for (index in 0 until groups.length()) {
                val group = groups.optJSONObject(index) ?: continue
                val order = group.optJSONArray("order") ?: continue
                if (group.optString("character_id") == "100001") return order
                if (firstOrder == null) firstOrder = order
            }
            return firstOrder ?: JSONArray()
        }
    }

    private fun regexScripts(root: JSONObject): JSONArray = root.optJSONObject("extensions")?.optJSONArray("regex_scripts") ?: JSONArray()

    private fun segment(resource: NativeResource, prompt: JSONObject, enabled: Boolean, inOrder: Boolean): NativePresetSegment {
        val identifier = prompt.optString("identifier")
        return NativePresetSegment(resource.id, resource.name, identifier,
            prompt.optString("name").ifBlank { identifier.ifBlank { "未命名段" } },
            prompt.optString("role").ifBlank { if (prompt.optBoolean("system_prompt")) "system" else "" },
            prompt.optString("content"), enabled, prompt.optBoolean("marker"), inOrder, prompt.toString())
    }

    private fun auditContent(name: String, content: String) {
        var braces = 0
        var index = 0
        while (index < content.length - 1) {
            when (content.substring(index, index + 2)) {
                "{{" -> { braces += 1; index += 1 }
                "}}" -> { braces -= 1; require(braces >= 0) { "「$name」的大括号没有配对" }; index += 1 }
            }
            index += 1
        }
        require(braces == 0) { "「$name」的大括号没有配对" }
        var conditions = 0
        Regex("\\{\\{\\s*#?\\s*(/if|if|else)\\b", RegexOption.IGNORE_CASE).findAll(content).forEach { match ->
            when (match.groupValues[1].lowercase()) {
                "if" -> conditions += 1
                "/if" -> { conditions -= 1; require(conditions >= 0) { "「$name」的条件块没有关闭" } }
                "else" -> require(conditions > 0) { "「$name」的条件块没有关闭" }
            }
        }
        require(conditions == 0) { "「$name」的条件块没有关闭" }
    }
}
