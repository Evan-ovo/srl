package buzz.jixiangruyi1207.srl;

import android.content.Context;
import android.app.ActivityManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Single native capability boundary used by the Web core. */
@CapacitorPlugin(name = "NativePlatform")
public class NativePlatformPlugin extends Plugin {
    private static final int API_VERSION = BuildConfig.SRL_NATIVE_API_VERSION;

    @PluginMethod
    public void getInfo(PluginCall call) {
        JSObject result = new JSObject();
        result.put("apiVersion", API_VERSION);
        JSArray capabilities = new JSArray();
        capabilities.put("system-insets-v1");
        capabilities.put("network-state-v1");
        capabilities.put("memory-pressure-v1");
        capabilities.put("native-stream-transfer-v1");
        capabilities.put("back-stack-v1");
        capabilities.put("photo-picker-v1");
        capabilities.put("documents-provider-v2");
        capabilities.put("app-resume-v1");
        capabilities.put("clear-app-user-data-v1");
        result.put("capabilities", capabilities);
        result.put("insets", readInsets());
        result.put("network", readNetwork());
        call.resolve(result);
    }

    @PluginMethod
    public void clearLocalData(PluginCall call) {
        try {
            ActivityManager manager = (ActivityManager) getContext().getSystemService(Context.ACTIVITY_SERVICE);
            if (manager == null) throw new IllegalStateException("无法取得 Android 应用数据清理服务");
            // Android terminates this process when it accepts the request; a JS success callback
            // is not guaranteed. It clears app-private data, not shared exports or cloud accounts.
            NativeLocalDataReset.clear(call.getString("confirmation"), manager::clearApplicationUserData);
            call.resolve();
        } catch (Exception error) {
            call.reject(error.getMessage(), error);
        }
    }

    private JSObject readInsets() {
        JSObject result = new JSObject();
        WindowInsetsCompat root = ViewCompat.getRootWindowInsets(getActivity().getWindow().getDecorView());
        if (root == null) {
            result.put("top", 0);
            result.put("bottom", 0);
            return result;
        }
        Insets top = root.getInsets(
            WindowInsetsCompat.Type.statusBars() | WindowInsetsCompat.Type.displayCutout()
        );
        Insets bottom = root.getInsets(
            WindowInsetsCompat.Type.navigationBars() | WindowInsetsCompat.Type.systemGestures()
        );
        result.put("top", top.top);
        result.put("bottom", bottom.bottom);
        return result;
    }

    private JSObject readNetwork() {
        ConnectivityManager manager = (ConnectivityManager) getContext()
            .getSystemService(Context.CONNECTIVITY_SERVICE);
        Network network = manager == null ? null : manager.getActiveNetwork();
        NetworkCapabilities capabilities = network == null || manager == null
            ? null
            : manager.getNetworkCapabilities(network);
        boolean wifi = capabilities != null && capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI);
        boolean cellular = capabilities != null && capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR);
        JSObject result = new JSObject();
        result.put("offline", capabilities == null);
        result.put("wifi", wifi);
        result.put("cellular", cellular);
        result.put("metered", manager != null && manager.isActiveNetworkMetered());
        result.put(
            "validated",
            capabilities != null && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
        );
        return result;
    }
}
