package buzz.jixiangruyi1207.srl.nativeapp

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import buzz.jixiangruyi1207.srl.nativeapp.cloud.NativeCloudBackupService
import buzz.jixiangruyi1207.srl.nativeapp.cloud.NativeCloudBackup
import buzz.jixiangruyi1207.srl.nativeapp.cloud.NativeCloudObject
import buzz.jixiangruyi1207.srl.nativeapp.cloud.NativeCloudSnapshotCodec
import buzz.jixiangruyi1207.srl.nativeapp.cloud.NativeCloudHttpException
import buzz.jixiangruyi1207.srl.nativeapp.cloud.NativeCredentialState
import buzz.jixiangruyi1207.srl.nativeapp.cloud.NativeSecretStore
import buzz.jixiangruyi1207.srl.nativeapp.cloud.NativeStructuredSnapshotBuilder
import buzz.jixiangruyi1207.srl.nativeapp.cloud.NativeGitHubConfig
import buzz.jixiangruyi1207.srl.nativeapp.cloud.NativeGitHubProvider
import buzz.jixiangruyi1207.srl.nativeapp.cloud.NativeObjectProvider
import buzz.jixiangruyi1207.srl.nativeapp.cloud.NativeWebDavConfig
import buzz.jixiangruyi1207.srl.nativeapp.cloud.NativeWebDavProvider
import buzz.jixiangruyi1207.srl.nativeapp.data.NativeResourceStore
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import java.io.BufferedOutputStream
import java.io.FileOutputStream
import java.util.zip.GZIPOutputStream

