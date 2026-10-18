package buzz.jixiangruyi1207.srl;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/** Android APK 更新下载、SHA-256 校验和系统安装入口。 */
@CapacitorPlugin(name = "ApkUpdater")
public class ApkUpdaterPlugin extends Plugin {
    private static final class Download {
        volatile boolean cancelled;
        volatile HttpURLConnection connection;
        boolean committing;
        volatile File file;
        void check() throws java.io.IOException { if (cancelled) throw new java.io.IOException("APK 更新下载已取消"); }
    }
    private final ConcurrentHashMap<String, Download> downloads = new ConcurrentHashMap<>();
    private final Set<String> installerFiles = ConcurrentHashMap.newKeySet();

    @Override public void load() { cleanupUpdates(); }
    @Override protected void handleOnResume() {
        installerFiles.clear();
        cleanupUpdates();
    }
    private void cleanupUpdates() {
        NativeExecutors.ioLimited().execute(() -> {
            try {
                File directory = new File(getContext().getCacheDir(), "apk-updates");
                NativeApkUpdateCache.cleanup(directory, name -> {
                    if (installerFiles.contains(name)) return true;
                    for (String id : downloads.keySet())
                        if (name.equals("srl-update-" + id + ".apk") || name.equals("srl-update-" + id + ".apk.part")) return true;
                    return false;
                });
            } catch (Exception ignored) {
                // Cache housekeeping cannot prevent a verified update from being installed.
            }
        });
    }
    @PluginMethod public void cancelDownload(PluginCall call) {
        Download download = downloads.get(call.getString("taskId", ""));
        JSObject result = new JSObject();
        if (download == null) { result.put("status", "missing"); call.resolve(result); return; }
        synchronized (download) {
            if (download.committing) { result.put("status", "committing"); call.resolve(result); return; }
            download.cancelled = true;
            if (download.connection != null) download.connection.disconnect();
            result.put("status", "cancelled"); call.resolve(result);
        }
    }
    // SRL-PUBLIC-SYNC: BEGIN REPLACE id=apk-native-update-origin
    private static final String UPDATE_HOST = "";
    private static final String UPDATE_REPOSITORY = BuildConfig.SRL_APK_UPDATE_REPOSITORY;
    // SRL-PUBLIC-SYNC: END REPLACE id=apk-native-update-origin

