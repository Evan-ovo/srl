package buzz.jixiangruyi1207.srl;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.Build;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.work.ForegroundInfo;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.Future;
import java.util.concurrent.CopyOnWriteArrayList;
import okhttp3.Call;
import okhttp3.MediaType;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okio.BufferedSink;
import org.json.JSONArray;
import org.json.JSONObject;

/** 持久、受网络/充电约束的原生上传器；内容对象可边暂存边上传，最终清单仍严格最后提交。 */
public class NativeCloudUploadWorker extends Worker {
    private static final String CHANNEL = "srl_cloud_backup";
    private static final int NOTIFICATION_ID = 2107;
    private static final long STAGING_IDLE_TIMEOUT_MS = 15L * 60L * 1000L;
    private static final String RETRY_LIMIT_MESSAGE = "云备份任务的网络重试次数已达到上限（最多运行 3 次）";
    private File root;
    private String jobId;
    private String provider;
    private JSONObject config;
    private String secret;
    private int completed;
    private int total;
    private long uploadedBytes;
    private long httpRequestCount;
    private long retryCount;
    private long networkMs;
    private long verifyMs;
    private long lastForegroundAt;
    private int lastForegroundCompleted;
    private boolean manifestCommitStarted;
    private final CopyOnWriteArrayList<Call> activeCalls = new CopyOnWriteArrayList<>();
    private final CopyOnWriteArrayList<Future<Void>> activeFutures = new CopyOnWriteArrayList<>();

    public NativeCloudUploadWorker(@NonNull Context context, @NonNull WorkerParameters parameters) { super(context, parameters); }

    @Override public void onStopped() {
        for (Call call : activeCalls) call.cancel();
        for (Future<Void> future : activeFutures) future.cancel(true);
        activeCalls.clear();
        activeFutures.clear();
        super.onStopped();
    }

    private void throwIfCancelled() throws Exception {
        if (isStopped() || Thread.currentThread().isInterrupted()) throw new IllegalStateException("云备份已取消");
        if (root != null) {
            JSONObject latest = NativeCloudTransferPlugin.readJob(root);
            if ("cancelled".equals(latest.optString("status"))) throw new IllegalStateException("云备份已取消");
        }
    }

    private void cancellableSleep(long millis) throws Exception {
        long deadline = System.currentTimeMillis() + millis;
        while (true) {
            throwIfCancelled();
            long remaining = deadline - System.currentTimeMillis();
            if (remaining <= 0) return;
            Thread.sleep(Math.min(100L, remaining));
        }
    }

