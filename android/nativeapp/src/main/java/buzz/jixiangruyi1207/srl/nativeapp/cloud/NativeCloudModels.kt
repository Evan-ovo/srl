package buzz.jixiangruyi1207.srl.nativeapp.cloud

sealed interface NativeCloudConfig {
    val retention: Int
    val autoBackup: Boolean
    val wifiOnly: Boolean
    val chargingOnly: Boolean
}

data class NativeGitHubConfig(
    val owner: String,
    val repository: String,
    override val retention: Int = 7,
    override val autoBackup: Boolean = false,
    override val wifiOnly: Boolean = true,
    override val chargingOnly: Boolean = false,
) : NativeCloudConfig

data class NativeWebDavConfig(
    val baseUrl: String,
    val folder: String = "SRL-Backups",
    val username: String,
    override val retention: Int = 7,
    override val autoBackup: Boolean = false,
    override val wifiOnly: Boolean = true,
    override val chargingOnly: Boolean = false,
) : NativeCloudConfig

data class NativeCloudObject(
    val id: String,
    val name: String,
    val size: Long,
    val createdAt: Long,
    val digest: String? = null,
)

data class NativeCloudBackup(
    val id: String,
    val objectKey: String,
    val size: Long,
    val createdAt: Long,
    val partCount: Int,
    val provider: String,
    val legacy: Boolean = false,
    val kind: String = "snapshot",
    val archiveName: String = objectKey,
)

data class NativeCloudProgress(val message: String, val completed: Int = 0, val total: Int = 0)

enum class NativeCredentialState { MISSING, VALID, INVALID }

class NativeCloudHttpException(val status: Int, message: String) : IllegalStateException(message)