@RunWith(AndroidJUnit4::class)
class NativeCloudTransferTest {
    @Test
    fun failedAutomaticBackupIsNotScheduledAgainOnEveryForegroundResume() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val secrets = NativeSecretStore(context)
        val preferences = context.getSharedPreferences("srl-native-cloud-config", android.content.Context.MODE_PRIVATE)
        val previousConfig = preferences.getString("github", null)
        val previousAttempt = preferences.getLong("lastAttempt-github", Long.MIN_VALUE)
        val previousSecret = secrets.read("github")
        NativeResourceStore(context).use { store ->
            val service = NativeCloudBackupService(context, store)
            val config = NativeGitHubConfig(
                owner = "owner",
                repository = "backups",
                retention = 7,
                autoBackup = true,
                wifiOnly = false,
                chargingOnly = false,
            )
            secrets.save("github", "fixture-token")
            try {
                service.saveGitHub(config, null)
                val attemptedAt = System.currentTimeMillis()
                assertTrue(service.automaticProvidersDue(true, true, attemptedAt).contains("github"))

                service.recordBackupAttempt("github", attemptedAt)
                assertFalse(service.automaticProvidersDue(true, true, attemptedAt + 1_000).contains("github"))
                assertFalse(service.automaticProvidersDue(true, true, attemptedAt + 23L * 60 * 60 * 1000).contains("github"))
                assertTrue(service.automaticProvidersDue(true, true, attemptedAt + 24L * 60 * 60 * 1000).contains("github"))
            } finally {
                if (previousSecret == null) secrets.clear("github") else secrets.save("github", previousSecret)
                preferences.edit().apply {
                    if (previousConfig == null) remove("github") else putString("github", previousConfig)
                    if (previousAttempt == Long.MIN_VALUE) remove("lastAttempt-github") else putLong("lastAttempt-github", previousAttempt)
                }.apply()
            }
        }
    }

    @Test
    fun credentialReplacementIsDurableAndOnlyConfirmed401InvalidatesIt() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val providerName = "credential-${UUID.randomUUID()}"
        val secrets = NativeSecretStore(context)
        try {
            secrets.save(providerName, "old-secret")
            assertEquals(NativeCredentialState.VALID, secrets.state(providerName))

            NativeResourceStore(context).use { store ->
                val forbidden = NativeCloudBackupService(context, store) {
                    object : NativeObjectProvider {
                        override val providerName = providerName
                        override fun test(): String = throw NativeCloudHttpException(403, "forbidden")
                        override fun listObjects() = emptyList<NativeCloudObject>()
                        override fun upload(name: String, file: File, contentType: String) = throw UnsupportedOperationException()
                        override fun download(name: String, destination: File) = throw UnsupportedOperationException()
                        override fun delete(name: String) = Unit
                    }
                }
                runCatching { forbidden.test(providerName) }
                assertEquals(NativeCredentialState.VALID, secrets.state(providerName))

                val unauthorized = NativeCloudBackupService(context, store) {
                    object : NativeObjectProvider {
                        override val providerName = providerName
                        override fun test(): String = throw NativeCloudHttpException(401, "unauthorized")
                        override fun listObjects() = emptyList<NativeCloudObject>()
                        override fun upload(name: String, file: File, contentType: String) = throw UnsupportedOperationException()
                        override fun download(name: String, destination: File) = throw UnsupportedOperationException()
                        override fun delete(name: String) = Unit
                    }
                }
                runCatching { unauthorized.test(providerName) }
                assertEquals(NativeCredentialState.INVALID, secrets.state(providerName))
                assertEquals(null, secrets.read(providerName))
            }

            secrets.save(providerName, "new-secret")
            assertEquals(NativeCredentialState.VALID, secrets.state(providerName))
            assertEquals("new-secret", secrets.read(providerName))
        } finally {
            secrets.clear(providerName)
        }
    }

    @Test
    fun realGithubRestoresWebSnapshotThenUploadsAndRestoresNativeSnapshot() {
        val arguments = InstrumentationRegistry.getArguments()
        val token = arguments.getString("githubToken").orEmpty()
        val owner = arguments.getString("githubOwner").orEmpty()
        val repository = arguments.getString("githubRepository").orEmpty()
        val webMarker = arguments.getString("webMarker").orEmpty()
        val nativeMarker = arguments.getString("nativeMarker").orEmpty()
        assumeTrue(
            "Real GitHub credentials and markers are required",
            token.isNotBlank() && owner.isNotBlank() && repository.isNotBlank() &&
                webMarker.isNotBlank() && nativeMarker.isNotBlank(),
        )

        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val input = File(context.cacheDir, "real-native-cloud-${UUID.randomUUID()}.json").apply {
            writeText(nativeMarker)
        }
        NativeResourceStore(context).use { store ->
            val service = NativeCloudBackupService(context, store)
            service.saveGitHub(
                NativeGitHubConfig(owner, repository, retention = 7, autoBackup = false, wifiOnly = false),
                token,
            )

            val webBackup = service.listBackups("github").first()
            val webRestore = service.restoreBackup(webBackup, replace = false) {}
            assertEquals(1, webRestore.first)
            assertTrue(store.loadResources().any { resource ->
                resource.name == webMarker || resource.fileName == "$webMarker.json"
            })

            val existingIds = store.loadResources().mapTo(mutableSetOf()) { it.id }
            store.importUris(listOf(android.net.Uri.fromFile(input)))
            val nativeResource = store.loadResources().first { it.id !in existingIds }
            val nativeBackup = service.createBackup("github") {}
            store.deleteResource(nativeResource.id)
            val nativeRestore = service.restoreBackup(nativeBackup, replace = false) {}
            assertTrue(nativeRestore.first >= 1)
            assertTrue(store.loadResources().any { it.contentHash == nativeResource.contentHash })
        }
        input.delete()
    }

    @Test
    fun unchangedSecondBackupUploadsOnlySnapshotManifestAndCommitsItLast() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val input = File(context.cacheDir, "cloud-source-${UUID.randomUUID()}.json").apply { writeText("{\"name\":\"云备份去重-${UUID.randomUUID()}\"}") }
        val provider = MemoryProvider(context.cacheDir)
        NativeResourceStore(context).use { store ->
            store.importUris(listOf(android.net.Uri.fromFile(input)))
            val service = NativeCloudBackupService(context, store) { provider }
            service.createBackup("memory") {}
            assertTrue("快照清单必须最后提交", provider.uploaded.last().endsWith(".srlmanifest.v3.json.gz"))
            val before = provider.uploaded.size
            service.createBackup("memory") {}
            val second = provider.uploaded.drop(before)
            assertEquals("完全相同的资源不得重复上传内容块", 1, second.size)
            assertTrue(second.single().endsWith(".srlmanifest.v3.json.gz"))
        }
        input.delete()
        provider.close()
    }

    @Test
    fun retentionStartsOrphanGraceAfterManifestDeletionAndDeletesOnlyOnALaterRun() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val scope = "retention-${UUID.randomUUID()}"
        context.getSharedPreferences("srl-native-cloud-config", android.content.Context.MODE_PRIVATE)
            .edit().putString(
                "webdav",
                org.json.JSONObject()
                    .put("baseUrl", "https://example.test/dav")
                    .put("folder", scope)
                    .put("username", "user")
                    .put("retention", 1)
                    .toString(),
            ).commit()
        var now = 1_000L
        val provider = MemoryProvider(context.cacheDir, "webdav")
        val firstInput = File(context.cacheDir, "cloud-first-${UUID.randomUUID()}.json").apply {
            writeText("{\"name\":\"first-${UUID.randomUUID()}\"}")
        }
        val secondInput = File(context.cacheDir, "cloud-second-${UUID.randomUUID()}.json").apply {
            writeText("{\"name\":\"second-${UUID.randomUUID()}\"}")
        }
        NativeResourceStore(context).use { store ->
            val existingIds = store.loadResources().mapTo(mutableSetOf()) { it.id }
            store.importUris(listOf(android.net.Uri.fromFile(firstInput)))
            val firstResource = store.loadResources().first { it.id !in existingIds }
            val service = NativeCloudBackupService(context, store, clock = { now }) { provider }
            service.createBackup("webdav") {}
            val firstChunk = "srl-chunk--sha256-${firstResource.contentHash}"

            store.deleteResource(firstResource.id)
            store.importUris(listOf(android.net.Uri.fromFile(secondInput)))
            Thread.sleep(5)
            service.createBackup("webdav") {}
            assertTrue("刚成为 orphan 的旧对象必须保留宽限期", provider.listObjects().any { it.name == firstChunk })

            now += 24L * 60L * 60L * 1000L
            Thread.sleep(5)
            service.createBackup("webdav") {}
            assertTrue("宽限期后的未引用对象应被清理", provider.listObjects().none { it.name == firstChunk })
            store.loadResources().filter { it.id !in existingIds }.forEach { store.deleteResource(it.id) }
        }
        firstInput.delete()
        secondInput.delete()
        provider.close()
    }

    @Test
    fun v3SnapshotRestoreStreamsObjectsIntoNativeStoreWithoutBuildingAnArchive() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val marker = "云恢复-${UUID.randomUUID()}"
        val input = File(context.cacheDir, "cloud-restore-${UUID.randomUUID()}.json").apply {
            writeText("{\"name\":\"$marker\"}")
        }
        val provider = MemoryProvider(context.cacheDir)
        NativeResourceStore(context).use { store ->
            store.importUris(listOf(android.net.Uri.fromFile(input)))
            val original = store.loadResources().first { it.name == marker }
            val service = NativeCloudBackupService(context, store) { provider }
            val backup = service.createBackup("memory") {}
            store.deleteResource(original.id)

            val restored = service.restoreBackup(backup, replace = false) {}

            assertEquals(1, restored.first)
            assertTrue(store.loadResources().any { it.contentHash == original.contentHash })
        }
        input.delete()
        provider.close()
    }

    @Test
    fun webGithubV3StorageLocatorRestoresInNativeApp() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val marker = "Web-GitHub-交叉恢复-${UUID.randomUUID()}"
        val input = File(context.cacheDir, "web-cross-${UUID.randomUUID()}.json").apply {
            writeText("{\"name\":\"$marker\"}")
        }
        val provider = MemoryProvider(context.cacheDir, "github")
        NativeResourceStore(context).use { store ->
            store.importUris(listOf(android.net.Uri.fromFile(input)))
            val original = store.loadResources().first { it.name == marker }
            val built = NativeStructuredSnapshotBuilder(context).build(
                store.loadCloudSources(),
                store.cloudCategoriesJson(),
                store.portableDataJson(),
            )
            try {
                val snapshot = NativeCloudSnapshotCodec.decode(built.snapshotFile)
                for (key in listOf("resources", "versions")) {
                    val records = snapshot.getJSONArray(key)
                    for (index in 0 until records.length()) {
                        val parts = records.getJSONObject(index).getJSONObject("object").getJSONArray("parts")
                        for (partIndex in 0 until parts.length()) {
                            val part = parts.getJSONObject(partIndex)
                            part.put(
                                "storage",
                                org.json.JSONObject()
                                    .put("kind", "github-release")
                                    .put("container", "srl-cloud-objects-0001")
                                    .put("objectKey", part.getString("name")),
                            )
                        }
                    }
                }
                GZIPOutputStream(BufferedOutputStream(FileOutputStream(built.snapshotFile))).use {
                    it.write(snapshot.toString().toByteArray(Charsets.UTF_8))
                }
                built.chunks.forEach { (name, file) ->
                    provider.put("srl-cloud-objects-0001::$name", file)
                }
                provider.put(built.objectKey, built.snapshotFile)
                store.deleteResource(original.id)

                val service = NativeCloudBackupService(context, store) { provider }
                val restored = service.restoreBackup(
                    NativeCloudBackup(
                        built.objectKey,
                        built.objectKey,
                        built.totalSize,
                        System.currentTimeMillis(),
                        built.chunks.size,
                        "github",
                        legacy = false,
                        kind = "snapshot",
                    ),
                    replace = false,
                ) {}

                assertEquals(1, restored.first)
                assertTrue(store.loadResources().any { it.contentHash == original.contentHash })
            } finally {
                built.buildDirectory.deleteRecursively()
            }
        }
        input.delete()
        provider.close()
    }

    @Test
    fun webDavUploadConfirmsWithOneByteRangeBeforeHeadOrListing() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(405))
        server.enqueue(MockResponse().setResponseCode(405))
        server.enqueue(MockResponse().setResponseCode(405))
        server.enqueue(MockResponse().setResponseCode(201))
        server.enqueue(MockResponse().setResponseCode(206).addHeader("Content-Range", "bytes 0-0/3").setBody("a"))
        server.start()
        try {
            val file = File.createTempFile("webdav", ".bin").apply { writeBytes(byteArrayOf(1, 2, 3)) }
            val provider = NativeWebDavProvider(NativeWebDavConfig(server.url("/").toString(), "backup", "user"), "secret", sleeper = {})
            provider.upload("chunk", file, "application/octet-stream")
            assertEquals("MKCOL", server.takeRequest().method)
            assertEquals("MKCOL", server.takeRequest().method)
            assertEquals("MKCOL", server.takeRequest().method)
            assertEquals("PUT", server.takeRequest().method)
            val confirmation = server.takeRequest()
            assertEquals("GET", confirmation.method)
            assertEquals("bytes=0-0", confirmation.getHeader("Range"))
            assertEquals(5, server.requestCount)
            file.delete()
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun githubIncompleteAssetUsesFourDirectPollsAndOnlyThreeOuterUploads() {
        val server = MockWebServer()
        val uploads = AtomicInteger(0)
        val polls = AtomicInteger(0)
        val deletes = AtomicInteger(0)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path.orEmpty()
                return when {
                    path.endsWith("/releases/tags/srl-cloud-backups") -> MockResponse().setResponseCode(200).setBody("{\"id\":1}")
                    request.method == "POST" && path.contains("/releases/1/assets?") -> {
                        val id = uploads.incrementAndGet()
                        MockResponse().setResponseCode(201).setBody("{\"id\":$id}")
                    }
                    request.method == "GET" && path.contains("/releases/assets/") -> {
                        val id = path.substringAfterLast('/').toInt()
                        polls.incrementAndGet()
                        MockResponse().setResponseCode(200).setBody("{\"id\":$id,\"name\":\"chunk\",\"size\":1,\"created_at\":\"2026-08-11T00:00:00Z\"}")
                    }
                    request.method == "DELETE" && path.contains("/releases/assets/") -> {
                        deletes.incrementAndGet(); MockResponse().setResponseCode(204)
                    }
                    else -> MockResponse().setResponseCode(500).setBody("unexpected $path")
                }
            }
        }
        server.start()
        try {
            val file = File.createTempFile("github", ".bin").apply { writeBytes(byteArrayOf(1, 2, 3)) }
            val provider = NativeGitHubProvider(
                NativeGitHubConfig("owner", "repo"), "token", apiRoot = server.url("/").toString(), uploadsRoot = server.url("/").toString(), sleeper = {},
            )
            val error = runCatching { provider.upload("chunk", file, "application/octet-stream") }.exceptionOrNull()
            assertTrue(error?.message?.contains("连续 3 次上传不完整") == true)
            assertEquals(3, uploads.get())
            assertEquals(12, polls.get())
            assertEquals(3, deletes.get())
            file.delete()
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun githubAmbiguousUploadReusesTheVerifiedExistingAssetInsteadOfRestartingTheObject() {
        val server = MockWebServer()
        val uploads = AtomicInteger(0)
        val deletes = AtomicInteger(0)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path.orEmpty()
                return when {
                    path.endsWith("/releases/tags/srl-cloud-backups") -> MockResponse().setResponseCode(200).setBody("{\"id\":1}")
                    request.method == "POST" && path.contains("/releases/1/assets?") -> {
                        uploads.incrementAndGet(); MockResponse().setResponseCode(422).setBody("{\"message\":\"already_exists\"}")
                    }
                    request.method == "GET" && path.contains("/releases/1/assets?") -> MockResponse().setResponseCode(200)
                        .setBody("[{\"id\":77,\"name\":\"chunk\",\"size\":3,\"created_at\":\"2026-08-26T00:00:00Z\"}]")
                    request.method == "GET" && path.endsWith("/releases/assets/77") -> MockResponse().setResponseCode(200)
                        .setBody("{\"id\":77,\"name\":\"chunk\",\"size\":3,\"digest\":\"sha256:039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81\",\"created_at\":\"2026-08-26T00:00:00Z\"}")
                    request.method == "DELETE" -> { deletes.incrementAndGet(); MockResponse().setResponseCode(204) }
                    else -> MockResponse().setResponseCode(500).setBody("unexpected $path")
                }
            }
        }
        server.start()
        try {
            val file = File.createTempFile("github-existing", ".bin").apply { writeBytes(byteArrayOf(1, 2, 3)) }
            val provider = NativeGitHubProvider(
                NativeGitHubConfig("owner", "repo"), "token", apiRoot = server.url("/").toString(), uploadsRoot = server.url("/").toString(), sleeper = {},
            )

            val uploaded = provider.upload("chunk", file, "application/octet-stream")

            assertEquals("77", uploaded.id)
            assertEquals(1, uploads.get())
            assertEquals(0, deletes.get())
            file.delete()
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun githubSameSizeWrongDigestIsDeletedBeforeContentAddressedRetry() {
        val server = MockWebServer()
        val uploads = AtomicInteger(0)
        val deletes = AtomicInteger(0)
        val expectedHash = "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81"
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path.orEmpty()
                return when {
                    path.endsWith("/releases/tags/srl-cloud-objects-0001") -> MockResponse().setResponseCode(200).setBody("{\"id\":1}")
                    request.method == "GET" && path.contains("/releases/1/assets?") -> MockResponse().setResponseCode(200)
                        .setBody("[{\"id\":77,\"name\":\"srl-chunk--sha256-$expectedHash\",\"size\":3}]")
                    request.method == "POST" && path.contains("/releases/1/assets?") -> {
                        if (uploads.incrementAndGet() == 1) MockResponse().setResponseCode(422).setBody("{\"message\":\"already_exists\"}")
                        else MockResponse().setResponseCode(201).setBody("{\"id\":88}")
                    }
                    request.method == "GET" && path.endsWith("/releases/assets/77") -> MockResponse().setResponseCode(200)
                        .setBody("{\"id\":77,\"name\":\"srl-chunk--sha256-$expectedHash\",\"size\":3,\"digest\":\"sha256:${"b".repeat(64)}\",\"created_at\":\"2026-08-26T00:00:00Z\"}")
                    request.method == "GET" && path.endsWith("/releases/assets/88") -> MockResponse().setResponseCode(200)
                        .setBody("{\"id\":88,\"name\":\"srl-chunk--sha256-$expectedHash\",\"size\":3,\"digest\":\"sha256:$expectedHash\",\"created_at\":\"2026-08-26T00:00:00Z\"}")
                    request.method == "DELETE" -> { deletes.incrementAndGet(); MockResponse().setResponseCode(204) }
                    else -> MockResponse().setResponseCode(500).setBody("unexpected $path")
                }
            }
        }
        server.start()
        try {
            val file = File.createTempFile("github-same-size-corrupt", ".bin").apply { writeBytes(byteArrayOf(1, 2, 3)) }
            val provider = NativeGitHubProvider(
                NativeGitHubConfig("owner", "repo"), "token", apiRoot = server.url("/").toString(), uploadsRoot = server.url("/").toString(), sleeper = {},
            )

            val uploaded = provider.upload("srl-chunk--sha256-$expectedHash", file, "application/octet-stream")

            assertEquals("88", uploaded.id)
            assertEquals(2, uploads.get())
            assertEquals(1, deletes.get())
            file.delete()
        } finally {
            server.shutdown()
        }
    }

    private class MemoryProvider(
        private val cache: File,
        override val providerName: String = "memory",
    ) : NativeObjectProvider {
        private val objects = ConcurrentHashMap<String, File>()
        val uploaded = CopyOnWriteArrayList<String>()
        override fun test() = "ok"
        override fun listObjects(): List<NativeCloudObject> = objects.map { (name, file) -> NativeCloudObject(name, name, file.length(), file.lastModified()) }
        override fun upload(name: String, file: File, contentType: String): NativeCloudObject {
            val stored = File(cache, "memory-cloud-${UUID.randomUUID()}")
            file.copyTo(stored, overwrite = true)
            objects.put(name, stored)?.delete()
            uploaded += name
            return NativeCloudObject(name, name, stored.length(), System.currentTimeMillis())
        }
        override fun download(name: String, destination: File): File = objects.getValue(name).copyTo(destination, overwrite = true)
        override fun delete(name: String) { objects.remove(name)?.delete() }
        fun put(name: String, source: File) {
            val stored = File(cache, "memory-cloud-${UUID.randomUUID()}")
            source.copyTo(stored, overwrite = true)
            objects.put(name, stored)?.delete()
        }
        fun close() { objects.values.forEach(File::delete); objects.clear() }
    }
}