    @NonNull @Override
    public Result doWork() {
        boolean clearJobSecret = true;
        jobId = getInputData().getString("jobId");
        if (jobId == null || !jobId.matches("[a-f0-9-]{36}")) return Result.failure();
        root = new File(NativeCloudTransferPlugin.jobsRoot(getApplicationContext()), jobId);
        try {
            JSONObject initial = NativeCloudTransferPlugin.readJob(root);
            if ("cancelled".equals(initial.optString("status"))) return Result.failure();
            provider = initial.getString("provider");
            config = initial.getJSONObject("config");
            NativeCloudJobStore.reconcileCompleted(root, initial);
            completed = initial.optInt("completed", 0);
            total = initial.optInt("total", initial.optInt("expectedTotal", 0));
            uploadedBytes = initial.optLong("uploadedBytes", 0);
            httpRequestCount = initial.optLong("httpRequestCount", 0);
            retryCount = initial.optLong("retryCount", 0);
            networkMs = initial.optLong("networkMs", 0);
            verifyMs = initial.optLong("verifyMs", 0);
            manifestCommitStarted = initial.optBoolean("manifestCommitStarted", false);

            NativeSecretStore secrets = new NativeSecretStore(getApplicationContext());
            secret = secrets.read("cloud-job-" + jobId);
            if (secret == null || secret.isBlank()) secret = secrets.read("cloud-" + provider);
            if (secret == null || secret.isBlank()) throw new IllegalStateException("Android 安全凭据已丢失，请回到应用重新保存云端配置");

            persistStatus("running", null, null, null);
            setForegroundAsync(foreground("正在接收并上传原生云备份…", completed, total)).get();

            JSONObject manifest = drainContentsUntilSealed();
            UploadResult result;
            if (manifest.optBoolean("uploaded", false)) {
                result = new UploadResult(manifest.optString("resultId", manifest.getString("name")));
            } else {
                NativeCloudTransferPlugin.beginManifestCommit(root);
                manifestCommitStarted = true;
                setForegroundAsync(foreground("正在提交最终清单…", completed, total)).get();
                result = uploadWithRetry(manifest);
                markCompleted(manifest, result);
            }

            persistStatus("completed", null, result.id, manifest.getString("name"));
            notifyFinished("云备份已完成", manifest.getString("name"));
            NativePrivacyShortcuts.updateBackupStatus(getApplicationContext(), true);
            return Result.success();
        } catch (Exception error) {
            boolean cancelled = false;
            boolean retryable = isStopped()
                || (hasCause(error, IOException.class) && !hasCause(error, LocalSourceException.class));
            try {
                JSONObject latest = NativeCloudTransferPlugin.readJob(root);
                cancelled = "cancelled".equals(latest.optString("status"));
                if (!cancelled && retryable && NativeCloudRetryPolicy.shouldRetry(getRunAttemptCount())) {
                    clearJobSecret = false;
                    persistStatus("queued", rootMessage(error), null, null);
                    notifyFinished("云备份等待网络恢复", rootMessage(error));
                    return Result.retry();
                }
                if (!cancelled) {
                    String message = retryable
                        ? RETRY_LIMIT_MESSAGE + "：" + rootMessage(error)
                        : rootMessage(error);
                    persistStatus("failed", message, null, null);
                    notifyFinished("云备份未完成", message);
                    NativePrivacyShortcuts.updateBackupStatus(getApplicationContext(), false);
                    return Result.failure();
                }
            } catch (Exception ignored) {}
            notifyFinished(cancelled ? "云备份已取消" : "云备份未完成", rootMessage(error));
            NativePrivacyShortcuts.updateBackupStatus(getApplicationContext(), false);
            return Result.failure();
        } finally {
            if (clearJobSecret) new NativeSecretStore(getApplicationContext()).clear("cloud-job-" + jobId);
        }
    }

    private JSONObject drainContentsUntilSealed() throws Exception {
        int nextObjectIndex = 0;
        JSONObject manifest = null;
        while (true) {
            long observedStagingRevision = NativeCloudTransferPlugin.stagingRevision();
            if (isStopped() || Thread.currentThread().isInterrupted()) {
                throw new IllegalStateException("云备份已取消");
            }
            JSONObject latest = NativeCloudTransferPlugin.readJob(root);
            if ("cancelled".equals(latest.optString("status"))) throw new IllegalStateException("云备份已取消");
            total = latest.optInt("total", total);
            completed = latest.optInt("completed", completed);

            int stagedCount = NativeCloudJobStore.objectCount(latest);
            List<JSONObject> entries = NativeCloudJobStore.readRange(
                root,
                latest,
                nextObjectIndex,
                64
            );
            nextObjectIndex += entries.size();
            List<JSONObject> pendingContents = new ArrayList<>();
            for (JSONObject entry : entries) {
                if (entry.optBoolean("manifest")) {
                    manifest = entry;
                } else if (!entry.optBoolean("uploaded", false)) {
                    pendingContents.add(entry);
                }
            }

            if (!pendingContents.isEmpty()) {
                List<Future<Void>> futures = new ArrayList<>();
                try {
                    for (JSONObject entry : pendingContents) {
                        throwIfCancelled();
                        Future<Void> future = NativeExecutors.network().submit((Callable<Void>) () -> {
                            throwIfCancelled();
                            UploadResult result = uploadWithRetry(entry);
                            throwIfCancelled();
                            markCompleted(entry, result);
                            return null;
                        });
                        futures.add(future);
                        activeFutures.add(future);
                    }
                    for (Future<Void> future : futures) {
                        throwIfCancelled();
                        future.get();
                        activeFutures.remove(future);
                    }
                } finally {
                    for (Future<Void> future : futures) {
                        if (!future.isDone()) future.cancel(true);
                        activeFutures.remove(future);
                    }
                }
                continue;
            }

            int plannedTotal = latest.optInt("expectedTotal", 0);
            if (!latest.optBoolean("sealed", false) && plannedTotal > 0 && stagedCount == plannedTotal
                && manifest != null && nextObjectIndex >= stagedCount) {
                latest = NativeCloudTransferPlugin.mutateJob(root, job -> {
                    NativeCloudJobStore.validate(root, job, plannedTotal);
                    job.put("sealed", true);
                });
            }
            if (latest.optBoolean("sealed", false)) {
                int expectedTotal = latest.optInt("expectedTotal", total);
                if (expectedTotal > 0 && stagedCount != expectedTotal) {
                    throw new IllegalStateException(
                        "原生云任务封口后的对象数量不完整：" + stagedCount + " / " + expectedTotal
                    );
                }
                if (nextObjectIndex < stagedCount) continue;
                if (manifest == null) throw new IllegalStateException("原生云任务缺少最终清单");
                return manifest;
            }

            long lastStagedAt = latest.optLong(
                "lastStagedAt",
                latest.optLong("createdAt", System.currentTimeMillis())
            );
            if (System.currentTimeMillis() - lastStagedAt > STAGING_IDLE_TIMEOUT_MS) {
                throw new IllegalStateException("原生云任务等待网页暂存超时");
            }
            NativeCloudTransferPlugin.awaitStagingChange(observedStagingRevision, 1_000L);
        }
    }

