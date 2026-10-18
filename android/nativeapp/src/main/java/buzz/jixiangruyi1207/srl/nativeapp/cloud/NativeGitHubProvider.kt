package buzz.jixiangruyi1207.srl.nativeapp.cloud

import android.net.Uri
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.time.Instant
import java.util.concurrent.TimeUnit

class NativeGitHubProvider(
    private val config: NativeGitHubConfig,
    private val token: String,
    private val client: OkHttpClient = defaultClient(),
    private val apiRoot: String = "https://api.github.com",
    private val uploadsRoot: String = "https://uploads.github.com",
    private val sleeper: (Long) -> Unit = Thread::sleep,
) : NativeObjectProvider {
    companion object {
        private const val LEGACY_RELEASE = "srl-cloud-backups"
        private const val SNAPSHOT_RELEASE = "srl-cloud-snapshots"
        private const val OBJECT_RELEASE_PREFIX = "srl-cloud-objects-"
        private const val OBJECT_CONTAINER_LIMIT = 900
        private fun defaultClient() = OkHttpClient.Builder().connectTimeout(45, TimeUnit.SECONDS)
            .readTimeout(10, TimeUnit.MINUTES).writeTimeout(10, TimeUnit.MINUTES).build()
    }
    override val providerName = "github"
    private val apiBase = "${apiRoot.trimEnd('/')}/repos/${Uri.encode(config.owner)}/${Uri.encode(config.repository)}"
    private val reservedByContainer = mutableMapOf<String, Int>()

    override fun test(): String {
        execute(request(apiBase).get().build()).use { response -> if (!response.isSuccessful) throw githubError("GitHub 仓库连接失败", response.code, response.body?.string(), response.headers["X-GitHub-Request-Id"]) }
        ensureRelease(SNAPSHOT_RELEASE); return "GitHub 仓库与 V3 快照容器连接成功"
    }

    override fun listObjects(): List<NativeCloudObject> {
        val results = mutableListOf<NativeCloudObject>()
        val releases = mutableListOf<Pair<String, Long>>()
        getRelease(LEGACY_RELEASE, false)?.let { releases += LEGACY_RELEASE to it.first }
        getRelease(SNAPSHOT_RELEASE, false)?.let { releases += SNAPSHOT_RELEASE to it.first }
        for (index in 1..10_000) {
            val tag = "$OBJECT_RELEASE_PREFIX${index.toString().padStart(4, '0')}"
            val release = getRelease(tag, false) ?: break
            releases += tag to release.first
        }
        for ((tag, releaseId) in releases) {
        var page = 1
        while (true) {
            val array = execute(request("$apiBase/releases/$releaseId/assets?per_page=100&page=$page").get().build()).use { response ->
                if (!response.isSuccessful) throw githubError("GitHub 资源列表读取失败", response.code, response.body?.string(), response.headers["X-GitHub-Request-Id"])
                JSONArray(response.body?.string() ?: "[]")
            }
            for (index in 0 until array.length()) {
                val item = array.getJSONObject(index)
                val name = item.getString("name")
                val locator = if (tag == LEGACY_RELEASE) name else "$tag::$name"
                results += NativeCloudObject(item.getLong("id").toString(), locator, item.getLong("size"), runCatching { Instant.parse(item.getString("created_at")).toEpochMilli() }.getOrDefault(0))
            }
            if (array.length() < 100) break
            page += 1
        }
        }
        return results
    }

    override fun upload(name: String, file: File, contentType: String): NativeCloudObject {
        val (tag, releaseId) = uploadContainer(name)
        val expectedHash = NativeCloudSnapshotCodec.sha256(file)
        var last: Exception? = null
        repeat(3) { attempt ->
            try {
                val url = "${uploadsRoot.trimEnd('/')}/repos/${Uri.encode(config.owner)}/${Uri.encode(config.repository)}/releases/$releaseId/assets?name=${Uri.encode(name)}"
                val body = file.asRequestBody(contentType.toMediaType())
                val uploaded = execute(request(url).post(body).build()).use { response ->
                    if (response.code == 422) {
                        val existing = listReleaseAssets(releaseId).find { it.name == name && it.size == file.length() }
                            ?: throw IllegalStateException("GitHub 同名对象已存在但大小不一致；拒绝覆盖 immutable 对象")
                        val confirmed = assetById(existing.id)
                        if (confirmed == null || !assetMatchesFile(confirmed, file, expectedHash)) {
                            val namedHash = Regex("^srl-chunk--sha256-([a-f0-9]{64})$", RegexOption.IGNORE_CASE)
                                .matchEntire(name)?.groupValues?.get(1)
                            if (namedHash?.equals(expectedHash, ignoreCase = true) != true) {
                                throw IllegalStateException("GitHub 已有同名对象摘要不符；拒绝删除 immutable 对象")
                            }
                            deleteById(existing.id)
                            throw IllegalStateException("GitHub 已有同名对象 SHA-256 不符；已删除校验失败的附件并重试")
                        }
                        return confirmed.copy(name = if (tag == LEGACY_RELEASE) name else "$tag::$name")
                    }
                    if (!response.isSuccessful) throw githubError("GitHub 资源上传失败", response.code, response.body?.string(), response.headers["X-GitHub-Request-Id"])
                    JSONObject(response.body?.string() ?: "{}")
                }
                val id = uploaded.getLong("id").toString()
                repeat(4) { poll ->
                    val confirmed = assetById(id)
                    if (confirmed != null && assetMatchesFile(confirmed, file, expectedHash))
                        return confirmed.copy(name = if (tag == LEGACY_RELEASE) name else "$tag::$name")
                    val remoteDigest = confirmed?.digest?.let(::parseSha256Digest)
                    if (remoteDigest != null && !remoteDigest.equals(expectedHash, ignoreCase = true)) {
                        deleteById(id)
                        throw IllegalStateException("GitHub 上传对象 SHA-256 不符；已删除校验失败的附件")
                    }
                    if (poll < 3) sleeper((poll + 1) * 600L)
                }
                deleteById(id)
                throw IllegalStateException("GitHub 已接收资源，但远端大小连续确认失败")
            } catch (error: Exception) {
                last = error
                if (attempt < 2) sleeper((attempt + 1) * 800L)
            }
        }
        throw IllegalStateException("GitHub 对象连续 3 次上传不完整；未提交快照清单", last)
    }

    override fun download(name: String, destination: File): File {
        val asset = listObjects().find { it.name == name } ?: throw IllegalArgumentException("GitHub 备份对象不存在：$name")
        val downloadRequest = request("$apiBase/releases/assets/${asset.id}").header("Accept", "application/octet-stream").get().build()
        execute(downloadRequest).use { response ->
            if (!response.isSuccessful) throw githubError("GitHub 对象下载失败", response.code, response.body?.string(), response.headers["X-GitHub-Request-Id"])
            val body = response.body ?: throw IllegalStateException("GitHub 下载响应为空")
            body.byteStream().buffered(128 * 1024).use { input -> FileOutputStream(destination).buffered(128 * 1024).use { input.copyTo(it, 128 * 1024) } }
        }
        return destination
    }

    override fun delete(name: String) { listObjects().find { it.name == name }?.let { deleteById(it.id) } }

    private fun deleteById(id: String) {
        execute(request("$apiBase/releases/assets/$id").delete().build()).use { response ->
            if (response.code != 404 && !response.isSuccessful) throw githubError("GitHub 资源删除失败", response.code, response.body?.string(), response.headers["X-GitHub-Request-Id"])
        }
    }

    @Synchronized
    private fun ensureRelease(tag: String): Long = getRelease(tag, false)?.first ?: run {
        val json = JSONObject().put("tag_name", tag).put("name", tag).put("draft", false).put("prerelease", true)
        execute(request("$apiBase/releases").post(json.toString().toRequestBody("application/json".toMediaType())).build()).use { response ->
            if (!response.isSuccessful) throw githubError("GitHub 备份 Release 创建失败", response.code, response.body?.string(), response.headers["X-GitHub-Request-Id"])
            JSONObject(response.body?.string() ?: "{}").getLong("id")
        }
    }

    private fun assetById(id: String): NativeCloudObject? {
        execute(request("$apiBase/releases/assets/$id").get().build()).use { response ->
            if (response.code == 404) return null
            if (!response.isSuccessful) throw githubError("GitHub 资源状态读取失败", response.code, response.body?.string(), response.headers["X-GitHub-Request-Id"])
            val item = JSONObject(response.body?.string() ?: "{}")
            return NativeCloudObject(
                item.getLong("id").toString(), item.getString("name"), item.getLong("size"),
                runCatching { Instant.parse(item.getString("created_at")).toEpochMilli() }.getOrDefault(0),
                item.optString("digest").takeIf(String::isNotBlank),
            )
        }
    }

    private fun assetMatchesFile(asset: NativeCloudObject, file: File, expectedHash: String): Boolean {
        if (asset.size != file.length()) return false
        val remoteDigest = asset.digest?.let(::parseSha256Digest)
        if (remoteDigest != null) return remoteDigest.equals(expectedHash, ignoreCase = true)
        val request = request("$apiBase/releases/assets/${asset.id}")
            .header("Accept", "application/octet-stream").get().build()
        val digest = java.security.MessageDigest.getInstance("SHA-256")
        var received = 0L
        execute(request).use { response ->
            if (!response.isSuccessful) throw githubError("GitHub 对象摘要读取失败", response.code, response.body?.string(), response.headers["X-GitHub-Request-Id"])
            val body = response.body ?: throw IllegalStateException("GitHub 对象摘要响应为空")
            body.byteStream().buffered(128 * 1024).use { input ->
                val buffer = ByteArray(128 * 1024)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    received += count
                    digest.update(buffer, 0, count)
                }
            }
        }
        val actualHash = digest.digest().joinToString("") { "%02x".format(it) }
        return received == asset.size && actualHash.equals(expectedHash, ignoreCase = true)
    }

    private fun parseSha256Digest(value: String): String? =
        Regex("^sha256:([a-f0-9]{64})$", RegexOption.IGNORE_CASE).matchEntire(value)?.groupValues?.get(1)

    private fun getRelease(tag: String, required: Boolean): Pair<Long, JSONObject>? {
        execute(request("$apiBase/releases/tags/${Uri.encode(tag)}").get().build()).use { response ->
            if (response.code == 404 && !required) return null
            if (!response.isSuccessful) throw githubError("GitHub 备份 Release 读取失败", response.code, response.body?.string(), response.headers["X-GitHub-Request-Id"])
            val json = JSONObject(response.body?.string() ?: "{}")
            return json.getLong("id") to json
        }
    }

    @Synchronized
    private fun uploadContainer(name: String): Pair<String, Long> {
        if (name.endsWith(".srlmanifest.v3.json.gz", true) || name.endsWith(".srlmanifest.v3.json", true)) {
            return SNAPSHOT_RELEASE to ensureRelease(SNAPSHOT_RELEASE)
        }
        if (!name.startsWith("srl-chunk--sha256-")) return LEGACY_RELEASE to ensureRelease(LEGACY_RELEASE)
        for (index in 1..10_000) {
            val tag = "$OBJECT_RELEASE_PREFIX${index.toString().padStart(4, '0')}"
            val release = getRelease(tag, false)
            if (release == null) {
                reservedByContainer[tag] = 1
                return tag to ensureRelease(tag)
            }
            val count = listReleaseAssets(release.first).size
            val reserved = reservedByContainer[tag] ?: 0
            if (count + reserved < OBJECT_CONTAINER_LIMIT) {
                reservedByContainer[tag] = reserved + 1
                return tag to release.first
            }
        }
        throw IllegalStateException("GitHub 对象容器数量超过安全上限")
    }

    private fun listReleaseAssets(releaseId: Long): List<NativeCloudObject> {
        val result = mutableListOf<NativeCloudObject>()
        var page = 1
        while (true) {
            val array = execute(request("$apiBase/releases/$releaseId/assets?per_page=100&page=$page").get().build()).use { response ->
                if (!response.isSuccessful) throw githubError("GitHub 资源列表读取失败", response.code, response.body?.string(), response.headers["X-GitHub-Request-Id"])
                JSONArray(response.body?.string() ?: "[]")
            }
            for (index in 0 until array.length()) {
                val item = array.getJSONObject(index)
                result += NativeCloudObject(item.getLong("id").toString(), item.getString("name"), item.getLong("size"), 0)
            }
            if (array.length() < 100) break
            page += 1
        }
        return result
    }

    private fun request(url: String): Request.Builder = Request.Builder().url(url).header("Authorization", "Bearer $token")
        .header("Accept", "application/vnd.github+json").header("X-GitHub-Api-Version", "2022-11-28").header("User-Agent", "SRL-Native-Android/0.0.5")
    private fun execute(request: Request) = client.newCall(request).execute()
    private fun githubError(prefix: String, status: Int, body: String?, requestId: String?): Exception {
        val message = runCatching { JSONObject(body ?: "{}").optString("message") }.getOrDefault("")
        val hint = if (status == 403) "；请检查令牌 Contents: Read and write、仓库授权、有效期及组织 SSO" else ""
        return NativeCloudHttpException(status, "$prefix（$status）${message.takeIf(String::isNotBlank)?.let { "：$it" } ?: ""}$hint${requestId?.let { "；请求编号 $it" } ?: ""}")
    }

}
