package buzz.jixiangruyi1207.srl.nativeapp.cloud

import android.content.Context
import buzz.jixiangruyi1207.srl.nativeapp.data.NativePreparedCloudResource
import buzz.jixiangruyi1207.srl.nativeapp.data.NativeResourceStore
import buzz.jixiangruyi1207.srl.nativeapp.parser.NativeResourceParser
import buzz.jixiangruyi1207.srl.nativeapp.model.NativeBackupSelection
import org.json.JSONObject
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.time.Instant
import java.util.UUID
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.ConcurrentHashMap
import java.util.zip.GZIPOutputStream

private const val ORPHAN_GRACE_MS = 24L * 60L * 60L * 1000L

class NativeCloudBackupService(
    private val context: Context,
    private val store: NativeResourceStore,
    private val clock: () -> Long = System::currentTimeMillis,
    private val providerFactory: ((String) -> NativeObjectProvider)? = null,
) {
    private val preferences = context.getSharedPreferences("srl-native-cloud-config", Context.MODE_PRIVATE)
    private val secrets = NativeSecretStore(context)

    fun loadGitHubConfig(): NativeGitHubConfig? = preferences.getString("github", null)?.let { value ->
        runCatching {
            val json = JSONObject(value)
            NativeGitHubConfig(
                owner = json.getString("owner"), repository = json.getString("repository"),
                retention = json.optInt("retention", 7).coerceIn(1, 30), autoBackup = json.optBoolean("autoBackup"),
                wifiOnly = json.optBoolean("wifiOnly", true), chargingOnly = json.optBoolean("chargingOnly", false),
            )
        }.getOrNull()
    }

    fun loadWebDavConfig(): NativeWebDavConfig? = preferences.getString("webdav", null)?.let { value ->
        runCatching {
            val json = JSONObject(value)
            NativeWebDavConfig(
                baseUrl = json.getString("baseUrl"), folder = json.optString("folder", "SRL-Backups"), username = json.getString("username"),
                retention = json.optInt("retention", 7).coerceIn(1, 30), autoBackup = json.optBoolean("autoBackup"),
                wifiOnly = json.optBoolean("wifiOnly", true), chargingOnly = json.optBoolean("chargingOnly", false),
            )
        }.getOrNull()
    }

    fun saveGitHub(config: NativeGitHubConfig, token: String?) {
        require(config.owner.isNotBlank() && config.repository.isNotBlank()) { "请填写 GitHub 仓库所有者和仓库名" }
        val previous = secrets.read("github")
        val candidate = token?.trim()?.takeIf(String::isNotBlank) ?: previous
        require(!candidate.isNullOrBlank()) { "请填写 GitHub 令牌" }
        if (!token.isNullOrBlank()) NativeGitHubProvider(config, candidate).test()
        if (!token.isNullOrBlank()) secrets.save("github", candidate)
        val json = JSONObject().put("owner", config.owner.trim()).put("repository", config.repository.trim())
            .put("retention", config.retention.coerceIn(1, 30)).put("autoBackup", config.autoBackup)
            .put("wifiOnly", config.wifiOnly).put("chargingOnly", config.chargingOnly)
        preferences.edit().putString("github", json.toString()).apply()
    }

    fun saveWebDav(config: NativeWebDavConfig, password: String?) {
        require(config.baseUrl.startsWith("https://", true)) { "WebDAV 地址必须使用 HTTPS" }
        require(config.username.isNotBlank()) { "请填写 WebDAV 用户名" }
        val previous = secrets.read("webdav")
        val candidate = password?.takeIf(String::isNotBlank) ?: previous
        require(!candidate.isNullOrBlank()) { "请填写 WebDAV 应用密码" }
        if (!password.isNullOrBlank()) NativeWebDavProvider(config, candidate).test()
        if (!password.isNullOrBlank()) secrets.save("webdav", candidate)
        val json = JSONObject().put("baseUrl", config.baseUrl.trim()).put("folder", config.folder.trim().ifBlank { "SRL-Backups" })
            .put("username", config.username.trim()).put("retention", config.retention.coerceIn(1, 30)).put("autoBackup", config.autoBackup)
            .put("wifiOnly", config.wifiOnly).put("chargingOnly", config.chargingOnly)
        preferences.edit().putString("webdav", json.toString()).apply()
    }

    fun test(providerName: String): String = provider(providerName).test()

    fun credentialState(providerName: String): NativeCredentialState = secrets.state(providerName)

    fun createBackup(
        providerName: String,
        selection: NativeBackupSelection = NativeBackupSelection(),
        onProgress: (NativeCloudProgress) -> Unit,
    ): NativeCloudBackup {
        selection.requireContent()
        recordBackupAttempt(providerName)
        val provider = provider(providerName)
        onProgress(NativeCloudProgress("正在读取本机资源并计算内容摘要…"))
        val sources = store.loadCloudSources().filter { if (it.isVersion) selection.versions else selection.resources }
        val categories = if (selection.categories) store.cloudCategoriesJson() else "[]"
        val portableData = if (selection.portableData) store.portableDataJson() else JSONObject().put("version", 1).toString()
        val built = NativeStructuredSnapshotBuilder(context).build(sources, categories, portableData)
        try {
            onProgress(NativeCloudProgress("正在读取云端对象索引…"))
            val existing = provider.listObjects().associateBy { it.name }
            val existingByLogicalName = existing.values.associateBy { logicalObjectName(it.name) }
            for ((name, file) in built.chunks) {
                val present = existingByLogicalName[name]
                require(present == null || present.size == file.length()) { "云端内容寻址对象大小冲突；拒绝覆盖 immutable 对象：$name" }
            }
            val jobs = built.chunks.entries.filter { existingByLogicalName[it.key] == null }
            onProgress(NativeCloudProgress("已复用 ${built.chunks.size - jobs.size} 个内容块；需要上传 ${jobs.size} 个变化块", 0, jobs.size))
            val placements = existingByLogicalName.filterKeys { built.chunks.containsKey(it) }.toMutableMap()
            placements.putAll(uploadChunks(provider, jobs, onProgress))
            writeStorageLocators(built.snapshotFile, providerName, placements)
            onProgress(NativeCloudProgress("变化块已完成，正在最后提交快照清单…", jobs.size, jobs.size))
            val uploaded = provider.upload(built.objectKey, built.snapshotFile, "application/gzip")
            val backup = NativeCloudBackup(
                uploaded.id, uploaded.name, built.totalSize, uploaded.createdAt, built.chunks.size,
                providerName, legacy = false, kind = "snapshot", archiveName = logicalObjectName(uploaded.name).replace(Regex("\\.(?:srlsnapshot|srlmanifest\\.v3)\\.json(?:\\.gz)?$"), ".zip"),
            )
            preferences.edit().putLong("lastBackup-$providerName", System.currentTimeMillis()).apply()
            try {
                pruneOldSnapshots(providerName, provider, onProgress)
            } catch (error: Exception) {
                onProgress(NativeCloudProgress("新快照已成功提交；旧快照维护失败但不影响本次备份：${error.message.orEmpty()}"))
            }
            return backup
        } finally {
            built.buildDirectory.deleteRecursively()
        }
    }

    fun listBackups(providerName: String, onProgress: (NativeCloudProgress) -> Unit = {}): List<NativeCloudBackup> {
        val provider = provider(providerName)
        onProgress(NativeCloudProgress("正在读取云端对象索引…"))
        val objects = provider.listObjects()
        val byName = objects.associateBy { it.name }
        val backups = objects.filter { it.name.endsWith(".zip", true) || it.name.endsWith(".srlbundle.json", true) }
            .map { objectValue ->
                val kind = if (objectValue.name.endsWith(".srlbundle.json", true)) "bundle" else "single"
                NativeCloudBackup(objectValue.id, objectValue.name, objectValue.size, objectValue.createdAt, 1, providerName, legacy = true, kind = kind,
                    archiveName = objectValue.name.removeSuffix(".srlbundle.json"))
            }.toMutableList()
        val snapshots = objects.filter {
            it.name.endsWith(".srlsnapshot.json.gz", true) ||
                it.name.endsWith(".srlsnapshot.json", true) ||
                it.name.endsWith(".srlmanifest.v3.json.gz", true) ||
                it.name.endsWith(".srlmanifest.v3.json", true)
        }
        snapshots.forEachIndexed { index, objectValue ->
            onProgress(NativeCloudProgress("正在校验云端快照 ${index + 1} / ${snapshots.size}…", index, snapshots.size))
            val temporary = File(context.cacheDir, "cloud-list-${UUID.randomUUID()}")
            try {
                provider.download(objectValue.name, temporary)
                val snapshot = NativeCloudSnapshotCodec.decode(temporary)
                val parts = NativeCloudSnapshotCodec.referencedParts(snapshot, providerName)
                if (parts.all { (name, size) -> byName[name]?.size == size }) {
                    val total = sequenceOf(snapshot.getJSONArray("resources"), snapshot.getJSONArray("versions")).sumOf { array ->
                        (0 until array.length()).sumOf { array.getJSONObject(it).getLong("fileSize") }
                    }
                    backups += NativeCloudBackup(objectValue.id, objectValue.name, total, objectValue.createdAt.takeIf { it > 0 } ?: Instant.parse(snapshot.getString("createdAt")).toEpochMilli(),
                        parts.size, providerName, legacy = false, kind = "snapshot", archiveName = logicalObjectName(objectValue.name).replace(Regex("\\.(?:srlsnapshot|srlmanifest\\.v3)\\.json(?:\\.gz)?$"), ".zip"))
                }
            } catch (_: Exception) {
                // 清单损坏或内容块不完整时不能暴露为可恢复备份。
            } finally {
                temporary.delete()
            }
        }
        onProgress(NativeCloudProgress("云端备份列表已读取", snapshots.size, snapshots.size))
        return backups.sortedByDescending { it.createdAt }
    }

    fun restoreBackup(
        backup: NativeCloudBackup,
        replace: Boolean,
        onProgress: (NativeCloudProgress) -> Unit,
    ): Pair<Int, Int> {
        val provider = provider(backup.provider)
        val downloaded = File(context.cacheDir, "cloud-restore-${UUID.randomUUID()}")
        var archive: File? = null
        try {
            onProgress(NativeCloudProgress("正在下载云端备份清单…"))
            provider.download(backup.objectKey, downloaded)
            if (backup.kind == "snapshot") {
                return restoreSnapshot(
                    provider,
                    NativeCloudSnapshotCodec.decode(downloaded),
                    replace,
                    onProgress,
                )
            }
            archive = when (backup.kind) {
                "bundle" -> materializeBundle(provider, JSONObject(downloaded.readText(Charsets.UTF_8)), onProgress)
                else -> {
                    if (backup.objectKey.endsWith(".zip", true)) downloaded
                    else throw IllegalArgumentException("不支持的旧版云备份格式")
                }
            }
            onProgress(NativeCloudProgress(if (replace) "校验完成，正在安全替换本机资源…" else "校验完成，正在安全合并到本机资源…"))
            return store.importArchiveFile(archive, replace)
        } finally {
            if (archive != null && archive != downloaded) archive.delete()
            downloaded.delete()
        }
    }

    fun deleteBackup(backup: NativeCloudBackup) {
        provider(backup.provider).delete(backup.objectKey)
    }

    fun recordBackupAttempt(providerName: String, attemptedAt: Long = clock()) {
        require(providerName == "github" || providerName == "webdav") { "不支持的云备份方式" }
        preferences.edit().putLong("lastAttempt-$providerName", attemptedAt).apply()
    }

    fun automaticProvidersDue(isUnmetered: Boolean, isCharging: Boolean, now: Long = System.currentTimeMillis()): List<String> {
        val minimumInterval = 24L * 60L * 60L * 1000L
        return listOfNotNull(
            loadGitHubConfig()?.let { "github" to it },
            loadWebDavConfig()?.let { "webdav" to it },
        ).filter { (name, config) ->
            config.autoBackup && (!config.wifiOnly || isUnmetered) && (!config.chargingOnly || isCharging) &&
                now - maxOf(
                    preferences.getLong("lastBackup-$name", 0L),
                    preferences.getLong("lastAttempt-$name", 0L),
                ) >= minimumInterval
        }.map { it.first }
    }

    private fun provider(providerName: String): NativeObjectProvider {
        val delegate = providerFactory?.invoke(providerName) ?: when (providerName) {
        "github" -> NativeGitHubProvider(loadGitHubConfig() ?: throw IllegalStateException("请先保存 GitHub 配置"), secrets.read("github") ?: throw IllegalStateException("GitHub 令牌未保存"))
        "webdav" -> NativeWebDavProvider(loadWebDavConfig() ?: throw IllegalStateException("请先保存 WebDAV 配置"), secrets.read("webdav") ?: throw IllegalStateException("WebDAV 应用密码未保存"))
        else -> throw IllegalArgumentException("不支持的云端方式")
        }
        return CredentialAwareProvider(providerName, delegate, secrets)
    }

    private fun uploadChunks(provider: NativeObjectProvider, jobs: List<Map.Entry<String, File>>, onProgress: (NativeCloudProgress) -> Unit): Map<String, NativeCloudObject> {
        if (jobs.isEmpty()) return emptyMap()
        val concurrency = if (provider.providerName == "github") 3 else 2
        val completed = AtomicInteger(0)
        val uploaded = ConcurrentHashMap<String, NativeCloudObject>()
        val pool = Executors.newFixedThreadPool(concurrency)
        try {
            val futures = jobs.map { (name, file) -> pool.submit(Callable {
                uploaded[name] = provider.upload(name, file, "application/octet-stream")
                val count = completed.incrementAndGet()
                onProgress(NativeCloudProgress("变化块已完成 $count / ${jobs.size}…", count, jobs.size))
            }) }
            futures.forEach { it.get() }
        } finally {
            pool.shutdownNow()
        }
        return uploaded
    }

    private fun restoreSnapshot(
        provider: NativeObjectProvider,
        snapshot: JSONObject,
        replace: Boolean,
        onProgress: (NativeCloudProgress) -> Unit,
    ): Pair<Int, Int> {
        val parts = NativeCloudSnapshotCodec.referencedParts(snapshot, provider.providerName)
        val cacheDirectory = File(context.cacheDir, "cloud-parts-${UUID.randomUUID()}").apply { mkdirs() }
        val prepared = mutableListOf<NativePreparedCloudResource>()
        try {
            val partFiles = linkedMapOf<String, File>()
            parts.entries.forEachIndexed { index, (name, expectedSize) ->
                onProgress(NativeCloudProgress("正在下载并校验内容块 ${index + 1} / ${parts.size}…", index, parts.size))
                val file = File(cacheDirectory, UUID.randomUUID().toString())
                provider.download(name, file)
                val logicalName = logicalObjectName(name)
                require(file.length() == expectedSize && NativeCloudSnapshotCodec.sha256(file) == logicalName.removePrefix("srl-chunk--sha256-").lowercase()) { "云端内容块校验失败：$name" }
                partFiles[name] = file
            }
            for ((key, isVersion) in listOf("resources" to false, "versions" to true)) {
                val records = snapshot.getJSONArray(key)
                for (index in 0 until records.length()) {
                    val record = JSONObject(records.getJSONObject(index).toString())
                    val objectManifest = record.getJSONObject("object")
                    val original = materializeObject(objectManifest, partFiles, provider.providerName)
                    restoreCardMetadata(record, original)
                    prepared += NativePreparedCloudResource(record, original, isVersion)
                }
            }
            onProgress(NativeCloudProgress(if (replace) "校验完成，正在原生流式替换本机资源…" else "校验完成，正在原生流式合并到本机资源…"))
            return store.importCloudSnapshot(snapshot, prepared, replace)
        } finally {
            prepared.forEach { it.file.delete() }
            cacheDirectory.deleteRecursively()
        }
    }

    private fun materializeBundle(provider: NativeObjectProvider, raw: JSONObject, onProgress: (NativeCloudProgress) -> Unit): File {
        val bundle = NativeCloudSnapshotCodec.validateBundle(raw)
        val partFiles = linkedMapOf<String, File>()
        val tempDirectory = File(context.cacheDir, "cloud-bundle-${UUID.randomUUID()}").apply { mkdirs() }
        try {
            val parts = bundle.getJSONArray("parts")
            for (index in 0 until parts.length()) {
                val part = parts.getJSONObject(index)
                onProgress(NativeCloudProgress("正在恢复旧备份分卷 ${index + 1} / ${parts.length()}…", index, parts.length()))
                val file = File(tempDirectory, UUID.randomUUID().toString())
                provider.download(part.getString("name"), file)
                partFiles[part.getString("name")] = file
            }
            return materializeObject(bundle, partFiles, provider.providerName)
        } finally {
            tempDirectory.deleteRecursively()
        }
    }

    private fun materializeObject(bundle: JSONObject, stored: Map<String, File>, providerName: String): File {
        NativeCloudSnapshotCodec.validateBundle(bundle)
        val output = File(context.cacheDir, "cloud-object-${UUID.randomUUID()}")
        FileOutputStream(output).buffered(128 * 1024).use { target ->
            val parts = bundle.getJSONArray("parts")
            for (index in 0 until parts.length()) {
                val part = parts.getJSONObject(index)
                val objectKey = NativeCloudSnapshotCodec.providerObjectKey(part, providerName)
                val source = stored[objectKey] ?: throw IllegalArgumentException("云端对象缺少分块：$objectKey")
                val expectedStored = if (part.has("storedSize")) part.getLong("storedSize") else part.getLong("size")
                require(source.length() == expectedStored && NativeCloudSnapshotCodec.sha256(source).equals(part.getString("sha256"), true)) { "云端对象分块校验失败：${part.getString("name")}" }
                RandomAccessFile(source, "r").use { input ->
                    input.seek(if (part.has("offset")) part.getLong("offset") else 0)
                    var remaining = part.getLong("size")
                    val buffer = ByteArray(128 * 1024)
                    while (remaining > 0) {
                        val count = input.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt())
                        require(count > 0) { "云端对象分块内容不足" }
                        target.write(buffer, 0, count)
                        remaining -= count
                    }
                }
            }
        }
        require(output.length() == bundle.getLong("totalSize") && NativeCloudSnapshotCodec.sha256(output).equals(bundle.getString("totalSha256"), true)) {
            output.delete(); "云端对象完整性校验失败：${bundle.optString("fileName")}"
        }
        return output
    }

    private fun restoreCardMetadata(record: JSONObject, file: File) {
        if (record.optString("type") != "characterCard") return
        val metadata = record.optJSONObject("metadata") ?: JSONObject().also { record.put("metadata", it) }
        if (metadata.optJSONObject("card") != null) return
        val parsed = NativeResourceParser.parse(file, record.optString("fileName", file.name))
        val parsedMetadata = JSONObject(parsed.metadataJson)
        val card = parsedMetadata.optJSONObject("card") ?: throw IllegalArgumentException("无法从已校验原文件重建角色卡清单：${record.optString("fileName")}")
        metadata.put("card", card)
    }

    private fun pruneOldSnapshots(providerName: String, provider: NativeObjectProvider, onProgress: (NativeCloudProgress) -> Unit) {
        val keep = when (providerName) { "github" -> loadGitHubConfig()?.retention; else -> loadWebDavConfig()?.retention } ?: return
        val snapshots = provider.listObjects().filter {
            it.name.endsWith(".srlsnapshot.json.gz", true) || it.name.endsWith(".srlsnapshot.json", true) ||
            it.name.endsWith(".srlmanifest.v3.json.gz", true) || it.name.endsWith(".srlmanifest.v3.json", true)
        }.sortedWith(compareByDescending<NativeCloudObject> { it.createdAt }.thenByDescending { it.name })
        val referenced = mutableSetOf<String>()
        for (snapshot in snapshots.take(keep)) {
            val temporary = File(context.cacheDir, "cloud-prune-${UUID.randomUUID()}")
            try {
                provider.download(snapshot.name, temporary)
                referenced += NativeCloudSnapshotCodec.referencedParts(
                    NativeCloudSnapshotCodec.decode(temporary), providerName,
                ).keys
            } finally {
                temporary.delete()
            }
        }

        // 清单必须先退出可恢复列表；任何清单删除失败都会终止本轮对象 GC。
        snapshots.drop(keep).forEach { provider.delete(it.name) }

        val contentObjects = provider.listObjects().filter {
            logicalObjectName(it.name).startsWith("srl-chunk--sha256-") && it.name !in referenced
        }
        val markerKey = orphanMarkerKey(providerName)
        val markers = runCatching { JSONObject(preferences.getString(markerKey, "{}") ?: "{}") }
            .getOrDefault(JSONObject())
        val candidates = contentObjects.mapTo(mutableSetOf()) { it.name }
        markers.keys().asSequence().toList().filter { it !in candidates }.forEach(markers::remove)
        val now = clock()
        val eligible = mutableListOf<NativeCloudObject>()
        for (objectValue in contentObjects) {
            if (!markers.has(objectValue.name)) markers.put(objectValue.name, now)
            else if (markers.optLong(objectValue.name, now) <= now - ORPHAN_GRACE_MS) eligible += objectValue
        }
        check(preferences.edit().putString(markerKey, markers.toString()).commit()) { "无法持久化云备份 orphan 宽限状态" }
        for (objectValue in eligible) {
            provider.delete(objectValue.name)
            markers.remove(objectValue.name)
        }
        check(preferences.edit().putString(markerKey, markers.toString()).commit()) { "无法提交云备份 orphan 清理状态" }
        if (snapshots.size > keep || eligible.isNotEmpty()) {
            onProgress(NativeCloudProgress("已清理 ${snapshots.size - keep} 份旧快照清单与 ${eligible.size} 个过期孤儿对象"))
        }
    }

    private fun orphanMarkerKey(providerName: String): String {
        val scope = if (providerName == "github") {
            loadGitHubConfig()?.let { "${it.owner}/${it.repository}" }.orEmpty()
        } else {
            loadWebDavConfig()?.let { "${it.baseUrl.trimEnd('/')}/${it.folder.trim('/')}" }.orEmpty()
        }
        return "cloud-orphans-$providerName-${scope.hashCode()}"
    }

    private fun logicalObjectName(locator: String): String = locator.substringAfter("::", locator).substringAfterLast('/')

    private fun writeStorageLocators(snapshotFile: File, providerName: String, placements: Map<String, NativeCloudObject>) {
        val snapshot = NativeCloudSnapshotCodec.decode(snapshotFile)
        for (key in listOf("resources", "versions")) {
            val records = snapshot.getJSONArray(key)
            for (index in 0 until records.length()) {
                val parts = records.getJSONObject(index).getJSONObject("object").getJSONArray("parts")
                for (partIndex in 0 until parts.length()) {
                    val part = parts.getJSONObject(partIndex)
                    val logicalName = part.getString("name")
                    val locator = placements[logicalName]?.name ?: throw IllegalStateException("V3 清单缺少对象定位：$logicalName")
                    val storage = JSONObject()
                    if (providerName == "github") {
                        require(locator.contains("::")) { "GitHub V3 对象缺少 container 定位" }
                        storage.put("kind", "github-release").put("container", locator.substringBefore("::")).put("objectKey", locator.substringAfter("::"))
                    } else {
                        storage.put("kind", "koofr-path").put("container", "objects").put("objectKey", locator)
                    }
                    part.put("storage", storage)
                }
            }
        }
        GZIPOutputStream(BufferedOutputStream(FileOutputStream(snapshotFile), 128 * 1024)).use {
            it.write(snapshot.toString().toByteArray(Charsets.UTF_8))
        }
    }
}

private class CredentialAwareProvider(
    override val providerName: String,
    private val delegate: NativeObjectProvider,
    private val secrets: NativeSecretStore,
) : NativeObjectProvider {
    private inline fun <T> guard(block: () -> T): T = try {
        block()
    } catch (error: NativeCloudHttpException) {
        if (error.status == 401) secrets.invalidate(providerName)
        throw error
    }

    override fun test(): String = guard(delegate::test)
    override fun listObjects(): List<NativeCloudObject> = guard(delegate::listObjects)
    override fun upload(name: String, file: File, contentType: String): NativeCloudObject =
        guard { delegate.upload(name, file, contentType) }
    override fun download(name: String, destination: File): File =
        guard { delegate.download(name, destination) }
    override fun delete(name: String) = guard { delegate.delete(name) }
}