    private UploadResult uploadWithRetry(JSONObject entry) throws Exception {
        Exception last = null;
        for (int attempt = 1; attempt <= 3; attempt++) {
            if (isStopped()) throw new IllegalStateException("云备份已取消");
            try {
                return "github".equals(provider) ? uploadGitHub(entry) : uploadWebDav(entry);
            } catch (Exception error) {
                last = error;
                if (hasCause(error, LocalSourceException.class)) throw error;
                if (hasHttpStatus(error, 401)) {
                    new NativeSecretStore(getApplicationContext()).invalidateCredential(
                        "cloud-" + provider, "cloud-" + provider + "-invalid"
                    );
                    throw error;
                }
                if (attempt < 3) {
                    addMetric("retryCount", 1L);
                    cancellableSleep(attempt * 800L);
                }
            }
        }
        throw new IllegalStateException(entry.optBoolean("manifest")
            ? "最终快照清单连续 3 次提交失败；旧备份没有受到影响"
            : "对象 " + entry.getString("name") + " 连续 3 次上传或校验失败；未提交快照清单", last);
    }

    private UploadResult uploadGitHub(JSONObject entry) throws Exception {
        String owner = Uri.encode(config.getString("owner"));
        String repository = Uri.encode(config.getString("repository"));
        long releaseId = entry.optLong("releaseId", config.optLong("releaseId", -1L));
        if (releaseId <= 0) throw new IllegalStateException("GitHub 对象缺少目标 container");
        String api = "https://api.github.com/repos/" + owner + "/" + repository;
        String existingId = entry.optString("existingId", "");
        if (!existingId.isBlank()) request("DELETE", api + "/releases/assets/" + existingId, githubHeaders(), null, 0L, 404);
        String uploadUrl = "https://uploads.github.com/repos/" + owner + "/" + repository + "/releases/" + releaseId + "/assets?name=" + Uri.encode(entry.getString("name"));
        HttpResult uploaded = request("POST", uploadUrl, githubHeaders(), objectBody(entry), entry.getLong("size"), -1);
        if (uploaded.code == 401) throw new CloudHttpException(401, "GitHub 凭据已失效");
        boolean uploadedNow = uploaded.code >= 200 && uploaded.code < 300;
        String id;
        long verifyStarted = System.nanoTime();
        if (uploadedNow) {
            JSONObject uploadResponse = new JSONObject(uploaded.body);
            id = uploadResponse.get("id").toString();
            if (isCompletedGitHubAsset(uploadResponse, entry.getLong("size"))) {
                addMetric("verifyMs", elapsedMs(verifyStarted));
                return new UploadResult(id);
            }
        } else if (uploaded.code == 422) {
            id = findExistingGitHubAsset(api, releaseId, entry.getString("name"), entry.getLong("size"));
            if (id == null) {
                throw new IllegalStateException("GitHub 同名对象未完成上传或大小不一致；未计为上传成功，未覆盖远端对象");
            }
        } else {
            throw new IllegalStateException("GitHub 上传失败（" + uploaded.code + "）：" + uploaded.body);
        }
        try {
            for (int poll = 0; poll < 4; poll++) {
                HttpResult confirmed = request("GET", api + "/releases/assets/" + id, githubHeaders(), null, 0L, 404);
                if (confirmed.code == 200 && isCompletedGitHubAsset(new JSONObject(confirmed.body), entry.getLong("size"))) return new UploadResult(id);
                if (poll < 3) cancellableSleep((poll + 1) * 600L);
            }
        } finally {
            addMetric("verifyMs", elapsedMs(verifyStarted));
        }
        if (uploadedNow) {
            request("DELETE", api + "/releases/assets/" + id, githubHeaders(), null, 0L, 404);
        }
        throw new IllegalStateException("GitHub 已接收请求，但附件未完成上传或远端大小确认失败；未计为上传成功");
    }

