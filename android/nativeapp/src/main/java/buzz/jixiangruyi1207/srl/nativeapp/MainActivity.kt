package buzz.jixiangruyi1207.srl.nativeapp

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.BatteryManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import buzz.jixiangruyi1207.srl.nativeapp.data.NativeResourceStore
import buzz.jixiangruyi1207.srl.nativeapp.cloud.NativeCloudBackup
import buzz.jixiangruyi1207.srl.nativeapp.cloud.NativeCloudBackupService
import buzz.jixiangruyi1207.srl.nativeapp.cloud.NativeCredentialState
import buzz.jixiangruyi1207.srl.nativeapp.cloud.NativeGitHubConfig
import buzz.jixiangruyi1207.srl.nativeapp.cloud.NativeWebDavConfig
import buzz.jixiangruyi1207.srl.nativeapp.model.NativeCategory
import buzz.jixiangruyi1207.srl.nativeapp.model.NativeResource
import buzz.jixiangruyi1207.srl.nativeapp.model.NativeBackupSelection
import buzz.jixiangruyi1207.srl.nativeapp.model.NativeResourceBundle
import buzz.jixiangruyi1207.srl.nativeapp.ui.NativeSrlApp
import buzz.jixiangruyi1207.srl.nativeapp.tavern.NativeTavernBridgeService
import buzz.jixiangruyi1207.srl.nativeapp.tavern.NativeTavernBridgeState
import buzz.jixiangruyi1207.srl.nativeapp.tavern.NativeTavernResourceItem
import buzz.jixiangruyi1207.srl.nativeapp.persona.NativePersonaBackup
import buzz.jixiangruyi1207.srl.nativeapp.persona.NativePersonaEntry
import buzz.jixiangruyi1207.srl.nativeapp.persona.NativeUserPersonaService
import buzz.jixiangruyi1207.srl.nativeapp.preset.NativePresetSegment
import buzz.jixiangruyi1207.srl.nativeapp.preset.NativePresetStitchService
import buzz.jixiangruyi1207.srl.nativeapp.preset.NativeStitchRequest
import buzz.jixiangruyi1207.srl.nativeapp.workshop.NativeFrontendWorkshopService
import buzz.jixiangruyi1207.srl.nativeapp.draw.NativeCharacterDrawService
import buzz.jixiangruyi1207.srl.nativeapp.draw.NativeDrawOptions
import buzz.jixiangruyi1207.srl.nativeapp.draw.NativeDrawState
import buzz.jixiangruyi1207.srl.nativeapp.appearance.NativeAppearanceService
import buzz.jixiangruyi1207.srl.nativeapp.appearance.NativeAppearanceState
import buzz.jixiangruyi1207.srl.nativeapp.cabinet.NativeCabinetService
import buzz.jixiangruyi1207.srl.nativeapp.cabinet.NativeCabinetState
import buzz.jixiangruyi1207.srl.nativeapp.extensions.NativeExternalPackage
import buzz.jixiangruyi1207.srl.nativeapp.extensions.NativeExternalPackageService
import buzz.jixiangruyi1207.srl.nativeapp.cloud.NativeSecretStore
import buzz.jixiangruyi1207.srl.nativeapp.tagging.NativeAiConfig
import buzz.jixiangruyi1207.srl.nativeapp.tagging.NativeAiDraft
import buzz.jixiangruyi1207.srl.nativeapp.tagging.NativeAiReviewItem
import buzz.jixiangruyi1207.srl.nativeapp.tagging.NativeAiState
import buzz.jixiangruyi1207.srl.nativeapp.tagging.NativeAiTaggingService
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.io.File
import java.util.concurrent.Executors

