package buzz.jixiangruyi1207.srl;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.content.ComponentCallbacks2;
import androidx.activity.OnBackPressedCallback;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;
import java.util.UUID;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ShareReceiverPlugin.class);
        registerPlugin(NativeLibraryPlugin.class);
        registerPlugin(NativeAppDatabasePlugin.class);
        registerPlugin(NativeArchivePlugin.class);
        registerPlugin(NativeImagesPlugin.class);
        registerPlugin(NativeCloudTransferPlugin.class);
        registerPlugin(NativeImportKeepAlivePlugin.class);
        registerPlugin(NativeHostedUploadPlugin.class);
        registerPlugin(NativePreviewAssetPlugin.class);
        registerPlugin(NativeFileExportPlugin.class);
        registerPlugin(NativeFilePickerPlugin.class);
        registerPlugin(NativeSecurityPlugin.class);
        registerPlugin(NativeDiscordSetupBrowserPlugin.class);
        registerPlugin(NativeShortcutPlugin.class);
        registerPlugin(NativeSafBackupPlugin.class);
        registerPlugin(NativeTavernDirectoryPlugin.class);
        registerPlugin(NativeSystemUiPlugin.class);
        registerPlugin(NativePlatformPlugin.class);
        registerPlugin(NativeMainApiPlugin.class);
        registerPlugin(ProjectNoticeStoragePlugin.class);
        super.onCreate(savedInstanceState);
        getBridge().setWebViewClient(new OfficialAppWebViewClient(getBridge()));
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() { dispatchWebBackRequest(); }
        });
        NativeSystemUiPlugin.applyPersistedSystemBars(this);
        NativeSecurityPlugin.applyPersistedScreenProtection(this);
        NativeShareRouteShortcuts.retireLegacyShortcuts(this);
        NativeShortcutPlugin.captureIntent(getIntent());
        stageSystemShare(getIntent());
    }

    private void dispatchWebBackRequest() {
        if (getBridge() == null || getBridge().getWebView() == null) {
            moveTaskToBack(true);
            return;
        }
        String script = "(() => { const detail = { handled: false }; "
            + "document.dispatchEvent(new CustomEvent('srl:back-request', { detail })); "
            + "if (!detail.handled) window.dispatchEvent(new CustomEvent('srl:back-request', { detail })); "
            + "return detail.handled === true; })()";
        getBridge().getWebView().evaluateJavascript(script, result -> {
            if (!"true".equals(result)) moveTaskToBack(true);
        });
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) NativeSystemUiPlugin.applyPersistedSystemBars(this);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        NativeShortcutPlugin.captureIntent(intent);
        stageSystemShare(intent);
    }

    private void stageSystemShare(Intent intent) {
        if (!isSystemShare(intent)) return;
        stageSystemShareNow(intent);
    }

    private boolean isSystemShare(Intent intent) {
        if (intent == null) return false;
        String action = intent.getAction();
        if (Intent.ACTION_SEND.equals(action) || Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            boolean hasFile = intent.getData() != null;
            if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
                java.util.ArrayList<Uri> streams = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
                hasFile |= streams != null && !streams.isEmpty();
            } else {
                hasFile |= intent.getParcelableExtra(Intent.EXTRA_STREAM) != null;
            }
            boolean hasDiscordUrl = NativeShareRouteShortcuts.ROUTE_DISCORD_URL.equals(NativeShareRouteShortcuts.routeFrom(intent))
                && intent.getCharSequenceExtra(Intent.EXTRA_TEXT) != null;
            return hasFile || hasDiscordUrl;
        }
        if (!Intent.ACTION_VIEW.equals(action)) return false;
        Uri data = intent.getData();
        return data != null && ("content".equals(data.getScheme()) || "file".equals(data.getScheme()));
    }

    private void stageSystemShareNow(Intent intent) {
        Intent service = new Intent(this, NativeShareImportService.class)
            .putExtra(NativeShareImportService.EXTRA_SOURCE, intent)
            .putExtra(NativeShareImportService.EXTRA_OPERATION_ID, UUID.randomUUID().toString())
            .putExtra(NativeShareImportService.EXTRA_ROUTE, NativeShareRouteShortcuts.routeFrom(intent));
        ContextCompat.startForegroundService(this, service);
        // 文件复制由前台服务负责，避免页面读取同一 URI 造成重复导入。
        setIntent(new Intent());
    }

    @Override
    public void onTrimMemory(int level) {
        super.onTrimMemory(level);
        if (level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL ||
            level >= ComponentCallbacks2.TRIM_MEMORY_COMPLETE) {
            dispatchMemoryPressure("critical");
        } else if (level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW &&
            level < ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN) {
            dispatchMemoryPressure("moderate");
        }
    }

    @Override
    public void onLowMemory() {
        super.onLowMemory();
        dispatchMemoryPressure("critical");
    }

    private void dispatchMemoryPressure(String level) {
        if (getBridge() == null || getBridge().getWebView() == null) return;
        String script = "window.dispatchEvent(new CustomEvent('srl:native-memory-pressure',"
            + "{detail:{level:'" + level + "'}}))";
        getBridge().getWebView().post(() -> getBridge().getWebView().evaluateJavascript(script, null));
    }
}