    static boolean isCompletedGitHubAsset(JSONObject asset, long expectedSize) {
        return "uploaded".equals(asset.optString("state", ""))
            && asset.optLong("size", -1L) == expectedSize;
    }

    private String findExistingGitHubAsset(
        String api,
        long releaseId,
        String name,
        long expectedSize
    ) throws Exception {
        for (int page = 1; page <= 100; page++) {
            HttpResult response = request(
                "GET",
                api + "/releases/" + releaseId + "/assets?per_page=100&page=" + page,
                githubHeaders(),
                null,
                0L,
                -1
            );
            if (response.code < 200 || response.code >= 300) {
                throw new CloudHttpException(response.code, "GitHub 对象索引读取失败");
            }
            JSONArray assets = new JSONArray(response.body);
            for (int index = 0; index < assets.length(); index++) {
                JSONObject asset = assets.getJSONObject(index);
                if (name.equals(asset.optString("name")) && isCompletedGitHubAsset(asset, expectedSize)) {
                    return asset.get("id").toString();
                }
            }
            if (assets.length() < 100) return null;
        }
        return null;
    }

    private UploadResult uploadWebDav(JSONObject entry) throws Exception {
        StringBuilder url = new StringBuilder(config.getString("baseUrl").replaceAll("/+$", ""));
        for (String segment : config.getString("folder").split("/")) if (!segment.isBlank()) url.append('/').append(Uri.encode(segment));
        for (String segment : entry.getString("name").split("/")) if (!segment.isBlank()) url.append('/').append(Uri.encode(segment));
        java.util.Map<String,String> headers = new java.util.HashMap<>();
        String auth = android.util.Base64.encodeToString((config.getString("username") + ":" + secret).getBytes(StandardCharsets.UTF_8), android.util.Base64.NO_WRAP);
        headers.put("Authorization", "Basic " + auth);
        HttpResult uploaded = request("PUT", url.toString(), headers, objectBody(entry), entry.getLong("size"), -1);
        if (uploaded.code == 401) throw new CloudHttpException(401, "Koofr 应用密码已失效");
        if (uploaded.code < 200 || uploaded.code >= 300) throw new IllegalStateException("WebDAV 上传失败（" + uploaded.code + "）");
        long verifyStarted = System.nanoTime();
        try {
            headers.put("Range", "bytes=0-0");
            HttpResult range = request("GET", url.toString(), headers, null, 0L, -1);
            if (range.code == 401) throw new CloudHttpException(401, "Koofr 应用密码已失效");
            long confirmed = parseContentRange(range.contentRange);
            if (range.code != 206 || confirmed < 0) {
                headers.remove("Range");
                HttpResult head = request("HEAD", url.toString(), headers, null, 0L, -1);
                if (head.code == 401) throw new CloudHttpException(401, "Koofr 应用密码已失效");
                confirmed = head.contentLength;
            }
            if (confirmed != entry.getLong("size")) {
                headers.remove("Range");
                request("DELETE", url.toString(), headers, null, 0L, 404);
                throw new IllegalStateException("WebDAV 上传后的文件大小不一致，已删除不完整对象");
            }
        } finally {
            headers.remove("Range");
            addMetric("verifyMs", elapsedMs(verifyStarted));
        }
        return new UploadResult(entry.getString("name"));
    }