class MainActivity : ComponentActivity() {
    private val worker = Executors.newSingleThreadExecutor()
    private lateinit var store: NativeResourceStore
    private lateinit var cloudService: NativeCloudBackupService
    private lateinit var tavernBridge: NativeTavernBridgeService
    private lateinit var personaService: NativeUserPersonaService
    private lateinit var presetStitchService: NativePresetStitchService
    private lateinit var frontendWorkshopService: NativeFrontendWorkshopService
    private lateinit var characterDrawService: NativeCharacterDrawService
    private lateinit var appearanceService: NativeAppearanceService
    private lateinit var cabinetService: NativeCabinetService
    private lateinit var externalPackageService: NativeExternalPackageService
    private lateinit var aiTaggingService: NativeAiTaggingService
    private var resources by mutableStateOf<List<NativeResource>>(emptyList())
    private var categories by mutableStateOf<List<NativeCategory>>(emptyList())
    private var versions by mutableStateOf<List<NativeResource>>(emptyList())
    private var cloudBackups by mutableStateOf<List<NativeCloudBackup>>(emptyList())
    private var githubConfig by mutableStateOf<NativeGitHubConfig?>(null)
    private var webDavConfig by mutableStateOf<NativeWebDavConfig?>(null)
    private var githubCredentialState by mutableStateOf(NativeCredentialState.MISSING)
    private var webDavCredentialState by mutableStateOf(NativeCredentialState.MISSING)
    private var tavernBridgeState by mutableStateOf(NativeTavernBridgeState())
    private var tavernResources by mutableStateOf<List<NativeTavernResourceItem>>(emptyList())
    private var personaBackup by mutableStateOf<NativePersonaBackup?>(null)
    private var presetSegments by mutableStateOf<Map<String, List<NativePresetSegment>>>(emptyMap())
    private var resourceBundles by mutableStateOf<List<NativeResourceBundle>>(emptyList())
    private var workshopOutputIds by mutableStateOf<List<String>>(emptyList())
    private var drawState by mutableStateOf(NativeDrawState())
    private var drawResultIds by mutableStateOf<List<String>>(emptyList())
    private var appearanceState by mutableStateOf(NativeAppearanceState())
    private var cabinetState by mutableStateOf(NativeCabinetState())
    private var externalPackages by mutableStateOf<List<NativeExternalPackage>>(emptyList())
    private var aiTaggingState by mutableStateOf(NativeAiState(NativeAiConfig(), null, emptyList()))
    private var legacyLibraryHistory by mutableStateOf(buzz.jixiangruyi1207.srl.nativeapp.model.LegacyLibraryHistoryCleanup())
    private var busy by mutableStateOf(false)
    private var message by mutableStateOf("原生本地库已就绪")
    private var pendingExportSelection = NativeBackupSelection()
    private var pendingPersonaExportId: String? = null
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            maybeRunAutomaticCloudBackup()
        }
    }

    private val filePicker = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isNotEmpty()) importUris(uris)
    }

    private val archiveCreator = registerForActivityResult(
        ActivityResultContracts.CreateDocument("application/zip"),
    ) { uri ->
        if (uri != null) exportArchive(uri)
    }

    private val personaCreator = registerForActivityResult(
        ActivityResultContracts.CreateDocument("application/json"),
    ) { uri ->
        val resourceId = pendingPersonaExportId.also { pendingPersonaExportId = null }
        if (uri != null && resourceId != null) exportPersona(resourceId, uri)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = NativeResourceStore(applicationContext)
        cloudService = NativeCloudBackupService(applicationContext, store)
        personaService = NativeUserPersonaService(store)
        presetStitchService = NativePresetStitchService(store)
        frontendWorkshopService = NativeFrontendWorkshopService(store)
        characterDrawService = NativeCharacterDrawService(store)
        appearanceService = NativeAppearanceService(store)
        cabinetService = NativeCabinetService(store)
        externalPackageService = NativeExternalPackageService(store)
        aiTaggingService = NativeAiTaggingService(store, NativeSecretStore(applicationContext))
        tavernBridge = NativeTavernBridgeService(applicationContext).apply {
            onStateChanged = { state -> runOnUiThread { tavernBridgeState = state; message = state.detail } }
            onProgress = { progress -> runOnUiThread { message = progress } }
        }
        resources = store.loadResources()
        categories = store.loadCategories()
        versions = store.loadAllVersions()
        runCatching { store.legacyLibraryHistoryCleanup() }
            .onSuccess { legacyLibraryHistory = it }
            .onFailure { message = "无法读取旧整库快照占用：${it.message}" }
        resourceBundles = store.loadResourceBundles()
        drawState = characterDrawService.load()
        appearanceState = appearanceService.load()
        cabinetState = cabinetService.load()
        externalPackages = externalPackageService.load()
        aiTaggingState = aiTaggingService.load()
        githubConfig = cloudService.loadGitHubConfig()
        webDavConfig = cloudService.loadWebDavConfig()
        githubCredentialState = cloudService.credentialState("github")
        webDavCredentialState = cloudService.credentialState("webdav")
        setContent {
            NativeSrlApp(
                resources = resources,
                categories = categories,
                versions = versions,
                cloudBackups = cloudBackups,
                githubConfig = githubConfig,
                webDavConfig = webDavConfig,
                githubCredentialState = githubCredentialState,
                webDavCredentialState = webDavCredentialState,
                tavernBridgeState = tavernBridgeState,
                tavernResources = tavernResources,
                personaBackup = personaBackup,
                presetSegments = presetSegments,
                resourceBundles = resourceBundles,
                workshopOutputIds = workshopOutputIds,
                drawState = drawState,
                drawResultIds = drawResultIds,
                appearanceState = appearanceState,
                cabinetState = cabinetState,
                externalPackages = externalPackages,
                aiTaggingState = aiTaggingState,
                busy = busy,
                message = message,
                storagePath = store.storageDirectory().absolutePath,
                // SRL-PUBLIC-SYNC: PUBLIC-ONLY id=native-worker-ui-origin
                workerOrigin = tavernBridge.workerOrigin(),
                legacyLibraryHistory = legacyLibraryHistory,
                onClearLegacyLibraryHistory = ::clearLegacyLibraryHistory,
                // SRL-PUBLIC-SYNC: BEGIN REPLACE id=native-worker-ui-save
                onSaveWorkerOrigin = { value -> tavernBridge.saveWorkerOrigin(value).also { message = "SRL Worker 地址已保存" } },
                // SRL-PUBLIC-SYNC: END REPLACE id=native-worker-ui-save
                onImport = { filePicker.launch(arrayOf("*/*")) },
                onExport = { selection ->
                    pendingExportSelection = selection
                    val stamp = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd-HH-mm-ss"))
                    archiveCreator.launch("酒馆资源库-原生备份-$stamp.zip")
                },
                onToggleFavorite = ::toggleFavorite,
                onUpdateResourceDetails = ::updateResourceDetails,
                onCreateCategory = ::createCategory,
                onUpdateCategory = ::updateCategory,
                onDeleteCategory = ::deleteCategory,
                onSetResourceCategories = ::setResourceCategories,
                onDeleteResource = ::deleteResource,
                onActivateVersion = ::activateVersion,
                onUpdateVersionNote = ::updateVersionNote,
                onDeleteVersion = ::deleteVersion,
                onSaveGitHub = ::saveGitHub,
                onSaveWebDav = ::saveWebDav,
                onTestCloud = ::testCloud,
                onRefreshCloud = ::refreshCloud,
                onCreateCloudBackup = ::createCloudBackup,
                onRestoreCloudBackup = ::restoreCloudBackup,
                onDeleteCloudBackup = ::deleteCloudBackup,
                onJoinTavernBridge = ::joinTavernBridge,
                onAcceptTavernBridge = ::acceptTavernBridge,
                onRefreshTavernResources = ::refreshTavernResources,
                onPullTavernResources = ::pullTavernResources,
                onSendTavernResources = ::sendTavernResources,
                onDisconnectTavernBridge = ::disconnectTavernBridge,
                onLoadPersona = ::loadPersona,
                onCreatePersona = ::createPersona,
                onSavePersona = ::savePersona,
                onDuplicatePersona = ::duplicatePersona,
                onDeletePersonaEntry = ::deletePersonaEntry,
                onSetDefaultPersona = ::setDefaultPersona,
                onExportPersona = ::requestPersonaExport,
                onLoadPresetSegments = ::loadPresetSegments,
                onGenerateStitchedPreset = ::generateStitchedPreset,
                onSaveResourceBundle = ::saveResourceBundle,
                onDeleteResourceBundle = ::deleteResourceBundle,
                onCompileWorkshop = ::compileFrontendWorkshop,
                onDrawCharacters = ::drawCharacters,
                onClearDrawHistory = ::clearDrawHistory,
                onSaveAppearance = ::saveAppearance,
                onSaveCabinet = ::saveCabinet,
                onRegisterExternalPackage = ::registerExternalPackage,
                onUnregisterExternalPackage = ::unregisterExternalPackage,
                onSaveAiConfig = ::saveAiConfig,
                onClearAiApiKey = ::clearAiApiKey,
                onRunAiTagging = ::runAiTagging,
                onSaveAiDraft = ::saveAiDraft,
                onApplyAiTags = ::applyAiTags,
                onUndoAiTags = ::undoAiTags,
                onClearAiDraft = ::clearAiDraft,
            )
        }
        (getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager).registerDefaultNetworkCallback(networkCallback)
        handleShareIntent(intent)
        window.decorView.postDelayed(::maybeRunAutomaticCloudBackup, 5_000)
    }

    override fun onResume() {
        super.onResume()
        maybeRunAutomaticCloudBackup()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleShareIntent(intent)
    }

    override fun onDestroy() {
        (getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager).unregisterNetworkCallback(networkCallback)
        worker.shutdown()
        tavernBridge.close()
        store.close()
        super.onDestroy()
    }

    private fun importUris(uris: List<Uri>) {
        if (busy) return
        busy = true
        message = "正在校验并导入 ${uris.size} 个文件…"
        worker.execute {
            try {
                val report = store.importUris(uris)
                val refreshed = store.loadResources()
                val refreshedCategories = store.loadCategories()
                val refreshedVersions = store.loadAllVersions()
                runOnUiThread {
                    resources = refreshed
                    categories = refreshedCategories
                    versions = refreshedVersions
                    message = report.summary()
                    busy = false
                }
            } catch (error: Exception) {
                runOnUiThread {
                    message = "导入失败：${error.message ?: "未知错误"}"
                    busy = false
                }
            }
        }
    }

    private fun exportArchive(uri: Uri) {
        if (busy) return
        busy = true
        message = "正在生成兼容 SRL 网页版的备份…"
        worker.execute {
            try {
                val report = store.exportAll(uri, pendingExportSelection)
                runOnUiThread {
                    message = "已导出 ${report.resourceCount} 项资源、${report.versionCount} 个历史版本"
                    busy = false
                }
            } catch (error: Exception) {
                runOnUiThread {
                    message = "导出失败：${error.message ?: "未知错误"}"
                    busy = false
                }
            }
        }
    }

    private fun toggleFavorite(resourceId: String) {
        worker.execute {
            store.toggleFavorite(resourceId)
            val refreshed = store.loadResources()
            runOnUiThread { resources = refreshed }
        }
    }

    private fun updateResourceDetails(resourceId: String, name: String, description: String, tags: List<String>) =
        runStoreMutation("资源名称、说明和标签已保存") { store.updateResourceDetails(resourceId, name, description, tags) }

    private fun createCategory(name: String, color: String) = runStoreMutation("文件夹已创建") {
        store.createCategory(name, color)
    }

    private fun updateCategory(category: NativeCategory, name: String, color: String, hidden: Boolean) =
        runStoreMutation(if (hidden) "文件夹已隐藏" else "文件夹已更新") {
            store.updateCategory(category.id, name, color, hidden)
        }

    private fun deleteCategory(category: NativeCategory) =
        runStoreMutation("文件夹已删除，资源已移到未放入文件夹") { store.deleteCategory(category.id) }

    private fun setResourceCategories(resourceId: String, categoryIds: List<String>) =
        runStoreMutation("资源文件夹已更新") { store.setResourceCategories(resourceId, categoryIds) }

    private fun deleteResource(resourceId: String) =
        runStoreMutation("资源及其历史版本已删除") { store.deleteResource(resourceId) }

    private fun activateVersion(resourceId: String, versionId: String) =
        runStoreMutation("历史版本已切换，原当前版本已保留") { store.activateVersion(resourceId, versionId) }

    private fun updateVersionNote(resourceId: String, versionId: String, note: String) =
        runStoreMutation("版本备注已保存") { store.updateVersionNote(resourceId, versionId, note) }

    private fun deleteVersion(resourceId: String, versionId: String) =
        runStoreMutation("历史版本已删除") { store.deleteVersion(resourceId, versionId) }

    private fun saveGitHub(config: NativeGitHubConfig, token: String) = runCloudAction("GitHub 配置已保存到本机") {
        cloudService.saveGitHub(config, token.takeIf { it.isNotBlank() })
        val refreshed = cloudService.loadGitHubConfig()
        runOnUiThread {
            githubConfig = refreshed
            githubCredentialState = cloudService.credentialState("github")
        }
    }

    private fun saveWebDav(config: NativeWebDavConfig, password: String) = runCloudAction("WebDAV 配置已保存到本机") {
        cloudService.saveWebDav(config, password.takeIf { it.isNotBlank() })
        val refreshed = cloudService.loadWebDavConfig()
        runOnUiThread {
            webDavConfig = refreshed
            webDavCredentialState = cloudService.credentialState("webdav")
        }
    }

    private fun testCloud(provider: String) = runCloudAction("云端连接测试完成") {
        val result = cloudService.test(provider)
        runOnUiThread { message = result }
    }

    private fun refreshCloud(provider: String) = runCloudAction("云端备份列表已刷新") {
        val refreshed = cloudService.listBackups(provider, ::showCloudProgress)
        runOnUiThread { cloudBackups = refreshed }
    }

    private fun createCloudBackup(provider: String, selection: NativeBackupSelection) = runCloudAction("云端对象级快照已完成") {
        cloudService.createBackup(provider, selection, ::showCloudProgress)
        val refreshed = cloudService.listBackups(provider, ::showCloudProgress)
        runOnUiThread { cloudBackups = refreshed }
    }

    private fun restoreCloudBackup(backup: NativeCloudBackup, replace: Boolean) = runCloudAction("云端备份已安全恢复") {
        cloudService.restoreBackup(backup, replace, ::showCloudProgress)
        val refreshedResources = store.loadResources()
        val refreshedCategories = store.loadCategories()
        val refreshedVersions = store.loadAllVersions()
        runOnUiThread {
            resources = refreshedResources; categories = refreshedCategories; versions = refreshedVersions
        }
    }

    private fun deleteCloudBackup(backup: NativeCloudBackup) = runCloudAction("云端备份清单已删除；共享内容块仍保留") {
        cloudService.deleteBackup(backup)
        val refreshed = cloudService.listBackups(backup.provider, ::showCloudProgress)
        runOnUiThread { cloudBackups = refreshed }
    }

    private fun showCloudProgress(progress: buzz.jixiangruyi1207.srl.nativeapp.cloud.NativeCloudProgress) {
        runOnUiThread { message = progress.message }
    }

    private fun joinTavernBridge(code: String) {
        if (busy) return
        busy = true
        message = "正在连接酒馆 HTTPS 安全中继…"
        tavernBridge.join(code).whenComplete { _, error ->
            runOnUiThread {
                if (error != null) message = "酒馆互传连接失败：${error.cause?.message ?: error.message ?: "未知错误"}"
                busy = false
            }
        }
    }

    private fun acceptTavernBridge() {
        if (busy) return
        busy = true
        tavernBridge.accept().whenComplete { _, error ->
            runOnUiThread {
                message = if (error == null) "已确认配对码，等待酒馆扩展完成连接…" else "确认配对失败：${error.cause?.message ?: error.message}"
                busy = false
            }
        }
    }

    private fun refreshTavernResources() {
        if (busy) return
        busy = true
        message = "正在读取酒馆资源列表…"
        tavernBridge.listResources().whenComplete { items, error ->
            runOnUiThread {
                if (error == null) {
                    tavernResources = items
                    message = "已读取 ${items.size} 项酒馆资源"
                } else message = "读取酒馆资源失败：${error.cause?.message ?: error.message}"
                busy = false
            }
        }
    }

    private fun pullTavernResources(ids: List<String>) {
        if (busy) return
        val selected = tavernResources.filter { it.id in ids }
        if (selected.isEmpty()) return
        busy = true
        message = "正在从酒馆接收 ${selected.size} 项资源…"
        tavernBridge.pullResources(selected).whenComplete { files, error ->
            if (error != null) {
                runOnUiThread { message = "从酒馆接收失败：${error.cause?.message ?: error.message}"; busy = false }
                return@whenComplete
            }
            worker.execute {
                try {
                    val report = store.importUris(files.map(Uri::fromFile))
                    val refreshed = store.loadResources()
                    val refreshedCategories = store.loadCategories()
                    val refreshedVersions = store.loadAllVersions()
                    runOnUiThread {
                        resources = refreshed; categories = refreshedCategories; versions = refreshedVersions
                        message = "酒馆资源接收完成：${report.summary()}"; busy = false
                    }
                } catch (failure: Exception) {
                    runOnUiThread { message = "酒馆资源导入失败：${failure.message ?: "未知错误"}"; busy = false }
                } finally {
                    files.forEach(File::delete)
                }
            }
        }
    }

    private fun sendTavernResources(ids: List<String>, conflictPolicy: String) {
        if (busy) return
        val selected = resources.filter { it.id in ids }
        if (selected.isEmpty()) return
        busy = true
        message = "正在向酒馆发送 ${selected.size} 项资源…"
        tavernBridge.sendResources(selected, conflictPolicy).whenComplete { results, error ->
            runOnUiThread {
                message = if (error == null) "已发送 ${results.size} 项：${results.joinToString("；")}" else "发送到酒馆失败：${error.cause?.message ?: error.message}"
                busy = false
            }
        }
    }

    private fun disconnectTavernBridge() {
        tavernBridge.disconnect("已主动断开酒馆互传")
        tavernResources = emptyList()
    }

    private fun loadPersona(resourceId: String) {
        if (busy) return
        busy = true
        worker.execute {
            try {
                val loaded = personaService.load(resourceId)
                runOnUiThread { personaBackup = loaded; message = "已读取 ${loaded.entries.size} 条用户人设"; busy = false }
            } catch (error: Exception) {
                runOnUiThread { message = error.message ?: "用户人设读取失败"; busy = false }
            }
        }
    }

    private fun createPersona(entry: NativePersonaEntry) = runPersonaMutation("用户人设资源已创建") {
        personaService.create(entry).id
    }

    private fun savePersona(resourceId: String, originalAvatarId: String?, entry: NativePersonaEntry) =
        runPersonaMutation(if (originalAvatarId == null) "用户人设已新增" else "用户人设已保存") {
            personaService.save(resourceId, originalAvatarId, entry)
            resourceId
        }

    private fun duplicatePersona(resourceId: String, avatarId: String, nextAvatarId: String) =
        runPersonaMutation("用户人设已复制") {
            personaService.duplicate(resourceId, avatarId, nextAvatarId)
            resourceId
        }

    private fun deletePersonaEntry(resourceId: String, avatarId: String) =
        runPersonaMutation("用户人设条目已删除，旧内容已保留为历史版本") {
            personaService.remove(resourceId, avatarId)
            resourceId
        }

    private fun setDefaultPersona(resourceId: String, avatarId: String) =
        runPersonaMutation("默认用户人设已更新") {
            personaService.setDefault(resourceId, avatarId)
            resourceId
        }

    private fun runPersonaMutation(successMessage: String, action: () -> String) {
        if (busy) return
        busy = true
        worker.execute {
            try {
                val resourceId = action()
                val refreshedResources = store.loadResources()
                val refreshedVersions = store.loadAllVersions()
                val refreshedPersona = personaService.load(resourceId)
                runOnUiThread {
                    resources = refreshedResources
                    versions = refreshedVersions
                    personaBackup = refreshedPersona
                    message = successMessage
                    busy = false
                }
            } catch (error: Exception) {
                runOnUiThread { message = error.message ?: "用户人设保存失败"; busy = false }
            }
        }
    }

    private fun requestPersonaExport(resourceId: String, fileName: String) {
        pendingPersonaExportId = resourceId
        personaCreator.launch(fileName.ifBlank { "personas.json" })
    }

    private fun exportPersona(resourceId: String, uri: Uri) {
        if (busy) return
        busy = true
        worker.execute {
            try {
                store.exportResource(resourceId, uri)
                runOnUiThread { message = "用户人设 JSON 已导出，可直接在酒馆恢复"; busy = false }
            } catch (error: Exception) {
                runOnUiThread { message = error.message ?: "用户人设导出失败"; busy = false }
            }
        }
    }

    private fun loadPresetSegments(resourceId: String) {
        if (busy || presetSegments.containsKey(resourceId)) return
        busy = true
        worker.execute {
            try {
                val loaded = presetStitchService.listSegments(resourceId)
                runOnUiThread {
                    presetSegments = presetSegments + (resourceId to loaded)
                    message = "已读取 ${loaded.size} 个提示词段"
                    busy = false
                }
            } catch (error: Exception) {
                runOnUiThread { message = error.message ?: "预设读取失败"; busy = false }
            }
        }
    }

    private fun generateStitchedPreset(request: NativeStitchRequest) = runStoreMutation("自缝版预设已生成并放入资源库") {
        presetStitchService.stitch(request)
    }

    private fun saveResourceBundle(bundle: NativeResourceBundle) = runStoreMutation("资源套装已保存并建立双向关联") {
        store.saveResourceBundle(bundle)
    }

    private fun deleteResourceBundle(bundleId: String) = runStoreMutation("资源套装记录已删除，资源文件与关联未删除") {
        store.deleteResourceBundle(bundleId)
    }

    private fun compileFrontendWorkshop(fieldSource: String, designSource: String, title: String, dataMode: String) {
        if (busy) return
        busy = true
        message = "正在校验并生成酒馆正则与世界书…"
        worker.execute {
            try {
                val result = frontendWorkshopService.compileAndSave(fieldSource, designSource, title, dataMode)
                val refreshedResources = store.loadResources()
                val refreshedVersions = store.loadAllVersions()
                runOnUiThread {
                    resources = refreshedResources
                    versions = refreshedVersions
                    workshopOutputIds = listOf(result.regexResourceId, result.worldBookResourceId)
                    message = "“${result.title}”已生成：${result.fieldCount} 个字段、正则与世界书已双向关联"
                    busy = false
                }
            } catch (error: Exception) {
                runOnUiThread {
                    message = error.message ?: "前端工作台生成失败"
                    busy = false
                }
            }
        }
    }

    private fun drawCharacters(options: NativeDrawOptions) {
        if (busy) return
        busy = true
        message = if (options.count == 10) "正在抽取十张角色卡…" else "正在抽取角色卡…"
        worker.execute {
            try {
                val result = characterDrawService.draw(resources, options)
                runOnUiThread {
                    drawState = result.state
                    drawResultIds = result.resourceIds
                    message = if (options.count == 10) "十连抽取完成" else "抽取完成"
                    busy = false
                }
            } catch (error: Exception) {
                runOnUiThread { message = error.message ?: "抽取失败"; busy = false }
            }
        }
    }

    private fun clearDrawHistory() {
        if (busy) return
        busy = true
        worker.execute {
            try {
                val cleared = characterDrawService.clear()
                runOnUiThread {
                    drawState = cleared
                    drawResultIds = emptyList()
                    message = "抽取记录已清除，角色卡未删除"
                    busy = false
                }
            } catch (error: Exception) {
                runOnUiThread { message = error.message ?: "清除抽取记录失败"; busy = false }
            }
        }
    }

    private fun saveAppearance(theme: String, layoutMode: String, blurThumbnails: Boolean, cabinetColumns: Int) {
        if (busy) return
        busy = true
        worker.execute {
            try {
                val saved = appearanceService.save(theme, layoutMode, blurThumbnails, cabinetColumns)
                runOnUiThread {
                    appearanceState = saved
                    cabinetState = cabinetService.load()
                    message = "原生外观已保存并应用，兼容配置已写入备份数据"
                    busy = false
                }
            } catch (error: Exception) {
                runOnUiThread { message = error.message ?: "外观保存失败"; busy = false }
            }
        }
    }

    private fun saveCabinet(resourceIds: List<String>) {
        if (busy) return
        busy = true
        worker.execute {
            try {
                val saved = cabinetService.save(resourceIds)
                runOnUiThread {
                    cabinetState = saved
                    message = "收藏柜布局已保存，资源文件没有被复制或移动"
                    busy = false
                }
            } catch (error: Exception) {
                runOnUiThread { message = error.message ?: "收藏柜保存失败"; busy = false }
            }
        }
    }

    private fun registerExternalPackage(resourceId: String) = runStoreMutation("扩展包已通过检查并登记；第三方代码仍未执行") {
        externalPackageService.inspectAndRegister(resourceId)
    }

    private fun unregisterExternalPackage(appId: String) = runStoreMutation("扩展登记已移除，原安装包资源仍保留") {
        externalPackageService.unregister(appId)
    }

    private fun saveAiConfig(config: NativeAiConfig, apiKey: String) = runStoreMutation("AI 接口配置已保存在本机；密钥由 Android Keystore 加密") {
        aiTaggingService.saveConfig(config, apiKey.takeIf(String::isNotBlank))
    }

    private fun clearAiApiKey() = runStoreMutation("AI API Key 已从本机加密存储删除") { aiTaggingService.clearApiKey() }

    private fun saveAiDraft(draft: NativeAiDraft) {
        worker.execute {
            runCatching { aiTaggingService.saveDraft(draft); aiTaggingService.load() }
                .onSuccess { refreshed -> runOnUiThread { aiTaggingState = refreshed } }
                .onFailure { error -> runOnUiThread { message = error.message ?: "AI 标签草稿保存失败" } }
        }
    }

    private fun clearAiDraft() = runStoreMutation("AI 标签草稿已清空；资源标签没有改变") { aiTaggingService.clearDraft() }

    private fun runAiTagging(ids: List<String>, batchSize: Int, prompt: String, taxonomy: String, mergeAliases: Boolean, preserveExisting: Boolean) {
        if (busy) return
        busy = true
        message = "正在读取首批资源并准备上下文…"
        worker.execute {
            try {
                val result = aiTaggingService.recognize(ids, batchSize, prompt, taxonomy, mergeAliases, preserveExisting) { batch, total ->
                    runOnUiThread { message = "已完成第 $batch/$total 批，正在整理审核草稿" }
                }
                val refreshed = aiTaggingService.load()
                runOnUiThread {
                    aiTaggingState = refreshed
                    message = if (result.draft.failures.isEmpty()) "识别完成，请逐项审核后再写入标签" else "成功结果已保留，失败项可单独重试"
                    busy = false
                }
            } catch (error: Exception) {
                runOnUiThread { message = error.message ?: "AI 标签识别失败"; busy = false }
            }
        }
    }

    private fun applyAiTags(items: List<NativeAiReviewItem>) = runStoreMutation("已审核标签已写入，可从 AI 标签页精确撤销") {
        aiTaggingService.applyReviewed(items)
    }

    private fun undoAiTags() = runStoreMutation("上次 AI 新增且仍存在的标签已撤销") { aiTaggingService.undoLast() }

    private fun runCloudAction(successMessage: String, action: () -> Unit) {
        if (busy) return
        busy = true
        worker.execute {
            try {
                action()
                runOnUiThread { message = successMessage; busy = false }
            } catch (error: Exception) {
                runOnUiThread {
                    githubCredentialState = cloudService.credentialState("github")
                    webDavCredentialState = cloudService.credentialState("webdav")
                    message = "云端操作失败：${error.cause?.message ?: error.message ?: "未知错误"}"
                    busy = false
                }
            }
        }
    }

    private fun maybeRunAutomaticCloudBackup() {
        if (busy || resources.isEmpty() || isFinishing || isDestroyed || worker.isShutdown) return
        val connectivity = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val capabilities = connectivity.getNetworkCapabilities(connectivity.activeNetwork) ?: return
        if (!capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) return
        val unmetered = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
        val charging = (getSystemService(Context.BATTERY_SERVICE) as BatteryManager).isCharging
        val providers = cloudService.automaticProvidersDue(unmetered, charging)
        if (providers.isEmpty()) return
        runCloudAction("自动云备份已完成") {
            providers.forEach { providerName ->
                cloudService.createBackup(providerName, NativeBackupSelection(), ::showCloudProgress)
            }
        }
    }

    private fun clearLegacyLibraryHistory(plan: buzz.jixiangruyi1207.srl.nativeapp.model.LegacyLibraryHistoryCleanup) {
        if (busy || plan.files.isEmpty()) return
        busy = true
        android.app.AlertDialog.Builder(this)
            .setTitle("清理旧整库快照")
            .setMessage("永久删除 ${plan.files.size} 份旧整库快照（${android.text.format.Formatter.formatFileSize(this, plan.bytes)}），无法撤销。当前资源、单资源版本和云备份不受影响；未登记的文件会保留。")
            .setNegativeButton("取消") { _, _ -> busy = false }
            .setOnCancelListener { busy = false }
            .setPositiveButton("永久清理") { _, _ ->
                worker.execute {
                    val result = try {
                        store.clearLegacyLibraryHistory(plan)
                        "已清理 ${plan.files.size} 份旧整库快照"
                    } catch (error: Exception) { error.message ?: "旧整库快照清理失败" }
                    val remaining = runCatching { store.legacyLibraryHistoryCleanup() }.getOrNull()
                    runOnUiThread {
                        if (remaining != null) legacyLibraryHistory = remaining
                        message = result
                        busy = false
                    }
                }
            }.show()
    }

    private fun runStoreMutation(successMessage: String, action: () -> Unit) {
        if (busy) return
        busy = true
        worker.execute {
            try {
                action()
                val refreshedResources = store.loadResources()
                val refreshedCategories = store.loadCategories()
                val refreshedVersions = store.loadAllVersions()
                val refreshedBundles = store.loadResourceBundles()
                val refreshedExternalPackages = externalPackageService.load()
                val refreshedAiTaggingState = aiTaggingService.load()
                runOnUiThread {
                    resources = refreshedResources
                    categories = refreshedCategories
                    versions = refreshedVersions
                    resourceBundles = refreshedBundles
                    externalPackages = refreshedExternalPackages
                    aiTaggingState = refreshedAiTaggingState
                    message = successMessage
                    busy = false
                }
            } catch (error: Exception) {
                runOnUiThread {
                    message = error.message ?: "操作失败"
                    busy = false
                }
            }
        }
    }

    private fun handleShareIntent(intent: Intent?) {
        if (intent == null) return
        val uris = when (intent.action) {
            Intent.ACTION_SEND -> listOfNotNull(streamUri(intent))
            Intent.ACTION_SEND_MULTIPLE -> streamUris(intent)
            else -> emptyList()
        }
        if (uris.isNotEmpty()) {
            setIntent(Intent())
            importUris(uris)
        }
    }

    @Suppress("DEPRECATION")
    private fun streamUri(intent: Intent): Uri? {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        } else intent.getParcelableExtra(Intent.EXTRA_STREAM)
    }

    @Suppress("DEPRECATION")
    private fun streamUris(intent: Intent): List<Uri> {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)?.toList().orEmpty()
        } else intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)?.toList().orEmpty()
    }
}
