package buzz.jixiangruyi1207.srl;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.Build;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.work.*;
import java.io.File;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;

/** Durable download owner; uses the existing cloud job journal and restore transport. */
public final class NativeCloudRestoreWorker extends Worker {
    private static final java.util.concurrent.ConcurrentHashMap<String, java.util.concurrent.CountDownLatch> ACTIVE = new java.util.concurrent.ConcurrentHashMap<>();
    static void awaitStopped(String id) throws InterruptedException {
        java.util.concurrent.CountDownLatch stopped = ACTIVE.get(id);
        if (stopped != null) stopped.await();
    }
    static final String WORK_PREFIX = "srl-cloud-restore-";
    private static final int NOTIFICATION_ID = 2114;
    private static final String CHANNEL = "srl_cloud_restore";
    private volatile okhttp3.Call activeCall;
    private volatile Thread activeThread;
    private long lastProgressAt;
    private int lastProgressCompleted;

    public NativeCloudRestoreWorker(@NonNull Context context, @NonNull WorkerParameters parameters) {
        super(context, parameters);
    }

    static final class Handle {
        final File root;
        final UUID workId;
        Handle(File root, UUID workId) { this.root = root; this.workId = workId; }
    }

    static synchronized Handle enqueue(Context context, JSONObject config, String secret,
        JSONArray objects, JSONArray resources, boolean progressive) throws Exception {
        JSONObject target = new JSONObject().put("provider", config.getString("provider"));
        if ("github".equals(config.getString("provider"))) {
            target.put("owner", config.getString("owner").toLowerCase(java.util.Locale.ROOT));
            target.put("repository", config.getString("repository").toLowerCase(java.util.Locale.ROOT));
        } else {
            target.put("baseUrl", config.getString("baseUrl").trim().replaceAll("/+$", ""));
            target.put("username", config.getString("username"));
        }
        JSONObject plan = new JSONObject().put("config", target).put("objects", objects).put("resources", resources);
        if (progressive) plan.put("progressive", true);
        byte[] encoded = plan.toString().getBytes(StandardCharsets.UTF_8);
        if (encoded.length > 16 * 1024 * 1024) throw new IllegalArgumentException("原生恢复计划超过 16 MiB 上限");
        String planHash = NativeCloudRestoreTransport.hex(MessageDigest.getInstance("SHA-256").digest(encoded));
        WorkManager manager = WorkManager.getInstance(context);
        File selected = null;
        File[] roots = NativeCloudTransferPlugin.jobsRoot(context).listFiles(File::isDirectory);
        if (roots != null) for (File root : roots) {
            JSONObject job;
            try { job = NativeCloudTransferPlugin.readJob(root); } catch (Exception unreadable) { continue; }
            if (!"restore".equals(job.optString("kind"))) continue;
            boolean same = planHash.equals(job.optString("planHash"));
            WorkInfo work = job.has("workId") ? manager.getWorkInfoById(UUID.fromString(job.getString("workId"))).get() : null;
            if (work != null && !work.getState().isFinished()) {
                if (!same) throw new IllegalStateException("已有 Android 云恢复正在继续，请等待该任务结束");
                return new Handle(root, work.getId());
            }
            if (same) selected = root;
        }
        String id = selected == null ? UUID.randomUUID().toString() : selected.getName();
        File root = selected == null ? new File(NativeCloudTransferPlugin.jobsRoot(context), id) : selected;
        File planRoot = new File(root, "restore-plan");
        if (!planRoot.isDirectory() && !planRoot.mkdirs()) throw new IllegalStateException("无法创建恢复计划目录");
        NativeCloudTransferPlugin.writeJob(planRoot, plan);
        if (progressive) try (java.io.FileOutputStream reset = new java.io.FileOutputStream(new File(root, "restore-results.ndjson"))) {}
        new NativeSecretStore(context).save("cloud-job-" + id, secret);
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(NativeCloudRestoreWorker.class)
            .setInputData(new Data.Builder().putString("jobId", id).build())
            .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build();
        JSONObject job = new JSONObject().put("version", 3).put("kind", "restore").put("id", id)
            .put("provider", config.getString("provider")).put("planHash", planHash)
            .put("workId", request.getId().toString()).put("status", "queued")
            .put("createdAt", System.currentTimeMillis()).put("updatedAt", System.currentTimeMillis())
            .put("completed", 0).put("total", resources.length());
        NativeCloudTransferPlugin.writeJob(root, job);
        manager.enqueueUniqueWork(WORK_PREFIX + id, ExistingWorkPolicy.KEEP, request).getResult().get();
        return new Handle(root, request.getId());
    }

