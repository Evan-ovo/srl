package buzz.jixiangruyi1207.srl;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.os.Build;
import android.view.WindowManager;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(name = "NativeSecurity", permissions = {
    @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
})
public class NativeSecurityPlugin extends Plugin {
    private final NativeSecretRecovery secretRecovery = new NativeSecretRecovery();

    @PluginMethod public void getSecretRecoveryState(PluginCall call) { secretRecovery.state(getContext(), call); }
    @PluginMethod public void clearSecretRecovery(PluginCall call) { secretRecovery.clear(getContext(), call); }
    @PluginMethod public void saveSecretRecovery(PluginCall call) {
        getActivity().runOnUiThread(() -> secretRecovery.authenticate((FragmentActivity) getActivity(), call, true));
    }
    @PluginMethod public void recoverSecretPassword(PluginCall call) {
        getActivity().runOnUiThread(() -> secretRecovery.authenticate((FragmentActivity) getActivity(), call, false));
    }
    private static final String PREFS = "srl-native-security";
    private static final String SECURE_SCREEN = "secure-screen";

    static void applyPersistedScreenProtection(Activity activity) {
        boolean enabled = activity.getSharedPreferences(PREFS, Activity.MODE_PRIVATE).getBoolean(SECURE_SCREEN, false);
        if (enabled) activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
    }

    @PluginMethod
    public void setSecureScreen(PluginCall call) {
        boolean enabled = call.getBoolean("enabled", false);
        getContext().getSharedPreferences(PREFS, Activity.MODE_PRIVATE).edit().putBoolean(SECURE_SCREEN, enabled).apply();
        getActivity().runOnUiThread(() -> {
            if (enabled) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
            JSObject result = new JSObject(); result.put("enabled", enabled); call.resolve(result);
        });
    }

    @PluginMethod
    public void getSecurityState(PluginCall call) {
        JSObject result = new JSObject();
        result.put("secureScreen", getContext().getSharedPreferences(PREFS, Activity.MODE_PRIVATE).getBoolean(SECURE_SCREEN, false));
        int authenticators = BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL;
        result.put("biometricAvailable", BiometricManager.from(getContext()).canAuthenticate(authenticators) == BiometricManager.BIOMETRIC_SUCCESS);
        result.put("notificationsGranted", notificationsGranted());
        call.resolve(result);
    }

    @PluginMethod
    public void authenticate(PluginCall call) {
        FragmentActivity activity = (FragmentActivity) getActivity();
        int authenticators = BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL;
        if (BiometricManager.from(getContext()).canAuthenticate(authenticators) != BiometricManager.BIOMETRIC_SUCCESS) {
            call.reject("当前设备没有可用的指纹、面容或锁屏验证"); return;
        }
        getActivity().runOnUiThread(() -> {
            BiometricPrompt prompt = new BiometricPrompt(activity, ContextCompat.getMainExecutor(getContext()), new BiometricPrompt.AuthenticationCallback() {
                @Override public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) { super.onAuthenticationSucceeded(result); JSObject value = new JSObject(); value.put("authenticated", true); call.resolve(value); }
                @Override public void onAuthenticationError(int code, CharSequence message) { super.onAuthenticationError(code, message); call.reject("设备验证未完成：" + message); }
            });
            BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder().setTitle("验证 SRL 本机访问").setSubtitle("确认后继续访问受保护的本地与云端功能").setAllowedAuthenticators(authenticators).build();
            prompt.authenticate(info);
        });
    }

    @PluginMethod
    public void requestNotifications(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED) { JSObject result = new JSObject(); result.put("granted", notificationsGranted()); call.resolve(result); return; }
        requestPermissionForAlias("notifications", call, "notificationPermissionResult");
    }

    @PermissionCallback
    private void notificationPermissionResult(PluginCall call) {
        JSObject result = new JSObject(); result.put("granted", notificationsGranted()); call.resolve(result);
    }

    private boolean notificationsGranted() {
        return (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
            && NotificationManagerCompat.from(getContext()).areNotificationsEnabled();
    }
}