    @PluginMethod
    public void getCurrentVersion(PluginCall call) {
        try {
            PackageInfo packageInfo = getContext().getPackageManager()
                .getPackageInfo(getContext().getPackageName(), 0);
            long versionCode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? packageInfo.getLongVersionCode()
                : packageInfo.versionCode;
            JSObject result = new JSObject();
            result.put("versionCode", versionCode);
            result.put("versionName", packageInfo.versionName == null ? "" : packageInfo.versionName);
            call.resolve(result);
        } catch (PackageManager.NameNotFoundException error) {
            call.reject("无法读取 APK 版本", error);
        }
    }

    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        String url = call.getString("url");
        String expectedSha256 = call.getString("sha256");
        if (!isTrustedUpdate(url) || expectedSha256 == null || !expectedSha256.matches("(?i)[a-f0-9]{64}")) {
            call.reject("APK 更新地址或校验值无效");
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            !getContext().getPackageManager().canRequestPackageInstalls()) {
            getActivity().startActivity(new Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + getContext().getPackageName())
            ));
            JSObject result = new JSObject();
            result.put("status", "permission_required");
            call.resolve(result);
            return;
        }

        String taskId = call.getString("taskId", UUID.randomUUID().toString());
        if (!taskId.matches("[a-zA-Z0-9-]{1,64}")) { call.reject("更新任务标识无效"); return; }
        Download download = new Download();
        if (downloads.putIfAbsent(taskId, download) != null) { call.reject("同一更新下载已在运行"); return; }
        cleanupUpdates();
        NativeExecutors.ioLimited().execute(() -> {
            try {
                File apk = downloadVerifiedApk(url, expectedSha256, download, taskId, call.getData().optLong("sizeBytes", 0L));
                download.check();
                verifySignerContinuity(apk);
                getActivity().runOnUiThread(() -> {
                    try {
                        synchronized (download) {
                            download.check();
                            download.committing = true;
                            installerFiles.add(apk.getName());
                            openSystemInstaller(apk);
                        }
                        JSObject result = new JSObject();
                        result.put("status", "install_started");
                        call.resolve(result);
                    } catch (Exception error) {
                        installerFiles.remove(apk.getName());
                        call.reject(download.cancelled ? "APK 更新下载已取消" : "无法打开系统安装器：" + error.getMessage(), error);
                    } finally {
                        if (download.cancelled && download.file != null) download.file.delete();
                        downloads.remove(taskId, download);
                        cleanupUpdates();
                    }
                });
            } catch (Exception error) {
                if (download.file != null) download.file.delete();
                downloads.remove(taskId, download);
                cleanupUpdates();
                call.reject(download.cancelled ? "APK 更新下载已取消" : "APK 下载或校验失败：" + error.getMessage(), error);
            }
        });
    }

    private boolean isTrustedUpdate(String rawUrl) {
        return ApkUpdateUrlPolicy.initial(rawUrl, UPDATE_REPOSITORY, UPDATE_HOST);
    }

    private HttpURLConnection openUpdateConnection(String rawUrl, Download download) throws Exception {
        String current = rawUrl;
        for (int redirect = 0; redirect <= 5; redirect++) {
            download.check();
            HttpURLConnection connection = (HttpURLConnection) new URL(current).openConnection();
            download.connection = connection;
            connection.setConnectTimeout(20_000);
            connection.setReadTimeout(30_000);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("Accept", "application/vnd.android.package-archive");
            try {
                int status = connection.getResponseCode();
                if (status == HttpURLConnection.HTTP_OK) return connection;
                String location = connection.getHeaderField("Location");
                if ((status != 301 && status != 302 && status != 303 && status != 307 && status != 308) ||
                    location == null || !ApkUpdateUrlPolicy.redirect(location, UPDATE_REPOSITORY) || redirect == 5) {
                    throw new SecurityException("APK 下载响应或跳转来源无效（HTTP " + status + "）");
                }
                current = location;
            } catch (Exception error) { connection.disconnect(); throw error; }
            connection.disconnect();
        }
        throw new SecurityException("APK 下载跳转过多");
    }

    private File downloadVerifiedApk(String rawUrl, String expectedSha256, Download download, String taskId, long expectedSize) throws Exception {
        download.check();
        File directory = new File(getContext().getCacheDir(), "apk-updates");
        if (!directory.exists() && !directory.mkdirs()) throw new IllegalStateException("无法创建 APK 缓存目录");
        File temporary = new File(directory, "srl-update-" + taskId + ".apk.part");
        File destination = new File(directory, "srl-update-" + taskId + ".apk");
        HttpURLConnection connection = openUpdateConnection(rawUrl, download);
        boolean completed = false;
        try {
            download.connection = connection;
            download.check();

            long received = 0;
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(temporary)) {
                byte[] buffer = new byte[64 * 1024];
                int length;
                while ((length = input.read(buffer)) != -1) {
                    download.check();
                    received += length;
                    if (expectedSize > 0 && received > expectedSize) throw new SecurityException("APK 大小超出清单");
                    digest.update(buffer, 0, length);
                    output.write(buffer, 0, length);
                }
            }
            download.check();
            if (expectedSize > 0 && received != expectedSize) throw new SecurityException("APK 大小与清单不符");
            if (!hex(digest.digest()).equalsIgnoreCase(expectedSha256)) throw new SecurityException("SHA-256 不匹配");
            if (destination.exists() && !destination.delete()) throw new IllegalStateException("无法替换旧 APK 缓存");
            if (!temporary.renameTo(destination)) throw new IllegalStateException("无法完成 APK 保存");
            download.file = destination;
            completed = true;
            return destination;
        } finally {
            connection.disconnect();
            download.connection = null;
            if (!completed) temporary.delete();
        }
    }

    private String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) result.append(String.format(Locale.ROOT, "%02x", value));
        return result.toString();
    }

    @SuppressWarnings("deprecation")
    private Set<String> signerFingerprints(PackageInfo packageInfo) throws Exception {
        Signature[] signatures;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            if (packageInfo.signingInfo == null) throw new SecurityException("APK 缺少签名信息");
            signatures = packageInfo.signingInfo.hasMultipleSigners()
                ? packageInfo.signingInfo.getApkContentsSigners()
                : packageInfo.signingInfo.getSigningCertificateHistory();
        } else {
            signatures = packageInfo.signatures;
        }
        if (signatures == null || signatures.length == 0) throw new SecurityException("APK 缺少签名证书");
        Set<String> fingerprints = new HashSet<>();
        for (Signature signature : signatures) {
            fingerprints.add(hex(MessageDigest.getInstance("SHA-256").digest(signature.toByteArray())));
        }
        return fingerprints;
    }

    @SuppressWarnings("deprecation")
    private void verifySignerContinuity(File apk) throws Exception {
        PackageManager manager = getContext().getPackageManager();
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
            ? PackageManager.GET_SIGNING_CERTIFICATES
            : PackageManager.GET_SIGNATURES;
        PackageInfo current = manager.getPackageInfo(getContext().getPackageName(), flags);
        PackageInfo downloaded = manager.getPackageArchiveInfo(apk.getAbsolutePath(), flags);
        if (downloaded == null || !getContext().getPackageName().equals(downloaded.packageName)) {
            apk.delete();
            throw new SecurityException("下载的 APK 包名不一致");
        }
        long currentCode = Build.VERSION.SDK_INT >= 28 ? current.getLongVersionCode() : current.versionCode;
        long nextCode = Build.VERSION.SDK_INT >= 28 ? downloaded.getLongVersionCode() : downloaded.versionCode;
        if (nextCode <= currentCode) throw new SecurityException("下载的 APK 版本没有高于当前安装版本");
        Set<String> currentSigners = signerFingerprints(current);
        Set<String> downloadedSigners = signerFingerprints(downloaded);
        if (!downloadedSigners.containsAll(currentSigners)) {
            apk.delete();
            throw new SecurityException("APK 签名证书与当前安装版本不一致");
        }
    }

    private void openSystemInstaller(File apk) {
        Uri uri = FileProvider.getUriForFile(
            getContext(),
            getContext().getPackageName() + ".fileprovider",
            apk
        );
        Intent intent = new Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getActivity().startActivity(intent);
    }
}