    @Override public void onStopped() {
        okhttp3.Call call = activeCall;
        if (call != null) call.cancel();
        Thread thread = activeThread;
        if (thread != null) thread.interrupt();
        super.onStopped();
    }

    @NonNull @Override public Result doWork() {
        String id = getInputData().getString("jobId");
        if (id == null || !id.matches("[a-f0-9-]{36}")) return Result.failure();
        File root = new File(NativeCloudTransferPlugin.jobsRoot(getApplicationContext()), id);
        boolean retainSecret = false;
        boolean progressive = false;
        java.util.concurrent.CountDownLatch stopped = new java.util.concurrent.CountDownLatch(1);
        ACTIVE.put(id, stopped);
        activeThread = Thread.currentThread();
        try {
            JSONObject plan = NativeCloudTransferPlugin.readJob(new File(root, "restore-plan"));
            progressive = plan.optBoolean("progressive", false);
            JSONObject config = plan.getJSONObject("config");
            String provider = config.getString("provider");
            String secret = new NativeSecretStore(getApplicationContext()).read("cloud-job-" + id);
            if (secret == null || secret.isBlank()) throw new IllegalStateException("恢复凭据已丢失，请重新选择云备份继续");
            String username = config.optString("username", "");
            String host = "webdav".equals(provider) ? URI.create(config.getString("baseUrl")).getHost() : "";
            List<NativeCloudRestoreTransport.RestoreObject> objects = new ArrayList<>();
            JSONArray entries = plan.getJSONArray("objects");
            for (int index = 0; index < entries.length(); index++) {
                JSONObject entry = entries.getJSONObject(index);
                NativeCloudRestoreTransport.validateRestoreUri(provider, URI.create(entry.getString("url")), host);
                objects.add(new NativeCloudRestoreTransport.RestoreObject(entry.getString("hash"), entry.getLong("size"), entry.getString("url")));
            }
            List<NativeCloudRestoreTransport.RestoreResource> resources = new ArrayList<>();
            entries = plan.getJSONArray("resources");
            for (int index = 0; index < entries.length(); index++) {
                JSONObject entry = entries.getJSONObject(index);
                List<NativeCloudRestoreTransport.RestoreSegment> segments = new ArrayList<>();
                JSONArray ranges = entry.getJSONArray("segments");
                for (int part = 0; part < ranges.length(); part++) {
                    JSONObject range = ranges.getJSONObject(part);
                    segments.add(new NativeCloudRestoreTransport.RestoreSegment(range.getString("hash"), range.getLong("offset"), range.getLong("size")));
                }
                resources.add(new NativeCloudRestoreTransport.RestoreResource(entry.getString("hash"), entry.getLong("size"), segments));
            }
            NativeCloudTransferPlugin.mutateJob(root, job -> {
                if ("cancelled".equals(job.optString("status"))) throw new InterruptedException("云恢复已取消");
                job.put("status", "running");
            });
            setForegroundAsync(foreground("正在从云端恢复；切到后台也会继续", 0, resources.size())).get();
            NativeCloudRestoreTransport.RestoreProgress progress = (completed, total) -> {
                    if (isStopped() || Thread.currentThread().isInterrupted()) throw new InterruptedException("云恢复已暂停");
                    long now = System.currentTimeMillis();
                    if (completed < total && now - lastProgressAt < 350
                        && completed - lastProgressCompleted < Math.max(1, (int)Math.ceil(total / 100.0))) return;
                    lastProgressAt = now;
                    lastProgressCompleted = completed;
                    NativeCloudTransferPlugin.mutateJob(root, job -> job.put("completed", completed).put("total", total));
                    setProgressAsync(new Data.Builder().putInt("completed", completed).putInt("total", total).build());
                    setForegroundAsync(foreground("正在恢复 " + completed + "/" + total, completed, total));
                };
            NativeCloudRestoreTransport.RestoreCounts counts;
            if (progressive) {
                counts = NativeCloudRestoreTransport.restoreIncrementally(new File(root, "restore-pending"), objects, resources,
                    hash -> NativeLibraryPlugin.objectFile(getApplicationContext(), hash),
                    () -> NativeCloudRestoreTransport.nativeDownloader(provider, secret, username, call -> { if (isStopped()) call.cancel(); }), progress,
                    (hash, error) -> {
                        if (isStopped()) throw new InterruptedException("云恢复已取消");
                        JSONObject receipt = new JSONObject().put("hash", hash);
                        if (error != null) receipt.put("error", error.length() > 1024 ? error.substring(0, 1024) : error);
                        try (java.io.FileOutputStream output = new java.io.FileOutputStream(new File(root, "restore-results.ndjson"), true)) {
                            output.write((receipt.toString() + "\n").getBytes(StandardCharsets.UTF_8));
                        }
                    });
            } else {
                counts = NativeCloudRestoreTransport.restoreFiles(new File(root, "restore-pending"), objects, resources,
                    hash -> NativeLibraryPlugin.objectFile(getApplicationContext(), hash),
                    NativeCloudRestoreTransport.nativeDownloader(provider, secret, username, call -> { activeCall = call; if (isStopped()) call.cancel(); }), true, progress);
            }
            if (isStopped() || "cancelled".equals(NativeCloudTransferPlugin.readJob(root).optString("status"))) throw new InterruptedException("云恢复已取消");
            JSONArray failures = new JSONArray();
            for (java.util.Map.Entry<String, String> failure : counts.failures.entrySet()) failures.put(new JSONObject().put("hash", failure.getKey()).put("error", failure.getValue()));
            NativeCloudTransferPlugin.mutateJob(root, job -> {
                if ("cancelled".equals(job.optString("status")) || isStopped()) throw new InterruptedException("云恢复已取消");
                job.put("status", "completed").put("downloaded", counts.downloaded).put("reused", counts.reused).put("assembled", counts.assembled).put("failures", failures);
            });
            notifyFinished(counts.failures.isEmpty() ? "云端文件已恢复" : "云恢复部分完成", counts.failures.isEmpty() ? "返回 SRL 查看本机导入结果。" : "失败项已留在清单，仅手动选择后重试。", true);
            return Result.success();
        } catch (Exception error) {
            boolean cancelled = isStopped() || error instanceof InterruptedException;
            try { cancelled |= "cancelled".equals(NativeCloudTransferPlugin.readJob(root).optString("status")); } catch (Exception ignored) {}
            boolean retry = !cancelled && !progressive && error instanceof java.io.IOException
                && !(error instanceof NativeCloudRestoreTransport.IntegrityException)
                && !(error instanceof NativeCloudRestoreTransport.CloudHttpStatusException) && getRunAttemptCount() < 2;
            final boolean cancelledResult = cancelled;
            retainSecret = retry;
            try {
                NativeCloudTransferPlugin.mutateJob(root, job -> job.put("status", cancelledResult ? "cancelled" : retry ? "queued" : "failed")
                    .put("error", error.getMessage() == null ? "原生云恢复失败" : error.getMessage())
                    .put("errorCode", error instanceof NativeCloudRestoreTransport.CloudHttpStatusException
                        ? "HTTP_" + ((NativeCloudRestoreTransport.CloudHttpStatusException) error).status : JSONObject.NULL));
            } catch (Exception ignored) {}
            if (!cancelled) notifyFinished(retry ? "云恢复等待重试" : "云恢复未完成", "已保留恢复断点，请返回 SRL 查看。", false);
            return retry ? Result.retry() : Result.failure();
        } finally {
            stopped.countDown();
            ACTIVE.remove(id, stopped);
            activeThread = null;
            activeCall = null;
            if (!retainSecret) new NativeSecretStore(getApplicationContext()).clear("cloud-job-" + id);
        }
    }