    private java.util.Map<String,String> githubHeaders() {
        java.util.Map<String,String> headers = new java.util.HashMap<>();
        headers.put("Authorization", "Bearer " + secret);
        headers.put("Accept", "application/vnd.github+json");
        headers.put("X-GitHub-Api-Version", "2022-11-28");
        headers.put("User-Agent", "SRL-Native-Android/" + appVersion());
        return headers;
    }

    private HttpResult request(String method, String url, java.util.Map<String,String> headers, RequestBody body, long bodySize, int acceptedExtra) throws Exception {
        long started = System.nanoTime();
        Request.Builder request = new Request.Builder().url(url).method(method, body);
        for (java.util.Map.Entry<String,String> header : headers.entrySet()) request.header(header.getKey(), header.getValue());
        Call call = NativeHttpClients.CLOUD.newCall(request.build());
        boolean requestCompleted = false;
        activeCalls.add(call);
        try {
            throwIfCancelled();
            try (Response response = call.execute()) {
            throwIfCancelled();
            int code = response.code();
            ResponseBody responseBody = response.body();
            String responseText = responseBody == null ? "" : readText(responseBody.byteStream(), 1024 * 1024);
            long contentLength = parseLongHeader(response.header("Content-Length"));
            HttpResult result = new HttpResult(code, responseText, response.header("Content-Range"), contentLength);
            if (acceptedExtra >= 0 && code != acceptedExtra && (code < 200 || code >= 300)) {
                throw new CloudHttpException(code, "云端请求失败：" + responseText);
            }
            requestCompleted = true;
            return result;
            }
        } finally {
            activeCalls.remove(call);
            addMetric("httpRequestCount", 1L);
            addMetric("networkMs", elapsedMs(started));
            if (body != null && requestCompleted) addMetric("uploadedBytes", bodySize);
        }
    }

    private RequestBody objectBody(JSONObject entry) throws Exception {
        final String contentType = entry.getString("contentType");
        final long size = entry.getLong("size");
        final JSONObject source = entry.optJSONObject("source");
        final File inline = source == null ? objectFile(entry) : null;
        if (source == null && (inline == null || !inline.isFile() || inline.length() != size)) {
            throw new IllegalStateException("原生 inline 对象已丢失或大小不一致");
        }
        return new RequestBody() {
            @Override public MediaType contentType() { return MediaType.parse(contentType); }
            @Override public long contentLength() { return size; }
            @Override public void writeTo(@NonNull BufferedSink sink) throws IOException {
                try {
                    MessageDigest digest = MessageDigest.getInstance("SHA-256");
                    long written = 0L;
                    byte[] buffer = new byte[256 * 1024];
                    if (source == null) {
                        try (InputStream input = new FileInputStream(inline)) {
                            int count;
                            while ((count = input.read(buffer)) >= 0) {
                                if (isStopped()) throw new IOException("云备份已取消");
                                sink.write(buffer, 0, count);
                                digest.update(buffer, 0, count);
                                written += count;
                            }
                        }
                    } else {
                        JSONArray segments = source.getJSONArray("segments");
                        for (int index = 0; index < segments.length(); index++) {
                            JSONObject segment = segments.getJSONObject(index);
                            File libraryFile = NativeLibraryPlugin.objectFile(getApplicationContext(), segment.getString("sourceHash"));
                            long remaining = segment.getLong("size");
                            try (RandomAccessFile input = new RandomAccessFile(libraryFile, "r")) {
                                input.seek(segment.getLong("offset"));
                                while (remaining > 0) {
                                    if (isStopped()) throw new IOException("云备份已取消");
                                    int count = input.read(buffer, 0, (int)Math.min(buffer.length, remaining));
                                    if (count < 0) throw new LocalSourceException("NativeLibrary 对象来源在上传期间被截断");
                                    sink.write(buffer, 0, count);
                                    digest.update(buffer, 0, count);
                                    remaining -= count;
                                    written += count;
                                }
                            }
                        }
                    }
                    String expectedHash = entry.optString("sha256", "");
                    String actualHash = hex(digest.digest());
                    if (written != size || (!expectedHash.isBlank() && !expectedHash.equals(actualHash))) {
                        throw new LocalSourceException("NativeLibrary 流的大小或 SHA-256 与对象计划不一致");
                    }
                } catch (IOException error) {
                    if (error instanceof java.io.FileNotFoundException) throw new LocalSourceException("NativeLibrary 对象来源已丢失", error);
                    throw error;
                } catch (Exception error) {
                    throw new LocalSourceException("无法读取 NativeLibrary 对象来源", error);
                }
            }
        };
    }

