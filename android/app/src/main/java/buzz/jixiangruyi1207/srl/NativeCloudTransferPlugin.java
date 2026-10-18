package buzz.jixiangruyi1207.srl;

import static buzz.jixiangruyi1207.srl.NativeCloudRestoreTransport.validateRestoreUri;
import static buzz.jixiangruyi1207.srl.NativeCloudRestoreTransport.verifyFile;
import static buzz.jixiangruyi1207.srl.NativeCloudRestoreTransport.hex;
import static buzz.jixiangruyi1207.srl.NativeCloudRestoreTransport.CloudHttpStatusException;
import static buzz.jixiangruyi1207.srl.NativeCloudCardMetadata.readCharacterCard;
import static buzz.jixiangruyi1207.srl.NativeCloudCardMetadata.createCharacterCardThumbnail;

import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.JSArray;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import androidx.work.WorkInfo;
import androidx.lifecycle.LiveData;
import androidx.lifecycle.Observer;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.RandomAccessFile;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Set;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.json.JSONObject;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;
import org.json.JSONArray;
import org.json.JSONObject;

/** 把 Vue 已生成的差异对象持久化为 Android 后台上传任务。 */
@CapacitorPlugin(name = "NativeCloudTransfer")
public class NativeCloudTransferPlugin extends Plugin {
    static final String JOB_WORK_PREFIX = "srl-cloud-upload-";
    private static final Object STAGING_MONITOR = new Object();
    private static long stagingRevision;
    // 原生任务直连 GitHub / WebDAV，并以 512 KiB 分段写入应用缓存，不经过 64 MiB 的 Worker 代理。
    // 与资源库现有单文件导入上限保持一致；普通内容对象仍由网页层控制在 32 MiB 内。
    private static final long MAX_OBJECT_BYTES = 256L * 1024L * 1024L;
    private static final long MAX_RESOURCE_BYTES = 8L * 1024L * 1024L * 1024L * 1024L;
    private static final int MAX_RESTORE_OBJECTS = 50_000;
    private static final int MAX_CHUNK_BYTES = 1024 * 1024;
    private final ConcurrentHashMap<String, PendingObject> pending = new ConcurrentHashMap<>();

    @PluginMethod
    public void saveCredential(PluginCall call) {
        runIo(call, () -> {
            String provider = provider(call.getString("provider"));
            new NativeSecretStore(getContext()).saveCredential(
                "cloud-" + provider,
                "cloud-" + provider + "-invalid",
                required(call.getString("secret"), "云端凭据", 4096)
            );
            call.resolve();
        });
    }

    @PluginMethod
    public void clearCredential(PluginCall call) {
        runIo(call, () -> {
            String provider = provider(call.getString("provider"));
            new NativeSecretStore(getContext()).clearCredential(
                "cloud-" + provider, "cloud-" + provider + "-invalid"
            );
            call.resolve();
        });
    }

    @PluginMethod
    public void invalidateCredential(PluginCall call) {
        runIo(call, () -> {
            String provider = provider(call.getString("provider"));
            new NativeSecretStore(getContext()).invalidateCredential(
                "cloud-" + provider, "cloud-" + provider + "-invalid"
            );
            call.resolve();
        });
    }

    @PluginMethod
    public void hasCredential(PluginCall call) {
        runIo(call, () -> {
            String provider = provider(call.getString("provider"));
            NativeSecretStore store = new NativeSecretStore(getContext());
            boolean invalid = store.isCredentialInvalid("cloud-" + provider + "-invalid");
            JSObject result = new JSObject();
            result.put("present", !invalid && store.has("cloud-" + provider));
            result.put("valid", !invalid);
            call.resolve(result);
        });
    }

    @PluginMethod
    public void readCredential(PluginCall call) {
        runIo(call, () -> {
            String provider = provider(call.getString("provider"));
            NativeSecretStore store = new NativeSecretStore(getContext());
            boolean invalid = store.isCredentialInvalid("cloud-" + provider + "-invalid");
            String secret = invalid ? null : store.read("cloud-" + provider);
            JSObject result = new JSObject();
            result.put("present", secret != null && !secret.isBlank());
            result.put("valid", !invalid);
            if (secret != null && !secret.isBlank()) result.put("secret", secret);
            call.resolve(result);
        });
    }

    @PluginMethod
    public void saveAppCredential(PluginCall call) {
        runIo(call, () -> {
            String identifier = appCredentialIdentifier(call.getString("identifier"));
            String secret = required(call.getString("secret"), "本机凭据", 16384);
            new NativeSecretStore(getContext()).save(identifier, secret);
            call.resolve();
        });
    }

    @PluginMethod
    public void readAppCredential(PluginCall call) {
        runIo(call, () -> {
            String identifier = appCredentialIdentifier(call.getString("identifier"));
            String secret = new NativeSecretStore(getContext()).read(identifier);
            JSObject result = new JSObject();
            if (secret != null && !secret.isBlank()) result.put("secret", secret);
            call.resolve(result);
        });
    }

    @PluginMethod
    public void clearAppCredential(PluginCall call) {
        runIo(call, () -> {
            new NativeSecretStore(getContext()).clear(
                appCredentialIdentifier(call.getString("identifier"))
            );
            call.resolve();
        });
    }

    /** 受限 WebDAV 元数据请求仍在插件的串行 IO 执行器中运行。 */
    @PluginMethod
    public void webDavRequest(PluginCall call) {
        runIo(call, () -> call.resolve(NativeCloudWebDav.request(
            required(call.getString("url"), "WebDAV 地址", 8192),
            required(call.getString("method"), "WebDAV 请求方法", 16),
            call.getObject("headers", new JSObject()))));
    }

    /**
     * Cloud Backup V3 原生恢复：远端对象经 OkHttp 流式写入 NativeLibrary，随后按
     * manifest 的分段顺序拼成资源对象。JS 只传计划和最终元数据，不承载二进制。
     */
    private final java.util.concurrent.ConcurrentHashMap<String, NativeCloudRestoreWorker.Handle> restoreRequests = new java.util.concurrent.ConcurrentHashMap<>();
    private final java.util.Set<String> cancelledRestoreRequests = java.util.concurrent.ConcurrentHashMap.newKeySet();