    private ForegroundInfo foreground(String text, int completed, int total) {
        NotificationCompat.Builder builder = notification("SRL 云恢复", text, false).setOngoing(true);
        if (total > 0) builder.setProgress(total, completed, false); else builder.setProgress(0, 0, true);
        return Build.VERSION.SDK_INT >= 29 ? new ForegroundInfo(NOTIFICATION_ID, builder.build(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            : new ForegroundInfo(NOTIFICATION_ID, builder.build());
    }

    private NotificationCompat.Builder notification(String title, String text, boolean successful) {
        Context context = getApplicationContext();
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(new NotificationChannel(CHANNEL, "云恢复", NotificationManager.IMPORTANCE_LOW));
        Intent launch = new Intent(Intent.ACTION_VIEW, Uri.parse("srl://backup"), context, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pending = PendingIntent.getActivity(context, NOTIFICATION_ID, launch, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new NotificationCompat.Builder(context, CHANNEL).setContentTitle(title).setContentText(text)
            .setSmallIcon(successful ? android.R.drawable.stat_sys_download_done : android.R.drawable.stat_sys_download)
            .setOnlyAlertOnce(true).setContentIntent(pending).setAutoCancel(true);
    }

    private void notifyFinished(String title, String text, boolean successful) {
        ((NotificationManager) getApplicationContext().getSystemService(Context.NOTIFICATION_SERVICE))
            .notify(NOTIFICATION_ID + 1, notification(title, text, successful).build());
    }
}