    private String hex(byte[] bytes) {
        StringBuilder value = new StringBuilder();
        for (byte item : bytes) value.append(String.format(java.util.Locale.ROOT, "%02x", item));
        return value.toString();
    }

    private String readText(InputStream input, int limit) throws Exception {
        try (InputStream source = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192]; int count, total = 0;
            while ((count = source.read(buffer)) >= 0 && total < limit) { int kept = Math.min(count, limit - total); output.write(buffer, 0, kept); total += kept; }
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    private File objectFile(JSONObject entry) { return new File(root, entry.optString("token") + ".bin"); }
    private String appVersion() {
        try {
            return getApplicationContext().getPackageManager()
                .getPackageInfo(getApplicationContext().getPackageName(), 0).versionName;
        } catch (Exception ignored) {
            return "unknown";
        }
    }
    private long parseLongHeader(String value) { if (value == null) return -1; try { return Long.parseLong(value); } catch (NumberFormatException ignored) { return -1; } }
    private long parseContentRange(String value) { if (value == null) return -1; try { return Long.parseLong(value.substring(value.lastIndexOf('/') + 1)); } catch (Exception ignored) { return -1; } }

    private synchronized void markCompleted(JSONObject entry, UploadResult result) throws Exception {
        String name = entry.getString("name");
        JSONObject latest = NativeCloudTransferPlugin.mutateJob(root, current -> {
            if ("cancelled".equals(current.optString("status"))) {
                throw new IllegalStateException("云备份已取消");
            }
            NativeCloudJobStore.markUploaded(root, current, entry, result == null ? null : result.id);
            current.put("currentObject", name);
            applyMetrics(current);
        });
        completed = latest.optInt("completed", completed);
        total = latest.optInt("total", total);
        objectFile(entry).delete();

        setProgressAsync(new androidx.work.Data.Builder()
            .putString("jobId", jobId)
            .putInt("completed", completed)
            .putInt("total", total)
            .build());
        long now = System.currentTimeMillis();
        int onePercent = total > 0 ? Math.max(1, (int)Math.ceil(total / 100.0)) : Integer.MAX_VALUE;
        if (completed >= total || now - lastForegroundAt >= 350 || completed - lastForegroundCompleted >= onePercent) {
            setForegroundAsync(foreground("正在上传 " + name, completed, total));
            lastForegroundAt = now;
            lastForegroundCompleted = completed;
        }
    }

    private synchronized void persistStatus(
        String status,
        String error,
        String resultId,
        String resultName
    ) throws Exception {
        JSONObject latest = NativeCloudTransferPlugin.mutateJob(root, current -> {
            if ("cancelled".equals(current.optString("status")) && !"cancelled".equals(status)) {
                throw new IllegalStateException("云备份已取消");
            }
            current.put("status", status);
            if (current.optBoolean("manifestCommitStarted", false)
                && !"completed".equals(status) && !"failed".equals(status) && !"cancelled".equals(status)) {
                current.put("status", "committing");
            }
            current.put("error", error == null ? JSONObject.NULL : error);
            if (resultId != null) current.put("resultId", resultId);
            if (resultName != null) current.put("resultName", resultName);
            applyMetrics(current);
        });
        completed = latest.optInt("completed", completed);
        total = latest.optInt("total", total);
    }

    private void applyMetrics(JSONObject target) throws Exception {
        target.put("uploadedBytes", uploadedBytes);
        target.put("httpRequestCount", httpRequestCount);
        target.put("retryCount", retryCount);
        target.put("networkMs", networkMs);
        target.put("verifyMs", verifyMs);
    }

    private synchronized void addMetric(String key, long value) {
        if (value <= 0) return;
        switch (key) {
            case "uploadedBytes": uploadedBytes += value; break;
            case "httpRequestCount": httpRequestCount += value; break;
            case "retryCount": retryCount += value; break;
            case "networkMs": networkMs += value; break;
            case "verifyMs": verifyMs += value; break;
            default: break;
        }
    }
    private long elapsedMs(long startedNanos) { return Math.max(0L, (System.nanoTime() - startedNanos) / 1_000_000L); }

    private ForegroundInfo foreground(String text, int completed, int total) {
        ensureChannel();
        PendingIntent pending = openBackupPendingIntent();
        Intent cancel = new Intent(getApplicationContext(), NativeBackupNotificationReceiver.class)
            .setAction(NativeBackupNotificationReceiver.ACTION_CANCEL).putExtra("jobId", jobId);
        PendingIntent cancelPending = PendingIntent.getBroadcast(getApplicationContext(), NOTIFICATION_ID, cancel, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(getApplicationContext(), CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_upload).setContentTitle("SRL 云备份").setContentText(text)
            .setOnlyAlertOnce(true).setOngoing(true).setContentIntent(pending);
        if (!manifestCommitStarted) builder.addAction(android.R.drawable.ic_menu_close_clear_cancel, "取消本次", cancelPending);
        if (total > 0) builder.setProgress(total, Math.min(completed, total), false); else builder.setProgress(0, 0, true);
        if (Build.VERSION.SDK_INT >= 29) return new ForegroundInfo(NOTIFICATION_ID, builder.build(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        return new ForegroundInfo(NOTIFICATION_ID, builder.build());
    }
    private void notifyFinished(String title, String text) {
        ensureChannel();
        NotificationCompat.Builder builder = new NotificationCompat.Builder(getApplicationContext(), CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_upload_done).setContentTitle(title).setContentText(text).setAutoCancel(true)
            .setContentIntent(openBackupPendingIntent())
            .addAction(android.R.drawable.ic_menu_view, "查看备份", openBackupPendingIntent());
        ((NotificationManager) getApplicationContext().getSystemService(Context.NOTIFICATION_SERVICE)).notify(NOTIFICATION_ID + 1, builder.build());
    }
    private void ensureChannel() {
        if (Build.VERSION.SDK_INT >= 26) ((NotificationManager) getApplicationContext().getSystemService(Context.NOTIFICATION_SERVICE))
            .createNotificationChannel(new NotificationChannel(CHANNEL, "云备份", NotificationManager.IMPORTANCE_LOW));
    }
    private PendingIntent openBackupPendingIntent() {
        Intent launch = new Intent(Intent.ACTION_VIEW, Uri.parse("srl://backup"), getApplicationContext(), MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(getApplicationContext(), NOTIFICATION_ID + 2, launch, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }
    private String rootMessage(Throwable error) { Throwable current = error; while (current.getCause() != null) current = current.getCause(); return current.getMessage() == null ? "原生云备份失败" : current.getMessage(); }
    private boolean hasCause(Throwable error, Class<? extends Throwable> type) { Throwable current = error; while (current != null) { if (type.isInstance(current)) return true; current = current.getCause(); } return false; }
    private boolean hasHttpStatus(Throwable error, int status) { Throwable current = error; while (current != null) { if (current instanceof CloudHttpException && ((CloudHttpException) current).status == status) return true; current = current.getCause(); } return false; }
    private static final class UploadResult { final String id; UploadResult(String id) { this.id = id; } }
    private static final class LocalSourceException extends IOException {
        LocalSourceException(String message) { super(message); }
        LocalSourceException(String message, Throwable cause) { super(message, cause); }
    }
    private static final class HttpResult { final int code; final String body, contentRange; final long contentLength; HttpResult(int code, String body, String contentRange, long contentLength) { this.code=code; this.body=body; this.contentRange=contentRange; this.contentLength=contentLength; } }
    private static final class CloudHttpException extends Exception { final int status; CloudHttpException(int status, String message) { super(message + "（" + status + "）"); this.status = status; } }
}