    @PluginMethod public void cancelRestore(PluginCall call) {
        runIo(call, () -> {
            String id = safeId(call.getString("requestId"));
            cancelledRestoreRequests.add(id);
            NativeCloudRestoreWorker.Handle handle = restoreRequests.get(id);
            if (handle != null) {
                requestCancellation(handle.root);
                WorkManager.getInstance(getContext()).cancelUniqueWork(NativeCloudRestoreWorker.WORK_PREFIX + handle.root.getName()).getResult().get();
                NativeCloudRestoreWorker.awaitStopped(handle.root.getName());
                new NativeSecretStore(getContext()).clear("cloud-job-" + handle.root.getName());
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void restoreStructuredFiles(PluginCall call) {
        runIo(call, () -> {
            JSObject config = call.getObject("config");
            if (config == null) throw new IllegalArgumentException("缺少原生恢复配置");
            String provider = provider(config.optString("provider", ""));
            String secret = required(call.getString("secret"), "云端凭据", 4096);
            JSArray objects = call.getArray("objects");
            JSArray resources = call.getArray("resources");
            if (objects == null || resources == null
                || objects.length() > MAX_RESTORE_OBJECTS || resources.length() > MAX_RESTORE_OBJECTS) {
                throw new IllegalArgumentException("原生恢复计划数量无效");
            }

            String webDavHost = "";
            if ("webdav".equals(provider)) {
                URI baseUri = URI.create(required(config.optString("baseUrl", ""), "WebDAV 地址", 8192));
                if (!"https".equalsIgnoreCase(baseUri.getScheme()) || baseUri.getHost() == null) {
                    throw new IllegalArgumentException("WebDAV 原生恢复只允许 HTTPS 地址");
                }
                webDavHost = baseUri.getHost();
                required(config.optString("username", ""), "WebDAV 用户名", 1024);
            }

            java.util.List<NativeCloudRestoreTransport.RestoreObject> objectPlan = new java.util.ArrayList<>();
            for (int index = 0; index < objects.length(); index++) {
                JSONObject object = objects.getJSONObject(index);
                String hash = requiredHash(object.optString("hash", ""));
                long size = object.optLong("size", -1L);
                if (size < 0 || size > MAX_OBJECT_BYTES) {
                    throw new IllegalArgumentException("原生恢复对象大小无效");
                }
                String url = required(object.optString("url", ""), "原生恢复对象地址", 8192);
                validateRestoreUri(provider, URI.create(url), webDavHost);
                objectPlan.add(new NativeCloudRestoreTransport.RestoreObject(hash, size, url));
            }
            java.util.List<NativeCloudRestoreTransport.RestoreResource> resourcePlan = new java.util.ArrayList<>();
            for (int index = 0; index < resources.length(); index++) {
                JSONObject resource = resources.getJSONObject(index);
                String hash = requiredHash(resource.optString("hash", ""));
                long size = resource.optLong("size", -1L);
                JSONArray segments = resource.optJSONArray("segments");
                if (size < 0 || size > MAX_RESOURCE_BYTES || segments == null
                    || segments.length() == 0 || segments.length() > 4096) {
                    throw new IllegalArgumentException("原生恢复资源计划无效");
                }
                java.util.List<NativeCloudRestoreTransport.RestoreSegment> ranges = new java.util.ArrayList<>();
                for (int part = 0; part < segments.length(); part++) {
                    JSONObject segment = segments.getJSONObject(part);
                    ranges.add(new NativeCloudRestoreTransport.RestoreSegment(
                        requiredHash(segment.optString("hash", "")),
                        segment.optLong("offset", -1L), segment.optLong("size", -1L)
                    ));
                }
                resourcePlan.add(new NativeCloudRestoreTransport.RestoreResource(hash, size, ranges));
            }
            NativeCloudRestoreTransport.validatePlan(objectPlan, resourcePlan);
            NativeCloudRestoreWorker.Handle handle = NativeCloudRestoreWorker.enqueue(getContext(), config, secret, objects, resources, Boolean.TRUE.equals(call.getBoolean("progressive", false)));
            new NativeSecretStore(getContext()).saveCredential(
                "cloud-" + provider, "cloud-" + provider + "-invalid", secret
            );
            String requestId = call.getString("requestId");
            if (requestId != null) {
                requestId = safeId(requestId);
                restoreRequests.put(requestId, handle);
                if (cancelledRestoreRequests.contains(requestId)) {
                    requestCancellation(handle.root);
                    WorkManager.getInstance(getContext()).cancelUniqueWork(NativeCloudRestoreWorker.WORK_PREFIX + handle.root.getName());
                }
            }
            observeRestore(call, handle, requestId);
        });
    }

    private void observeRestore(PluginCall call, NativeCloudRestoreWorker.Handle handle, String requestId) {
        LiveData<WorkInfo> liveData = WorkManager.getInstance(getContext()).getWorkInfoByIdLiveData(handle.workId);
        final Observer<WorkInfo>[] holder = new Observer[1];
        final long[] cursor = {0};
        holder[0] = info -> {
            if (info == null) return;
            if (info.getState().isFinished()) liveData.removeObserver(holder[0]);
            NativeExecutors.ioSerial().execute(() -> {
                try {
                    if (info.getState().isFinished()) NativeCloudRestoreWorker.awaitStopped(handle.root.getName());
                    JSONObject job = readJob(handle.root);
                    File receipts = new File(handle.root, "restore-results.ndjson");
                    if (requestId != null && receipts.isFile()) try (java.io.RandomAccessFile input = new java.io.RandomAccessFile(receipts, "r")) {
                        input.seek(cursor[0]);
                        while (input.getFilePointer() < input.length()) {
                            JSArray entries = new JSArray();
                            for (int count = 0; count < 64; count++) {
                                long start = input.getFilePointer();
                                String line = input.readLine();
                                if (line == null) break;
                                long end = input.getFilePointer();
                                input.seek(end - 1);
                                boolean complete = input.read() == 10;
                                input.seek(end);
                                if (!complete) { input.seek(start); break; }
                                try { entries.put(new JSONObject(new String(line.getBytes(StandardCharsets.ISO_8859_1), StandardCharsets.UTF_8))); }
                                catch (Exception incomplete) { input.seek(start); break; }
                            }
                            if (entries.length() == 0) break;
                            cursor[0] = input.getFilePointer();
                            JSObject status = jobSummary(job);
                            status.put("requestId", requestId); status.put("resourceResults", entries);
                            getActivity().runOnUiThread(() -> notifyListeners("jobProgress", status));
                        }
                    }
                    if (!info.getState().isFinished()) return;
                    if (!"completed".equals(job.optString("status"))) {
                        call.reject(job.optString("error", "原生云恢复未完成"), "cancelled".equals(job.optString("status")) ? "RESTORE_CANCELLED" : job.optString("errorCode", "RESTORE_FAILED"));
                        return;
                    }
                    JSObject result = new JSObject();
                    for (String key : new String[]{"downloaded", "reused", "assembled"}) result.put(key, job.optInt(key, 0));
                    result.put("failures", job.optJSONArray("failures"));
                    call.resolve(result);
                } catch (Exception error) { call.reject("读取原生恢复结果失败", error); }
                finally {
                    if (info.getState().isFinished() && requestId != null) {
                        restoreRequests.remove(requestId); cancelledRestoreRequests.remove(requestId);
                    }
                }
            });
        };
        getActivity().runOnUiThread(() -> liveData.observe(getActivity(), holder[0]));
    }

    /** One card per bridge response; never accumulate a snapshot's bodies or thumbnails. */
    @PluginMethod
    public void readRestoredCardMetadata(PluginCall call) {
        runIo(call, () -> {
            String hash = requiredHash(call.getString("hash", ""));
            long size = call.getData().optLong("size", -1L);
            File file = NativeLibraryPlugin.objectFile(getContext(), hash);
            if (size < 0 || size > MAX_RESOURCE_BYTES || !verifyFile(file, hash, size)) {
                throw new IOException("原生角色卡对象大小或 SHA-256 校验失败");
            }
            JSObject result = new JSObject();
            result.put("hash", hash);
            result.put("card", readCharacterCard(file, required(call.getString("fileName", ""), "角色卡文件名", 1024)));
            String thumbnail = createCharacterCardThumbnail(file);
            if (thumbnail != null) {
                result.put("thumbnailBase64", thumbnail);
                result.put("thumbnailMimeType", "image/png");
            }
            call.resolve(result);
        });
    }

    @PluginMethod
    public void beginJob(PluginCall call) {
        runIo(call, () -> {
            JSObject config = call.getObject("config");
            if (config == null) throw new IllegalArgumentException("缺少原生云任务配置");
            String provider = config.optString("provider", "");
            if (!"github".equals(provider) && !"webdav".equals(provider)) throw new IllegalArgumentException("云端类型无效");
            String secret = required(call.getString("secret"), "云端凭据", 4096);
            Integer requestedExpectedTotal = call.getInt("expectedTotal");
            int expectedTotal = requestedExpectedTotal == null ? 0 : requestedExpectedTotal;
            if (expectedTotal < 0) throw new IllegalArgumentException("原生云任务预期对象数无效");
            deleteExpiredJobs();
            String jobId = UUID.randomUUID().toString();
            File root = jobRoot(jobId);
            if (!root.mkdirs()) throw new IllegalStateException("无法创建原生云任务目录");
            long now = System.currentTimeMillis();
            JSONObject job = new JSONObject();
            job.put("version", 3);
            job.put("id", jobId);
            job.put("provider", provider);
            job.put("status", "staging");
            job.put("createdAt", now);
            job.put("updatedAt", now);
            job.put("lastStagedAt", now);
            job.put("wifiOnly", call.getBoolean("wifiOnly", false));
            job.put("chargingOnly", call.getBoolean("chargingOnly", false));
            job.put("automatic", call.getBoolean("automatic", false));
            job.put("config", new JSONObject(config.toString()));
            job.put("objectCount", 0);
            job.put("totalBytes", 0L);
            job.put("manifestStaged", false);
            job.put("sealed", false);
            job.put("expectedTotal", expectedTotal);
            job.put("completed", 0);
            job.put("total", expectedTotal);
            writeJob(root, job);
            NativeSecretStore secrets = new NativeSecretStore(getContext());
            secrets.saveCredential(
                "cloud-" + provider, "cloud-" + provider + "-invalid", secret
            );
            secrets.save("cloud-job-" + jobId, secret);
            job = mutateJob(root, current -> current.put("status", "queued"));
            enqueueJob(jobId, job);
            JSObject result = new JSObject();
            result.put("jobId", jobId);
            result.put("pipeline", true);
            call.resolve(result);
        });
    }

    @PluginMethod
    public void beginObject(PluginCall call) {
        runIo(call, () -> {
            String jobId = safeId(call.getString("jobId"));
            File root = jobRoot(jobId);
            JSONObject job = readJob(root);
            ensureJobAccepting(job);
            boolean manifest = call.getBoolean("manifest", false);
            String name = NativeCloudObjectKey.validate(
                job.optString("provider", ""),
                required(call.getString("name"), "对象名称", 240),
                manifest
            );
            Integer requestedSize = call.getInt("size");
            long size = requestedSize == null ? -1L : requestedSize.longValue();
            if (size < 0) throw new IllegalArgumentException("云对象大小无效");
            if (size > MAX_OBJECT_BYTES) throw new IllegalArgumentException("单个云对象超过 256 MiB");
            String token = UUID.randomUUID().toString();
            File temporary = new File(jobRoot(jobId), token + ".part");
            PendingObject object = new PendingObject(jobId, token, name,
                call.getString("contentType", "application/octet-stream"),
                manifest, call.getString("existingId", ""), size,
                NativeBridgeNumber.boundedOrDefault(
                    call.getData().opt("releaseId"), -1L, 1L,
                    NativeBridgeNumber.MAX_SAFE_INTEGER, "GitHub Release ID 无效"
                ),
                temporary, new FileOutputStream(temporary), MessageDigest.getInstance("SHA-256"));
            pending.put(token, object);
            JSObject result = new JSObject();
            result.put("token", token);
            call.resolve(result);
        });
    }

    /**
     * NativeLibrary handoff 的轻量预检：只检查对象文件是否存在且长度足够，
     * 不读取内容、不重新计算完整文件 SHA-256。
     */
    @PluginMethod
    public void probeLibraryObject(PluginCall call) {
        runIo(call, () -> {
            String sourceHash = requiredHash(call.getString("sourceHash"));
            long minimumSize = NativeBridgeNumber.bounded(
                call.getData().opt("minimumSize"), 0L, MAX_RESOURCE_BYTES,
                "原生对象预检大小无效"
            );
            File source = NativeLibraryPlugin.objectFile(getContext(), sourceHash);
            long size = source.isFile() ? source.length() : 0L;
            JSObject result = new JSObject();
            result.put("available", source.isFile() && size >= minimumSize);
            result.put("size", size);
            call.resolve(result);
        });
    }

    /** Checks the distinct NativeLibrary source set in one JS/native bridge call. */
    @PluginMethod
    public void probeLibraryObjects(PluginCall call) {
        runIo(call, () -> {
            JSArray requested = call.getArray("sources");
            if (requested == null || requested.length() > 100_000) {
                throw new IllegalArgumentException("原生对象预检清单无效");
            }
            boolean available = true;
            for (int index = 0; index < requested.length(); index++) {
                JSONObject source = requested.getJSONObject(index);
                String sourceHash = requiredHash(source.getString("sourceHash"));
                long minimumSize = NativeBridgeNumber.bounded(
                    source.opt("minimumSize"), 0L, MAX_RESOURCE_BYTES,
                    "原生对象预检大小无效"
                );
                File file = NativeLibraryPlugin.objectFile(getContext(), sourceHash);
                if (!file.isFile() || file.length() < minimumSize) available = false;
            }
            JSObject result = new JSObject();
            result.put("available", available);
            call.resolve(result);
        });
    }

    /** Records a NativeLibrary range. The Worker streams it directly and does not make a .bin copy. */
    @PluginMethod
    public void stageObjectFromLibrary(PluginCall call) {
        runIo(call, () -> {
            String jobId = safeId(call.getString("jobId"));
            File root = jobRoot(jobId);
            JSONObject job = readJob(root);
            ensureJobAccepting(job);
            String name = NativeCloudObjectKey.validate(
                job.optString("provider", ""),
                required(call.getString("name"), "对象名称", 240),
                false
            );
            String sourceHash = requiredHash(call.getString("sourceHash"));
            long offset = NativeBridgeNumber.bounded(
                call.getData().opt("offset"), 0L, MAX_RESOURCE_BYTES,
                "原生对象切片范围无效"
            );
            long size = NativeBridgeNumber.bounded(
                call.getData().opt("size"), 0L, MAX_OBJECT_BYTES,
                "原生对象切片范围无效"
            );
            if (offset > MAX_RESOURCE_BYTES - size) {
                throw new IllegalArgumentException("原生对象切片范围无效");
            }
            JSONArray segments = new JSONArray();
            segments.put(sourceSegment(sourceHash, offset, size));
            call.resolve(stageSourceEntry(call, root, name, segments, size));
        });
    }

    /** Records multiple NativeLibrary ranges for an immutable concat object. */
    @PluginMethod
    public void stageObjectFromSources(PluginCall call) {
        runIo(call, () -> {
            String jobId = safeId(call.getString("jobId"));
            File root = jobRoot(jobId);
            JSONObject job = readJob(root);
            ensureJobAccepting(job);
            String name = NativeCloudObjectKey.validate(
                job.optString("provider", ""),
                required(call.getString("name"), "对象名称", 240),
                false
            );
            JSArray requested = call.getArray("segments");
            if (requested == null || requested.length() == 0 || requested.length() > 4096) {
                throw new IllegalArgumentException("原生拼接对象来源无效");
            }
            JSONArray segments = new JSONArray();
            long total = 0L;
            for (int index = 0; index < requested.length(); index++) {
                JSONObject value = requested.getJSONObject(index);
                String sourceHash = requiredHash(value.optString("contentHash", ""));
                long offset = value.optLong("offset", -1L);
                long size = value.optLong("size", -1L);
                if (offset < 0 || size < 0 || size > MAX_OBJECT_BYTES || offset > Long.MAX_VALUE - size || total > MAX_OBJECT_BYTES - size) {
                    throw new IllegalArgumentException("原生拼接对象切片范围无效");
                }
                segments.put(sourceSegment(sourceHash, offset, size));
                total += size;
            }
            call.resolve(stageSourceEntry(call, root, name, segments, total));
        });
    }

    /** Snapshot an AssetStore file range into this job without sending its bytes through JS. */
    @PluginMethod
    public void stageObjectFromFile(PluginCall call) {
        runIo(call, () -> {
            File root = jobRoot(safeId(call.getString("jobId")));
            JSONObject job = readJob(root);
            ensureJobAccepting(job);
            String name = NativeCloudObjectKey.validate(job.optString("provider", ""),
                required(call.getString("name"), "对象名称", 240), false);
            String baseName = NativeCloudObjectKey.baseName(name);
            if (!baseName.startsWith("srl-chunk--sha256-")) throw new IllegalArgumentException("附件对象名称无效");
            String hash = requiredHash(baseName.substring("srl-chunk--sha256-".length()));
            long offset = NativeBridgeNumber.bounded(call.getData().opt("offset"), 0L, MAX_RESOURCE_BYTES, "附件范围无效");
            long size = NativeBridgeNumber.bounded(call.getData().opt("size"), 0L, MAX_OBJECT_BYTES, "附件范围无效");
            File source = NativeFileAccess.resolve(getContext(), call.getString("uri"));
            if (!source.isFile() || offset > source.length() || size > source.length() - offset)
                throw new IllegalStateException("Discord 附件来源缺失或长度已变化");
            String token = UUID.randomUUID().toString();
            File temporary = new File(root, token + ".part");
            File destination = new File(root, token + ".bin");
            try {
                copyVerifiedFileRange(source, temporary, offset, size, hash);
                ensureJobAccepting(readJob(root));
                if (!temporary.renameTo(destination)) throw new IOException("无法提交 Discord 附件暂存");
                JSONObject entry = new JSONObject();
                entry.put("token", token); entry.put("name", name); entry.put("size", size);
                entry.put("sha256", hash); entry.put("manifest", false);
                entry.put("contentType", call.getString("contentType", "application/octet-stream"));
                entry.put("existingId", call.getString("existingId", ""));
                long releaseId = NativeBridgeNumber.boundedOrDefault(call.getData().opt("releaseId"), -1L, 1L,
                    NativeBridgeNumber.MAX_SAFE_INTEGER, "GitHub Release ID 无效");
                if (releaseId > 0) entry.put("releaseId", releaseId);
                appendStagedEntry(root, entry);
            } catch (Exception error) {
                temporary.delete(); destination.delete(); throw error;
            }
            JSObject result = new JSObject(); result.put("staged", true); call.resolve(result);
        });
    }

    static void copyVerifiedFileRange(File source, File temporary, long offset, long size, String hash) throws Exception {
        if (offset < 0 || size < 0 || size > MAX_OBJECT_BYTES || offset > source.length() || size > source.length() - offset)
            throw new IOException("Discord 附件范围无效或原件已变化");
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try (RandomAccessFile input = new RandomAccessFile(source, "r");
                 FileOutputStream output = new FileOutputStream(temporary)) {
                input.seek(offset);
                byte[] buffer = new byte[256 * 1024];
                long remaining = size;
                while (remaining > 0) {
                    int count = input.read(buffer, 0, (int) Math.min(buffer.length, remaining));
                    if (count < 0) throw new IOException("Discord 附件读取不完整");
                    output.write(buffer, 0, count);
                    digest.update(buffer, 0, count);
                    remaining -= count;
                }
            }
            if (!hash.equals(hex(digest.digest()))) throw new IllegalStateException("Discord 附件分块 SHA-256 校验失败");
        } catch (Exception error) {
            temporary.delete(); throw error;
        }
    }

    @PluginMethod
    public void appendObject(PluginCall call) {
        runIo(call, () -> {
            PendingObject object = pendingObject(call.getString("token"));
            byte[] bytes = Base64.decode(required(call.getString("data"), "对象分块", MAX_CHUNK_BYTES * 2), Base64.NO_WRAP);
            if (bytes.length > MAX_CHUNK_BYTES) throw new IllegalArgumentException("对象分块超过 1 MiB");
            synchronized (object) {
                if (object.written + bytes.length > object.size) throw new IllegalArgumentException("对象写入超过声明大小");
                object.output.write(bytes);
                object.digest.update(bytes);
                object.written += bytes.length;
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void commitObject(PluginCall call) {
        runIo(call, () -> {
            PendingObject object = pendingObject(call.getString("token"));
            pending.remove(object.token);
            synchronized (object) { object.output.flush(); object.output.close(); }
            if (object.written != object.size) {
                object.temporary.delete();
                throw new IllegalStateException("原生云对象大小校验失败");
            }
            String sha256 = hex(object.digest.digest());
            File root = jobRoot(object.jobId);
            File destination = new File(root, object.token + ".bin");
            if (!object.temporary.renameTo(destination)) throw new IllegalStateException("无法提交原生云对象");
            JSONObject entry = new JSONObject();
            entry.put("token", object.token);
            entry.put("name", object.name);
            entry.put("contentType", object.contentType);
            entry.put("manifest", object.manifest);
            entry.put("existingId", object.existingId);
            if (object.releaseId > 0) entry.put("releaseId", object.releaseId);
            entry.put("size", object.size);
            entry.put("sha256", sha256);
            try {
                appendStagedEntry(root, entry);
            } catch (Exception error) {
                destination.delete();
                throw error;
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void abortObject(PluginCall call) {
        runIo(call, () -> {
            PendingObject object = pending.remove(call.getString("token", ""));
            if (object != null) synchronized (object) {
                try { object.output.close(); } catch (Exception ignored) {}
                object.temporary.delete();
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void startJob(PluginCall call) {
        runIo(call, () -> {
            String jobId = safeId(call.getString("jobId"));
            File root = jobRoot(jobId);
            JSONObject existing = readJob(root);
            String existingStatus = existing.optString("status");
            if ("queued".equals(existingStatus) || "running".equals(existingStatus)) {
                call.resolve(jobSummary(existing));
                return;
            }
            JSONObject job = mutateJob(root, current -> {
                if (!"staging".equals(current.optString("status"))) {
                    throw new IllegalStateException("原生云任务已经启动或结束");
                }
                if (current.optInt("expectedTotal", 0) <= 0) {
                    // 兼容旧 Web 资源：旧调用方仍然在 startJob 前完成全部暂存。
                    sealLegacyJob(root, current);
                }
                current.put("status", "queued");
                current.put("error", JSONObject.NULL);
            });
            enqueueJob(jobId, job);
            call.resolve(jobSummary(job));
        });
    }

    private void enqueueJob(String jobId, JSONObject job) {
        Constraints constraints = new Constraints.Builder()
            .setRequiredNetworkType(job.optBoolean("wifiOnly") ? NetworkType.UNMETERED : NetworkType.CONNECTED)
            .setRequiresCharging(job.optBoolean("chargingOnly"))
            .build();
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(NativeCloudUploadWorker.class)
            .setInputData(new Data.Builder().putString("jobId", jobId).build())
            .setConstraints(constraints)
            .build();
        WorkManager manager = WorkManager.getInstance(getContext());
        manager.enqueueUniqueWork(JOB_WORK_PREFIX + jobId, ExistingWorkPolicy.KEEP, request);
        observeJob(manager, request, jobId);
    }

    @PluginMethod
    public void finishJobStaging(PluginCall call) {
        runIo(call, () -> {
            String jobId = safeId(call.getString("jobId"));
            JSONObject job = mutateJob(jobRoot(jobId), current -> {
                if (current.optBoolean("sealed", false)) return;
                ensureJobAccepting(current);
                int expectedTotal = current.optInt("expectedTotal", 0);
                if (expectedTotal <= 0) throw new IllegalStateException("旧版原生云任务不支持流水封口");
                validateStagedObjects(jobRoot(jobId), current, expectedTotal);
                current.put("sealed", true);
                current.put("lastStagedAt", System.currentTimeMillis());
            });
            signalStagingChanged();
            call.resolve(jobSummary(job));
        });
    }

    private void observeJob(WorkManager manager, OneTimeWorkRequest request, String jobId) {
        LiveData<WorkInfo> liveData = manager.getWorkInfoByIdLiveData(request.getId());
        final Observer<WorkInfo>[] holder = new Observer[1];
        holder[0] = info -> {
            if (info == null) return;
            NativeExecutors.ioLimited().execute(() -> {
                try {
                    JSObject status = jobSummary(readJob(jobRoot(jobId)));
                    getActivity().runOnUiThread(() -> notifyListeners("jobProgress", status, true));
                } catch (Exception ignored) {}
            });
            if (info.getState().isFinished()) liveData.removeObserver(holder[0]);
        };
        getActivity().runOnUiThread(() -> liveData.observe(getActivity(), holder[0]));
    }

    @PluginMethod
    public void getJob(PluginCall call) {
        runIo(call, () -> call.resolve(jobSummary(readJob(jobRoot(safeId(call.getString("jobId")))))));
    }

    @PluginMethod
    public void getLatestJob(PluginCall call) {
        runIo(call, () -> {
            String requestedProvider = call.getString("provider", "");
            String requestedKind = call.getString("kind", "upload");
            JSONObject latest = null;
            File[] roots = jobsRoot(getContext()).listFiles(File::isDirectory);
            if (roots != null) for (File candidate : roots) {
                try {
                    JSONObject value = readJob(candidate);
                    if (!requestedKind.equals(value.optString("kind", "upload"))) continue;
                    if (!requestedProvider.isBlank() && !requestedProvider.equals(value.optString("provider"))) continue;
                    if (latest == null || value.optLong("updatedAt") > latest.optLong("updatedAt")) latest = value;
                } catch (Exception ignored) {}
            }
            if (latest == null) { JSObject empty = new JSObject(); empty.put("present", false); call.resolve(empty); }
            else { JSObject result = jobSummary(latest); result.put("present", true); call.resolve(result); }
        });
    }

    @PluginMethod
    public void cancelJob(PluginCall call) {
        runIo(call, () -> {
            String jobId = safeId(call.getString("jobId"));
            File root = jobRoot(jobId);
            JSONObject result = requestCancellation(root);
            boolean cancelled = "cancelled".equals(result.optString("status"));
            JSObject response = new JSObject();
            response.put("cancelled", cancelled);
            response.put("status", result.optString("status"));
            if (!cancelled) {
                call.resolve(response);
                return;
            }
            // Persist cancellation before stopping WorkManager. Otherwise onStopped()
            // can abort an HTTP call first and the worker may misclassify that IOException
            // as a transient network failure and enqueue a retry.
            WorkManager.getInstance(getContext()).cancelUniqueWork(("restore".equals(readJob(root).optString("kind")) ? NativeCloudRestoreWorker.WORK_PREFIX : JOB_WORK_PREFIX) + jobId);
            new NativeSecretStore(getContext()).clear("cloud-job-" + jobId);
            call.resolve(response);
        });
    }

    static synchronized JSONObject requestCancellation(File root) throws Exception {
        JSONObject result = mutateJob(root, job -> {
            String status = job.optString("status");
            if ("completed".equals(status) || "failed".equals(status) || "cancelled".equals(status)) return;
            JSONArray objects = job.optJSONArray("objects");
            if (NativeCloudJobStore.usesPerObjectFiles(job) && job.optBoolean("manifestCommitStarted", false)) {
                job.put("status", "committing");
                return;
            } else if (objects != null) {
                for (int index = 0; index < objects.length(); index++) {
                    JSONObject object = objects.optJSONObject(index);
                    if (object != null && object.optBoolean("manifest") && object.optBoolean("uploaded")) {
                        job.put("manifestCommitStarted", true);
                        job.put("status", "committing");
                        return;
                    }
                }
            }
            if (!"committing".equals(status)) {
                job.put("status", "cancelled");
            }
        });
        signalStagingChanged();
        return result;
    }

    static long stagingRevision() {
        synchronized (STAGING_MONITOR) {
            return stagingRevision;
        }
    }

    static void awaitStagingChange(long revision, long timeoutMs) throws InterruptedException {
        synchronized (STAGING_MONITOR) {
            if (stagingRevision == revision) STAGING_MONITOR.wait(timeoutMs);
        }
    }

    private static void signalStagingChanged() {
        synchronized (STAGING_MONITOR) {
            stagingRevision++;
            STAGING_MONITOR.notifyAll();
        }
    }

    static synchronized void beginManifestCommit(File root) throws Exception {
        mutateJob(root, job -> {
            if ("cancelled".equals(job.optString("status"))) {
                throw new IllegalStateException("云备份已取消");
            }
            if (!job.optBoolean("sealed", false)) {
                throw new IllegalStateException("云备份对象尚未封口，不能提交最终清单");
            }
            List<JSONObject> objects = NativeCloudJobStore.readAll(root, job);
            JSONObject manifest = null;
            for (JSONObject entry : objects) {
                if (entry.optBoolean("manifest")) manifest = entry;
                else if (!entry.optBoolean("uploaded", false)) {
                    throw new IllegalStateException("内容对象尚未全部上传，不能提交最终清单");
                }
            }
            if (manifest == null) throw new IllegalStateException("原生云任务缺少最终清单");
            job.put("manifestCommitStarted", true);
            job.put("status", "committing");
        });
    }

    static File jobsRoot(android.content.Context context) {
        File root = new File(context.getFilesDir(), "srl-cloud-jobs");
        if (!root.exists()) root.mkdirs();
        return root;
    }

    static synchronized JSONObject readJob(File root) throws Exception {
        try { return readJobFile(new File(root, "job.json")); }
        catch (Exception primaryError) {
            File backup = new File(root, "job.json.bak");
            if (!backup.isFile()) throw primaryError;
            return readJobFile(backup);
        }
    }

    private static JSONObject readJobFile(File file) throws Exception {
        if (!file.isFile() || file.length() > 16L * 1024L * 1024L) throw new IllegalStateException("原生云任务清单不存在或异常");
        byte[] bytes = new byte[(int) file.length()];
        try (FileInputStream input = new FileInputStream(file)) {
            int offset = 0;
            while (offset < bytes.length) { int read = input.read(bytes, offset, bytes.length - offset); if (read < 0) break; offset += read; }
        }
        return new JSONObject(new String(bytes, StandardCharsets.UTF_8));
    }

    static synchronized void writeJob(File root, JSONObject job) throws Exception {
        File temporary = new File(root, "job.json.tmp");
        try (FileOutputStream output = new FileOutputStream(temporary)) {
            output.write(job.toString().getBytes(StandardCharsets.UTF_8));
            output.getFD().sync();
        }
        File target = new File(root, "job.json");
        File backup = new File(root, "job.json.bak");
        if (target.exists()) {
            if (backup.exists() && !backup.delete()) throw new IllegalStateException("无法轮换原生云任务清单");
            if (!target.renameTo(backup)) throw new IllegalStateException("无法备份原生云任务清单");
        }
        if (!temporary.renameTo(target)) {
            if (backup.exists()) backup.renameTo(target);
            throw new IllegalStateException("无法提交原生云任务清单");
        }
        backup.delete();
    }

    static synchronized JSONObject mutateJob(File root, JobMutation mutation) throws Exception {
        JSONObject job = readJob(root);
        mutation.apply(job);
        job.put("updatedAt", System.currentTimeMillis());
        writeJob(root, job);
        return job;
    }

    private void appendStagedEntry(File root, JSONObject entry) throws Exception {
        synchronized (NativeCloudTransferPlugin.class) {
            JSONObject job = readJob(root);
            ensureJobAccepting(job);
            if (NativeCloudJobStore.usesPerObjectFiles(job)) {
                NativeCloudJobStore.append(root, job, entry);
                job.put("lastStagedAt", System.currentTimeMillis());
                try {
                    writeJob(root, job);
                } catch (Exception error) {
                    NativeCloudJobStore.rollbackLastAppend(root, job, entry);
                    throw error;
                }
            } else {
                JSONArray objects = job.getJSONArray("objects");
                int expectedTotal = job.optInt("expectedTotal", 0);
                if (expectedTotal > 0 && objects.length() >= expectedTotal) {
                    throw new IllegalStateException("原生云任务暂存对象超过预期数量");
                }
                for (int index = 0; index < objects.length(); index++) {
                    JSONObject existing = objects.getJSONObject(index);
                    if (entry.getString("name").equals(existing.optString("name"))) {
                        throw new IllegalStateException("原生云任务包含重复对象名称");
                    }
                    if (entry.optBoolean("manifest") && existing.optBoolean("manifest")) {
                        throw new IllegalStateException("原生云任务只能暂存一个最终清单");
                    }
                }
                objects.put(entry);
                if (expectedTotal <= 0) job.put("total", objects.length());
                job.put("lastStagedAt", System.currentTimeMillis());
                writeJob(root, job);
            }
        }
        signalStagingChanged();
    }

    private static void ensureJobAccepting(JSONObject job) {
        String status = job.optString("status");
        if (
            (!"staging".equals(status) && !"queued".equals(status) && !"running".equals(status))
            || job.optBoolean("sealed", false)
        ) {
            throw new IllegalStateException("原生云任务已结束暂存");
        }
    }

    private static void validateStagedObjects(File root, JSONObject job, int expectedTotal) throws Exception {
        if (NativeCloudJobStore.usesPerObjectFiles(job)) {
            NativeCloudJobStore.validate(root, job, expectedTotal);
            return;
        }
        validateStagedObjects(job, expectedTotal);
    }

    private static void validateStagedObjects(JSONObject job, int expectedTotal) throws Exception {
        JSONArray objects = job.getJSONArray("objects");
        if (objects.length() != expectedTotal) {
            throw new IllegalStateException(
                "原生云任务暂存数量不完整：" + objects.length() + " / " + expectedTotal
            );
        }
        int manifests = 0;
        for (int index = 0; index < objects.length(); index++) {
            if (objects.getJSONObject(index).optBoolean("manifest")) manifests++;
        }
        if (manifests != 1) throw new IllegalStateException("原生云任务必须且只能有一个最终清单");
    }

    private static void sealLegacyJob(File root, JSONObject job) throws Exception {
        int count = NativeCloudJobStore.objectCount(job);
        validateStagedObjects(root, job, count);
        job.put("expectedTotal", count);
        job.put("total", count);
        job.put("sealed", true);
        job.put("lastStagedAt", System.currentTimeMillis());
    }

    private JSObject jobSummary(JSONObject job) {
        JSObject result = new JSObject();
        for (String key : new String[]{"id", "kind", "provider", "status", "error", "resultId", "resultName", "automatic"})
            if (job.has(key)) result.put(key, job.opt(key));
        result.put("completed", job.optInt("completed", 0));
        result.put("total", job.optInt("total", 0));
        result.put("updatedAt", job.optLong("updatedAt", 0));
        result.put("uploadedBytes", job.optLong("uploadedBytes", 0));
        long totalBytes = job.optLong("totalBytes", 0L);
        JSONArray stagedObjects = job.optJSONArray("objects");
        if (!NativeCloudJobStore.usesPerObjectFiles(job) && stagedObjects != null) {
            for (int index = 0; index < stagedObjects.length(); index++) {
                long size = stagedObjects.optJSONObject(index) == null ? 0L : stagedObjects.optJSONObject(index).optLong("size", 0L);
                if (size > 0L && totalBytes <= Long.MAX_VALUE - size) totalBytes += size;
            }
        }
        result.put("totalBytes", totalBytes);
        result.put("httpRequestCount", job.optLong("httpRequestCount", 0));
        result.put("retryCount", job.optLong("retryCount", 0));
        result.put("networkMs", job.optLong("networkMs", 0));
        result.put("verifyMs", job.optLong("verifyMs", 0));
        return result;
    }

    private File jobRoot(String jobId) { return new File(jobsRoot(getContext()), jobId); }
    private void deleteExpiredJobs() {
        long cutoff = System.currentTimeMillis() - 7L * 24L * 60L * 60L * 1000L;
        File[] roots = jobsRoot(getContext()).listFiles(File::isDirectory);
        if (roots == null) return;
        for (File candidate : roots) {
            try {
                JSONObject value = readJob(candidate);
                String status = value.optString("status");
                if (value.optLong("updatedAt", candidate.lastModified()) < cutoff
                    && !"queued".equals(status) && !"running".equals(status) && !"committing".equals(status)) {
                    new NativeSecretStore(getContext()).clear("cloud-job-" + candidate.getName());
                    deleteRecursively(candidate);
                }
            } catch (Exception ignored) {}
        }
    }
    private void deleteRecursively(File file) { File[] children = file.listFiles(); if (children != null) for (File child : children) deleteRecursively(child); file.delete(); }
    private String safeId(String value) { if (value == null || !value.matches("[a-f0-9-]{36}")) throw new IllegalArgumentException("云任务编号无效"); return value; }
    private String provider(String value) { if (!"github".equals(value) && !"webdav".equals(value)) throw new IllegalArgumentException("云端类型无效"); return value; }
    private String appCredentialIdentifier(String value) {
        if (value == null || !value.matches("app:[a-z0-9][a-z0-9._:-]{0,127}")) {
            throw new IllegalArgumentException("本机凭据标识无效");
        }
        return value;
    }
    private String requiredHash(String value) { if (value == null || !value.matches("(?i)[a-f0-9]{64}")) throw new IllegalArgumentException("原生对象哈希无效"); return value.toLowerCase(Locale.ROOT); }
    private String required(String value, String label, int max) { if (value == null || value.isBlank() || value.length() > max) throw new IllegalArgumentException(label + "无效"); return value; }
    private PendingObject pendingObject(String token) { PendingObject value = token == null ? null : pending.get(token); if (value == null) throw new IllegalArgumentException("云对象写入令牌已失效"); return value; }
    private JSONObject sourceSegment(String sourceHash, long offset, long size) throws Exception {
        if (offset < 0 || size < 0 || offset > Long.MAX_VALUE - size) {
            throw new IllegalArgumentException("原生对象切片范围无效");
        }
        File source = NativeLibraryPlugin.objectFile(getContext(), sourceHash);
        if (!source.isFile() || offset + size > source.length()) return null;
        JSONObject segment = new JSONObject();
        segment.put("sourceHash", sourceHash);
        segment.put("offset", offset);
        segment.put("size", size);
        return segment;
    }

    private JSObject stageSourceEntry(PluginCall call, File root, String name, JSONArray segments, long size) throws Exception {
        JSObject result = new JSObject();
        for (int index = 0; index < segments.length(); index++) {
            if (segments.isNull(index)) {
                result.put("staged", false);
                return result;
            }
        }
        if (size < 0 || size > MAX_OBJECT_BYTES) throw new IllegalArgumentException("原生对象大小无效");
        String baseName = NativeCloudObjectKey.baseName(name);
        String expectedHash = baseName.startsWith("srl-chunk--sha256-")
            ? requiredHash(baseName.substring("srl-chunk--sha256-".length())) : "";
        if (expectedHash.isBlank()) throw new IllegalArgumentException("内容对象名称不符合 SHA-256 规则");
        String token = UUID.randomUUID().toString();
        JSONObject entry = new JSONObject();
        entry.put("token", token);
        entry.put("name", name);
        entry.put("contentType", call.getString("contentType", "application/octet-stream"));
        entry.put("manifest", false);
        entry.put("existingId", call.getString("existingId", ""));
        long releaseId = NativeBridgeNumber.boundedOrDefault(
            call.getData().opt("releaseId"), -1L, 1L,
            NativeBridgeNumber.MAX_SAFE_INTEGER, "GitHub Release ID 无效"
        );
        if (releaseId > 0) entry.put("releaseId", releaseId);
        entry.put("size", size);
        entry.put("sha256", expectedHash);
        JSONObject source = new JSONObject();
        source.put("kind", segments.length() == 1 ? "range" : "concat");
        source.put("segments", segments);
        entry.put("source", source);
        appendStagedEntry(root, entry);
        result.put("staged", true);
        return result;
    }

    private void runIo(PluginCall call, CheckedAction action) { NativeExecutors.ioSerial().execute(() -> { try { action.run(); } catch (Exception error) {
        String message = error.getMessage() == null ? "原生云任务失败" : error.getMessage();
        if (error instanceof CloudHttpStatusException) {
            call.reject(message, "HTTP_" + ((CloudHttpStatusException) error).status, error);
        } else {
            call.reject(message, error);
        }
    } }); }

    private static final class PendingObject {
        final String jobId, token, name, contentType, existingId; final boolean manifest; final long size, releaseId; final File temporary; final FileOutputStream output; final MessageDigest digest; long written;
        PendingObject(String jobId, String token, String name, String contentType, boolean manifest, String existingId, long size, long releaseId, File temporary, FileOutputStream output, MessageDigest digest) {
            this.jobId=jobId; this.token=token; this.name=name; this.contentType=contentType; this.manifest=manifest; this.existingId=existingId; this.size=size; this.releaseId=releaseId; this.temporary=temporary; this.output=output; this.digest=digest;
        }
    }
    @FunctionalInterface interface JobMutation { void apply(JSONObject job) throws Exception; }
    @FunctionalInterface private interface CheckedAction { void run() throws Exception; }
}
