package buzz.jixiangruyi1207.srl;

import android.app.AlertDialog;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

@CapacitorPlugin(name = "NativeDiscordSetupBrowser")
public class NativeDiscordSetupBrowserPlugin extends Plugin {
    private DiscordSetupBrowserWindow browser;
    private String executor;
    private String petFrame;
    private final Map<String, String> labels = new HashMap<>();
    private JSObject snapshot;
    private String inspectedUrl;
    private int inspectedDocument = -1;
    private long controlSequence;
    private PluginCall pendingWait;
    private String statusMarker;
    private JSObject statusPayload;
    private boolean statusChecking;
    private String installationMarker, installationUrl;
    private int installationDocument = -1;
    private static final Set<String> OPERATIONS = new java.util.HashSet<>(java.util.Arrays.asList("click", "select", "fill", "focus", "scroll", "template", "validate", "guide", "collect-worker", "collect-config", "fill-endpoint", "open-install", "verify-step"));
    @PluginMethod public void open(PluginCall call) {
        String url = call.getString("url");
        if (url != null && !DiscordSetupBrowserPolicy.allowed(url)) { call.reject("配置浏览器支持 GitHub、Cloudflare、Discord 和 workers.dev HTTPS 配置页面"); return; }
        String step = call.getString("step", "");
        JSArray steps = call.getArray("steps", new JSArray());
        boolean knownStep = false;
        for (int index = 0; index < steps.length(); index++) if (step.equals(steps.optJSONObject(index).optString("id"))) knownStep = true;
        if (!knownStep) { call.reject("配置步骤无效"); return; }
        getActivity().runOnUiThread(() -> {
            if (browser == null) browser = new DiscordSetupBrowserWindow(getActivity(), event -> {
                if ("installation-ready".equals(event.optString("action"))) { installationReady(event.optString("marker")); return; }
                if ("page-ready".equals(event.optString("action"))) watchInstallation();
                if ("agent-pause".equals(event.optString("action")) && !browser.active()) cancelInstallationWatch();
                if ("status-ready".equals(event.optString("action"))) { statusReady(event.optString("marker")); return; }
                if ("agent-pause".equals(event.optString("action")) && pendingWait != null) { PluginCall waiting = pendingWait; pendingWait = null; cancelStatus(); waiting.resolve(metadata().put("paused", true)); }
                if ("page-ready".equals(event.optString("action")) && pendingWait != null) { PluginCall waiting = pendingWait; pendingWait = null; cancelStatus(); waiting.resolve(metadata()); return; }
                notifyListeners("setupAction", event);
            });
            browser.mode = call.getString("mode", "agent");
            if (browser.conversation(call.getString("conversationId", ""))) cancelInstallationWatch();
            browser.installation(call.getString("expectedApplicationId", ""), step);
            browser.agentRun(call.getString("agentRunId", ""));
            String site = call.getString("site", "");
            String root = "github".equals(site) ? "https://github.com/" : "discord".equals(site) ? "https://discord.com/developers/applications" : "https://dash.cloudflare.com/";
            String current = browser.web == null ? null : browser.web.getUrl();
            String target = DiscordSetupBrowserPolicy.openingUrl(url, current, call.getBoolean("resumeCurrent", false), step.equals(browser.step), root);
            browser.open(target, step, call.getString("title", "Discord 配置"), call.getString("hint", ""), steps, call.getString("template", ""), call.getBoolean("chooseStep", false), call.getBoolean("darkTheme", false));
            browser.petFrame(petFrame);
            if (call.getBoolean("showControls", false)) browser.controls();
            watchInstallation();
            labels.clear(); snapshot = null; inspectedUrl = null; call.resolve();
        });
    }
    @PluginMethod public void inspect(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (!ready(call)) return;
            JSObject metadata = metadata();
            if (browser.paused && !secretReadback() || browser.loading || DiscordSetupBrowserPolicy.userOnly(browser.step, browser.web.getUrl())) { metadata.put("paused", true); call.resolve(metadata); return; }
            if (call.getBoolean("metadataOnly", false)) {
                if (snapshot != null && inspectedDocument == browser.documentId && browser.web.getUrl().equals(inspectedUrl)) {
                    metadata.put("controls", snapshot.optJSONArray("controls")); metadata.put("forkOfTarget", snapshot.optBoolean("forkOfTarget", false));
                    metadata.put("pageKind", snapshot.optString("pageKind", "")); metadata.put("headings", snapshot.optJSONArray("headings"));
                    if (snapshot.has("pageAccess")) metadata.put("pageAccess", snapshot.optString("pageAccess"));
                    if (snapshot.has("applicationList")) metadata.put("applicationList", snapshot.optJSONObject("applicationList"));
                    if (snapshot.has("truncated")) metadata.put("truncated", snapshot.optBoolean("truncated"));
                    if (snapshot.has("searchMatched")) metadata.put("searchMatched", snapshot.optBoolean("searchMatched"));
                    if (snapshot.has("secretSavedOnPage")) metadata.put("secretSavedOnPage", snapshot.optBoolean("secretSavedOnPage"));
                }
                call.resolve(metadata); return;
            }
            String query = call.getString("query", "").trim();
            if (query.length() > 80 || !safe(query).equals(query) || query.matches("(?s).*[\\x00-\\x1f].*")) { call.reject("搜索只接受简短标签或标题，不接受配置值"); return; }
            JSObject options = new JSObject().put("startSequence", controlSequence).put("query", query).put("step", browser.step).put("secretStage", browser.secretStage); controlSequence += 100;
            evaluate(call, "inspect", options, value -> {
                labels.clear(); JSONArray controls = value.optJSONArray("controls");
                if (controls != null) for (int index = 0; index < controls.length(); index++) {
                    JSONObject control = controls.optJSONObject(index);
                    if (control != null) labels.put(control.optString("target"), control.optString("label"));
                }
                if (value.optBoolean("waitingForUser", false)) browser.setPaused(true);
                JSObject result = metadata(); result.put("controls", controls == null ? new JSArray() : controls);
                if (value.has("pageAccess")) result.put("pageAccess", value.optString("pageAccess"));
                result.put("paused", value.optBoolean("waitingForUser", false));
                result.put("forkOfTarget", value.optBoolean("forkOfTarget", false));
                result.put("pageKind", value.optString("pageKind", "")); result.put("headings", value.optJSONArray("headings"));
                if (value.has("truncated")) result.put("truncated", value.optBoolean("truncated"));
                if (value.has("searchMatched")) result.put("searchMatched", value.optBoolean("searchMatched"));
                if (value.has("applicationList")) result.put("applicationList", value.optJSONObject("applicationList"));
                if (value.has("secretSavedOnPage")) result.put("secretSavedOnPage", value.optBoolean("secretSavedOnPage"));
                snapshot = value; inspectedUrl = browser.web.getUrl(); inspectedDocument = browser.documentId;
                call.resolve(result);
            });
        });
    }
    @PluginMethod public void act(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (!ready(call)) return;
            String operation = call.getString("operation", "");
            if ("prepare-secret".equals(operation) || "submit-secret".equals(operation)) { actSecret(call, operation); return; }
            if (!OPERATIONS.contains(operation) && !"navigate".equals(operation)) { call.reject("不支持的配置操作"); return; }
            if (("fill-endpoint".equals(operation) || "open-install".equals(operation)) && !"agent".equals(browser.mode)) { call.reject("仅代理模式自动填写交互地址或打开安装链接"); return; }
            Integer documentId = call.getInt("documentId");
            if ("navigate".equals(operation)) {
                String destination = call.getString("url", "");
                if (destination.length() > 2000 || !DiscordSetupBrowserPolicy.agentNavigationAllowed(browser.mode, browser.agentRunId, browser.paused && !secretInspection(), browser.loading, browser.failed, browser.step, browser.web.getUrl(), destination)) { call.reject("仅运行中的授权代理任务可导航配置网页；失败公开页可返回其他配置页，不自动重试或越过用户暂停"); return; }
                int beforeDocument = browser.documentId; String beforeUrl = browser.web.getUrl();
                labels.clear(); snapshot = null;
                browser.navigate(destination);
                call.resolve(new JSObject().put("ok", true).put("dispatched", true).put("verified", false).put("documentId", browser.documentId).put("waitingForPage", browser.loading).put("pageChanged", beforeDocument != browser.documentId || !beforeUrl.equals(browser.web.getUrl())).put("waitingForUser", browser.paused && !browser.loading)); return;
            }
            if (browser.paused && !secretInspection() || browser.loading || browser.failed || DiscordSetupBrowserPolicy.userOnly(browser.step, browser.web.getUrl())) { call.reject("请用户先完成当前操作，再允许本页协助"); return; }
            if (documentId == null || documentId != browser.documentId) { call.reject("页面已变化，请重新读取"); return; }
            String target = call.getString("target", "");
            if (!target.isEmpty() && "guide".equals(operation) && (!labels.containsKey(target) || inspectedDocument != browser.documentId || !browser.web.getUrl().equals(inspectedUrl))) { call.reject("指路目标已变化，请重新查看页面"); return; }
            if (!target.isEmpty() && ("fill-endpoint".equals(operation) || "open-install".equals(operation) || "verify-step".equals(operation) || "collect-worker".equals(operation)) && (!labels.containsKey(target) || inspectedDocument != browser.documentId || !browser.web.getUrl().equals(inspectedUrl))) { call.reject("字段已变化，请重新查看实际输入位置"); return; }
            if (("click".equals(operation) || "select".equals(operation) || "fill".equals(operation) || "focus".equals(operation) || "scroll".equals(operation) && !target.isEmpty()) && (!labels.containsKey(target) || inspectedDocument != browser.documentId || !browser.web.getUrl().equals(inspectedUrl))) { call.reject("控件或页面已变化，请重新读取当前控件"); return; }
            JSObject payload = new JSObject(); payload.put("target", target);
            payload.put("label", labels.getOrDefault(target, ""));
            payload.put("value", call.getString("value", "")); payload.put("template", call.getString("template", ""));
            payload.put("direction", call.getString("direction", "down"));
            payload.put("expectedApplicationId", call.getString("expectedApplicationId", ""));
            payload.put("expectedPublicKey", call.getString("expectedPublicKey", ""));
            payload.put("expectedDatabaseId", call.getString("expectedDatabaseId", ""));
            payload.put("expectedRevision", call.getString("expectedRevision", ""));
            payload.put("expectedFork", call.getString("expectedFork", ""));
            if ("verify-step".equals(operation) && "cf-deploy".equals(browser.step) && "deployed".equals(call.getString("deploymentAssessment", ""))) payload.put("deploymentAssessment", "deployed");
            String statusTarget = call.getString("statusTarget", "");
            if (!statusTarget.isEmpty()) {
                if (!"verify-step".equals(operation) || !labels.containsKey(statusTarget) || inspectedDocument != browser.documentId || !browser.web.getUrl().equals(inspectedUrl)) { call.reject("结果状态已变化，请重新观察页面"); return; }
                payload.put("statusTarget", new JSObject().put("target", statusTarget).put("label", labels.get(statusTarget)));
            }
            payload.put("step", browser.step);
            payload.put("secretStage", browser.secretStage);
            if ("collect-config".equals(operation) || "fill-endpoint".equals(operation) || "open-install".equals(operation)) payload.put("step", call.getString("step", browser.step));
            payload.put("allowParameters", "agent".equals(browser.mode) && call.getBoolean("allowParameters", false));
            if ("fill-endpoint".equals(operation)) payload.put("confirmedPreviousEndpoint", call.getString("confirmedPreviousEndpoint", ""));
            for (String field : new String[] { "applicationIdTarget", "publicKeyTarget", "databaseIdTarget" }) {
                String selected = call.getString(field, "");
                if (!selected.isEmpty()) {
                    if (!"collect-config".equals(operation) || !labels.containsKey(selected) || inspectedDocument != browser.documentId || !browser.web.getUrl().equals(inspectedUrl)) { call.reject("字段或页面已变化，请重新查看当前页面再选择"); return; }
                    payload.put(field, new JSObject().put("target", selected).put("label", labels.get(selected)));
                }
            }
            payload.put("validateTemplate", call.getBoolean("validateTemplate", false));
            payload.put("autonomous", !browser.agentRunId.isEmpty());
            payload.put("nativeClick", !browser.agentRunId.isEmpty() && ("click".equals(operation) || "select".equals(operation)));
            Runnable execute = () -> {
                if (!ready(call)) return;
                if (browser.paused && !secretInspection() || browser.documentId != documentId) { call.reject("页面或接手状态已变化，未执行"); return; }
                evaluate(call, operation, payload, call::resolve);
            };
            if (DiscordSetupBrowserPolicy.requiresConfirmation(operation, labels.getOrDefault(target, "")) && browser.agentRunId.isEmpty()) {
                new AlertDialog.Builder(getActivity()).setTitle("确认网页修改")
                    .setMessage(DiscordSetupBrowserPolicy.publicUrl(browser.web.getUrl()) + "\n" + ("template".equals(operation) ? "替换当前编辑内容为教程模板。未提交的编辑会被替换。" : "点击：" + labels.get(target) + "\n将修改当前账号的配置。"))
                    .setPositiveButton("执行这一步", (dialog, which) -> execute.run()).setNegativeButton("取消", (dialog, which) -> call.resolve(new JSObject().put("ok", false).put("cancelled", true))).setOnCancelListener(dialog -> call.resolve(new JSObject().put("ok", false).put("cancelled", true))).show();
            } else execute.run();
        });
    }
    private void actSecret(PluginCall call, String operation) {
        Integer documentId = call.getInt("documentId");
        String stage = browser.secretStage, url = browser.web.getUrl();
        if (browser.loading || browser.failed || documentId == null || documentId != browser.documentId || browser.secretScope == null || !browser.secretScope.equals(DiscordSetupBrowserPolicy.secretScope(url)) || !DiscordSetupBrowserPolicy.secretOperationAllowed(operation, browser.mode, browser.step, url, stage)) { call.reject("仅在用户授权的同一 Worker 固定步骤准备或保存 Secret；页面或接手状态变化时停止"); return; }
        JSObject payload = new JSObject().put("step", "cf-secret").put("secretStage", stage).put("secretMarker", browser.secretMarker);
        String target = call.getString("target", "");
        if (!target.isEmpty()) {
            if (!"submit-secret".equals(operation) || !labels.containsKey(target) || inspectedDocument != browser.documentId || !url.equals(inspectedUrl)) { call.reject("Secret 保存位置已变化，请重新观察公开按钮"); return; }
            payload.put("target", target).put("label", labels.get(target));
        }
        for (String field : new String[] { "secretNameTarget", "secretTypeTarget", "secretValueTarget" }) {
            String selected = call.getString(field, "");
            if (!selected.isEmpty()) {
                if (!"prepare-secret".equals(operation) || !labels.containsKey(selected) || inspectedDocument != browser.documentId || !url.equals(inspectedUrl)) { call.reject("Secret 表单位置已变化，请重新观察公开字段标签"); return; }
                payload.put(field, new JSObject().put("target", selected).put("label", labels.get(selected)));
            }
        }
        Runnable execute = () -> {
            if (!ready(call)) return;
            if (browser.loading || browser.failed || documentId != browser.documentId || !url.equals(browser.web.getUrl()) || !stage.equals(browser.secretStage)) { call.reject("Secret 页面或接手状态变化，未执行"); return; }
            browser.revealForAction(operation);
            evaluate(call, operation, payload, call::resolve);
        };
        if ("submit-secret".equals(operation) && browser.agentRunId.isEmpty()) {
            new AlertDialog.Builder(getActivity()).setTitle("保存并部署 Secret？")
                .setMessage(DiscordSetupBrowserPolicy.publicUrl(url) + "\n只提交你在本页手填的 DISCORD_BOT_TOKEN，并部署到本次 Worker。软件不读取值；点击不代表部署成功，之后仍需核对生产部署。")
                .setPositiveButton("保存并部署", (dialog, which) -> execute.run())
                .setNegativeButton("继续填写", (dialog, which) -> call.resolve(new JSObject().put("ok", false).put("cancelled", true)))
                .setOnCancelListener(dialog -> call.resolve(new JSObject().put("ok", false).put("cancelled", true))).show();
        } else execute.run();
    }
    @PluginMethod public void confirmSuccess(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (!ready(call)) return;
            String step = call.getString("step", "");
            Integer documentId = call.getInt("documentId");
            String checklist = DiscordSetupBrowserPolicy.successChecklist(step);
            if (checklist == null || !step.equals(browser.step) || documentId == null || documentId != browser.documentId || browser.loading || browser.failed) { call.reject("页面未加载成功或步骤已变化，请重新核对"); return; }
            String url = browser.web.getUrl();
            if (!DiscordSetupBrowserPolicy.successLocation(step, url)) { call.reject("请打开本次任务的 Worker 详情或 App 配置页；登录、授权页和总览页不能证明成功"); return; }
            browser.setPaused(true);
            new AlertDialog.Builder(getActivity()).setTitle("核对本步成功条件")
                .setMessage(DiscordSetupBrowserPolicy.publicUrl(url) + "\n\n" + checklist + "\n\n这些网页结果由你核对；软件不会把点击或安装链接当作成功。最终还会检查连接与命令。")
                .setPositiveButton("以上均已确认", (dialog, which) -> call.resolve(new JSObject().put("confirmed", browser != null && browser.active() && documentId == browser.documentId && step.equals(browser.step) && url.equals(browser.web.getUrl()) && !browser.loading && !browser.failed)))
                .setNegativeButton("还没完成", (dialog, which) -> call.resolve(new JSObject().put("confirmed", false)))
                .setOnCancelListener(dialog -> call.resolve(new JSObject().put("confirmed", false))).show();
        });
    }
    private boolean secretInspection() {
        return browser != null && DiscordSetupBrowserPolicy.secretPublicControlsAllowed(browser.mode, browser.agentRunId, browser.step, browser.web.getUrl(), browser.secretScope, browser.secretStage);
    }
    private boolean secretReadback() {
        return browser != null && DiscordSetupBrowserPolicy.secretMetadataAllowed(browser.mode, browser.agentRunId, browser.step, browser.web.getUrl(), browser.secretScope, browser.secretStage);
    }
    private boolean ready(PluginCall call) {
        if (browser == null || !browser.active() || browser.web.getUrl() == null) { call.reject("配置浏览器未打开，请先打开当前步骤"); return false; }
        if (!DiscordSetupBrowserPolicy.browseAllowed(browser.web.getUrl())) { call.reject("当前页面不是受支持的HTTPS网页"); return false; }
        return true;
    }
    private JSObject metadata() {
        JSObject value = new JSObject().put("documentId", browser.documentId).put("url", DiscordSetupBrowserPolicy.publicUrl(browser.web.getUrl())).put("loading", browser.loading).put("paused", browser.paused || DiscordSetupBrowserPolicy.userOnly(browser.step, browser.web.getUrl()));
        value.put("chatOpen", browser.chatOpen);
        if ("discord-install".equals(browser.step)) value.put("installationCompleted", browser.installationCompleted && browser.installationApplicationId.matches("[0-9]{17,20}") && browser.installationApplicationId.equals(browser.installationStartedApp));
        value.put("failed", browser.failed).put("pageAccess", DiscordSetupBrowserPolicy.pageAccess(browser.step, browser.web.getUrl()));
        if (snapshot != null && inspectedDocument == browser.documentId && browser.web.getUrl().equals(inspectedUrl) && snapshot.has("pageAccess")) value.put("pageAccess", snapshot.optString("pageAccess"));
        if ("cf-secret".equals(browser.step) && browser.secretScope != null && browser.secretScope.equals(DiscordSetupBrowserPolicy.secretScope(browser.web.getUrl())) && !browser.loading && !browser.secretStage.isEmpty()) value.put("secretStage", browser.secretStage);
        return value;
    }
    interface Result { void accept(JSObject value); }
    private void cancelInstallationWatch() {
        installationMarker = null; installationUrl = null; installationDocument = -1;
        if (browser != null && browser.web != null) browser.web.evaluateJavascript("window.__srlDiscordInstallationCancel?.()", null);
    }
    private void watchInstallation() {
        if (browser == null || !browser.active() || browser.loading || browser.failed) return;
        String url = browser.web.getUrl(), app = browser.installationApplicationId;
        boolean started = !app.isEmpty() && app.equals(browser.installationStartedApp);
        if (!"discord-install".equals(browser.step) || !DiscordSetupBrowserPolicy.installationResultPage(url, app, started)) { cancelInstallationWatch(); return; }
        if (installationDocument == browser.documentId && url.equals(installationUrl)) return;
        cancelInstallationWatch();
        installationDocument = browser.documentId; installationUrl = url;
        installationMarker = "srl-" + java.util.UUID.randomUUID();
        String marker = installationMarker;
        try {
            loadExecutor();
            JSObject options = new JSObject().put("marker", marker).put("expectedApplicationId", app).put("installationStarted", started);
            browser.web.evaluateJavascript(executor + "('watch-installation'," + options + ")", raw -> {
                try { if (new JSONObject(raw).optBoolean("installationCompleted", false)) installationReady(marker); }
                catch (Exception ignored) { /* No public completion proof; keep the user's handoff. */ }
            });
        } catch (Exception ignored) { cancelInstallationWatch(); }
    }
    private void installationReady(String marker) {
        if (browser == null || !browser.active() || browser.loading || browser.failed || !"discord-install".equals(browser.step) || !marker.equals(installationMarker) || installationDocument != browser.documentId || !browser.web.getUrl().equals(installationUrl) || browser.installationCompleted) return;
        browser.installationCompleted = true;
        browser.installationStartedApp = browser.installationApplicationId;
        browser.message("Discord 已确认授权完成，点我继续资源库连接与命令核验。");
        browser.phase("Discord 授权已完成，等待你继续");
        notifyListeners("setupAction", new JSObject().put("action", "installation-ready").put("applicationId", browser.installationApplicationId));
    }
    private void loadExecutor() throws Exception {
        if (executor != null) return;
        try (java.io.InputStream stream = getContext().getAssets().open("discord-setup.js"); java.io.ByteArrayOutputStream content = new java.io.ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192]; int count;
            while ((count = stream.read(buffer)) != -1) content.write(buffer, 0, count);
            executor = new String(content.toByteArray(), StandardCharsets.UTF_8);
        }
    }
    @PluginMethod public void captureBotSecret(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (!ready(call)) return;
            String app = call.getString("applicationId", ""), key = call.getString("publicKey", "");
            Integer requestedDocument = call.getInt("documentId");
            if (!"agent".equals(browser.mode) || browser.loading || browser.failed || requestedDocument == null || requestedDocument != browser.documentId || !DiscordSetupBrowserPolicy.botSecretLocation(browser.web.getUrl(), app)) { call.reject("请先打开本次 App 的 Bot 页面并显示 Token"); return; }
            int document = browser.documentId;
            try {
                loadExecutor();
                String script = "(" + executor.trim().replaceFirst(";\\s*$", "") + ")(\"capture-bot-secret\"," + new JSObject().put("expectedApplicationId", app) + ")";
                browser.web.evaluateJavascript(script, raw -> {
                    if (browser == null || !browser.active() || browser.documentId != document || !DiscordSetupBrowserPolicy.botSecretLocation(browser.web.getUrl(), app)) { call.reject("网页已变化，密钥结果已丢弃"); return; }
                    JSONObject receipt = null;
                    try {
                        receipt = new JSONObject(raw);
                        if (!receipt.optBoolean("ok", false)) { call.reject(DiscordSetupBrowserPolicy.botSecretCaptureError(receipt.optString("reason", ""))); return; }
                        Map<String, String> encrypted = DiscordSetupSecretTransfer.seal(receipt.optString("secret", ""), key);
                        JSObject result = new JSObject(); encrypted.forEach(result::put); call.resolve(result);
                    } catch (Exception ignored) { call.reject("本机密钥加密转填未完成，未发送给模型"); }
                    finally { if (receipt != null) receipt.remove("secret"); }
                });
            } catch (Exception ignored) { call.reject("本机密钥保存工具不可用"); }
        });
    }
    @PluginMethod public void fillBotSecret(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (!ready(call)) return;
            Integer document = call.getInt("documentId");
            if (!"agent".equals(browser.mode) || browser.agentRunId.isEmpty() || !"cf-secret".equals(browser.step) || !"input".equals(browser.secretStage) || browser.loading || browser.failed || document == null || document != browser.documentId || browser.secretScope == null || !browser.secretScope.equals(DiscordSetupBrowserPolicy.secretScope(browser.web.getUrl()))) { call.reject("请先准备本次 Worker 的 Secret 表单"); return; }
            JSObject payload = new JSObject().put("step", "cf-secret").put("secretStage", "input").put("secretMarker", browser.secretMarker).put("secret", call.getString("secret", ""));
            evaluate(call, "fill-stored-secret", payload, result -> call.resolve(new JSObject().put("ok", result.optBoolean("ok", false))));
        });
    }
    private void evaluate(PluginCall call, String operation, JSObject payload, Result done) {
        int documentId = browser.documentId; String url = browser.web.getUrl();
        String runId = browser.agentRunId;
        String step = browser.step;
        boolean fixedSecret = "prepare-secret".equals(operation) || "submit-secret".equals(operation) || "fill-stored-secret".equals(operation);
        boolean statusWait = "watch-status".equals(operation) || "check-status".equals(operation);
        try {
            loadExecutor();
            String script = "(" + executor.trim().replaceFirst(";\\s*$", "") + ")(" + JSONObject.quote(operation) + "," + payload.toString() + ")";
            browser.web.evaluateJavascript(script, raw -> {
                if (statusWait && pendingWait != call) return;
                if (browser == null || !browser.active()) { rejectEvaluation(call, "页面已关闭，未采用旧回执；页面关闭不说明原操作失败，继续前核验现有结果"); return; }
                if (!runId.equals(browser.agentRunId)) { rejectEvaluation(call, "任务运行已变化，旧回执不恢复任务；不据此认定已发出的保存/部署失败，继续前核验现有结果"); return; }
                if (!step.equals(browser.step)) { rejectEvaluation(call, "配置步骤已变化，旧结果不用于新步骤；不据此认定原操作失败"); return; }
                JSONObject receipt;
                try {
                    receipt = new JSONObject(raw);
                    if (receipt.has("waitingForUser")) receipt.put("waitingForUser", DiscordSetupBrowserPolicy.userHandoffRequired(operation, receipt.optBoolean("waitingForUser", false), runId));
                }
                catch (Exception error) { rejectEvaluation(call, "网页未返回可验证回执，操作是否生效尚未核验；先 inspect 现有结果，不重复提交，没有发送页面源码"); return; }
                if (fixedSecret) {
                    if ("fill-stored-secret".equals(operation) && (runId.isEmpty() || !runId.equals(browser.agentRunId) || documentId != browser.documentId || !url.equals(browser.web.getUrl()))) { rejectEvaluation(call, "任务或输入页面已变化，未继续保存"); return; }
                    if (!"cf-secret".equals(browser.step) || !payload.optString("secretStage").equals(browser.secretStage) || browser.secretScope == null || !browser.secretScope.equals(DiscordSetupBrowserPolicy.secretScope(browser.web.getUrl()))) { rejectEvaluation(call, "Secret 页面或接手状态变化，结果已丢弃"); return; }
                } else if (documentId != browser.documentId || !url.equals(browser.web.getUrl()) || browser.paused && !secretInspection() && !("inspect".equals(operation) && secretReadback())) {
                    JSObject dispatched = navigationReceipt(operation, receipt, documentId != browser.documentId || !url.equals(browser.web.getUrl()), !runId.isEmpty() && runId.equals(browser.agentRunId));
                    if (dispatched != null) {
                        dispatched.put("documentId", browser.documentId).put("waitingForPage", browser.loading).put("waitingForUser", dispatched.optBoolean("waitingForUser", false) || browser.paused && !browser.loading);
                        done.accept(dispatched); return;
                    }
                    rejectEvaluation(call, "页面或接手状态已变化，本次读取/核验不用于当前页；重新 inspect，不据此认定此前保存或部署失败"); return;
                }
                try {
                    if (receipt.optBoolean("ok", false) && receipt.optJSONObject("clickPoint") != null) {
                        if (!browser.clickPublicTarget(receipt.optJSONObject("clickPoint"), documentId, runId)) { rejectEvaluation(call, "未确认完整点击手势，动作是否生效尚未核验；inspect 当前结果，不用脚本重复点击"); return; }
                        receipt.remove("clickPoint"); receipt.put("dispatched", true).put("verified", false);
                        if (!runId.equals(browser.agentRunId) || !step.equals(browser.step)) { rejectEvaluation(call, "任务或步骤已停止/变化，已发出的动作不自动重试；先核对当前结果"); return; }
                    }
                    JSObject result = sanitize(receipt, "collect-config".equals(operation) && payload.optBoolean("allowParameters", false));
                    if ("open-install".equals(operation) && result.optBoolean("ok", false)) {
                        String installUrl = receipt.optString("installUrl", "");
                        if (!DiscordSetupBrowserPolicy.installLink(installUrl, payload.optString("expectedApplicationId"))) { rejectEvaluation(call, "安装链接不属于本次 App 或超出安装范围"); return; }
                        browser.setPaused(true);
                        browser.installationStartedApp = payload.optString("expectedApplicationId");
                        browser.web.loadUrl(installUrl);
                        result.put("dispatched", true).put("waitingForUser", true);
                    }
                    if (fixedSecret && result.optBoolean("ok", false)) {
                        String stage = result.optString("secretStage", "");
                        if ("input".equals(stage) && (documentId != browser.documentId || !url.equals(browser.web.getUrl()))) { rejectEvaluation(call, "输入表单已变化，请重新准备"); return; }
                        browser.secretStage = stage; browser.setPaused(!secretInspection());
                        if ("submitted".equals(stage)) browser.message("已发出保存部署操作，助手会核验生产结果；点击不代表成功，密钥值不会读取。");
                    }
                    if (result.has("guideAnchor")) browser.point(result.optJSONObject("guideAnchor"), result.optString("guideText"));
                    if (result.optBoolean("waitingForUser", false) && !fixedSecret) { browser.setPaused(true); browser.message("open-install".equals(operation) ? "已打开本次 App 的安装链接。请自己选择账号、安装目标并授权；安装完成后回到 Installation 页，再点我继续。" : "fill-endpoint".equals(operation) ? "已填写 Worker 根网址 + /interactions；请保存并确认 Discord 验证通过，再点我继续。" : "请在标出的网页位置填写；填好后点蒜惹菈，选择“填好了，继续”。"); }
                    if (result.optBoolean("dispatched", false) || result.optBoolean("filled", false) || result.optBoolean("written", false)) {
                        boolean changed = documentId != browser.documentId || !url.equals(browser.web.getUrl());
                        result.put("documentId", browser.documentId).put("pageChanged", changed).put("waitingForPage", browser.loading);
                        result.put("waitingForUser", result.optBoolean("waitingForUser", false) || browser.paused && !browser.loading);
                        if (changed) result.put("verified", false);
                        snapshot = null;
                    } else if (result.optBoolean("focused", false) || result.optBoolean("moved", false)) snapshot = null;
                    done.accept(result);
                }
                catch (Exception error) { rejectEvaluation(call, "回执处理未完成，操作是否生效尚未核验；先 inspect 现有结果，不重复提交，没有发送页面源码"); }
            });
        } catch (Exception error) { rejectEvaluation(call, "配置执行器不可用"); }
    }
    private void rejectEvaluation(PluginCall call, String message) {
        if (pendingWait == call) { pendingWait = null; cancelStatus(); }
        call.reject(message);
    }
    private static String safe(String value) { String clean = DiscordSetupBrowserPolicy.maskSecrets(value); return clean.substring(0, Math.min(140, clean.length())); }
    static JSObject navigationReceipt(String operation, JSONObject receipt, boolean pageChanged, boolean sameRun) {
        boolean applied = receipt.optBoolean("dispatched", false)
            || ("fill".equals(operation) || "fill-endpoint".equals(operation)) && receipt.optBoolean("filled", false)
            || "template".equals(operation) && receipt.optBoolean("written", false);
        if (!pageChanged || !sameRun || !java.util.Arrays.asList("click", "select", "fill", "template", "fill-endpoint").contains(operation) || !receipt.optBoolean("ok", false) || !applied || receipt.has("clickPoint")) return null;
        JSObject result = new JSObject().put("ok", true).put("dispatched", true).put("verified", false).put("pageChanged", true)
            .put("hint", "动作已发出并发生页面跳转，不代表创建或部署成功；加载中用wait-page，随后inspect当前页核验结果，不重复点击旧入口。");
        if (receipt.opt("filled") instanceof Boolean) result.put("filled", receipt.optBoolean("filled"));
        if (receipt.opt("written") instanceof Boolean) result.put("written", receipt.optBoolean("written"));
        if (receipt.opt("waitingForUser") instanceof Boolean) result.put("waitingForUser", receipt.optBoolean("waitingForUser"));
        return result;
    }
    private static String safeReply(String value) { String clean = DiscordSetupBrowserPolicy.maskSecrets(value); return clean.substring(0, Math.min(16000, clean.length())); }
    static JSObject sanitize(JSONObject value, boolean allowParameters) {
        JSObject result = new JSObject().put("ok", value.optBoolean("ok", false));
        if (value.optString("pageAccess", "").matches("public|authentication|protected")) result.put("pageAccess", value.optString("pageAccess"));
        if (value.opt("searchMatched") instanceof Boolean) result.put("searchMatched", value.optBoolean("searchMatched"));
        if (value.opt("secretSavedOnPage") instanceof Boolean) result.put("secretSavedOnPage", value.optBoolean("secretSavedOnPage"));
        if (value.optBoolean("configurationConflict", false)) {
            result.put("configurationConflict", true);
            String endpoint = value.optString("previousEndpoint", "");
            if (endpoint.length() <= 2000 && endpoint.startsWith("https://") && safe(endpoint).equals(endpoint)) result.put("previousEndpoint", endpoint);
        }
        String pageKind = value.optString("pageKind", "");
        if (pageKind.matches("discord-app-list|discord-app-information|discord-app-installation|discord-other|d1-detail|worker-detail|worker-site|cloudflare-overview|wrangler-editor|wrangler-file|github-fork|github-repository|github-app-installation")) result.put("pageKind", pageKind);
        JSONObject applications = value.optJSONObject("applicationList");
        if ("discord-app-list".equals(pageKind) && applications != null && applications.optString("state").matches("available|empty|unknown") && applications.optInt("count", -1) >= 0) result.put("applicationList", new JSObject().put("state", applications.optString("state")).put("count", applications.optInt("count")));
        JSONArray headings = value.optJSONArray("headings");
        if (headings != null) { JSArray clean = new JSArray(); for (int index = 0; index < Math.min(12, headings.length()); index++) clean.put(safe(headings.optString(index))); result.put("headings", clean); }
        String stage = value.optString("secretStage", "");
        if (stage.matches("prepare|input|submit|saved|submitted")) result.put("secretStage", stage);
        String preparedAction = value.optString("preparedAction", "");
        if (preparedAction.matches("settings|add|edit|type|name")) result.put("preparedAction", preparedAction);
        if (allowParameters && value.optJSONObject("parameters") != null) {
            JSONObject input = value.optJSONObject("parameters"); JSObject parameters = new JSObject();
            for (String key : new String[] { "applicationId", "publicKey", "databaseId" }) {
                String text = input.optString(key, "");
                String pattern = "applicationId".equals(key) ? "[0-9]{17,20}" : "publicKey".equals(key) ? "(?i)[a-f0-9]{64}" : "(?i)[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
                if (text.matches(pattern)) parameters.put(key, text);
            }
            result.put("parameters", parameters);
        }
        JSONObject anchor = value.optJSONObject("guideAnchor");
        if (anchor != null) {
            boolean valid = true;
            for (String key : new String[] { "left", "top", "right", "bottom" }) { double coordinate = anchor.optDouble(key, Double.NaN); valid &= Double.isFinite(coordinate) && coordinate >= 0 && coordinate <= 1; }
            if (valid && anchor.optDouble("left") < anchor.optDouble("right") && anchor.optDouble("top") < anchor.optDouble("bottom")) result.put("guideAnchor", anchor).put("guideText", safe(value.optString("guideText", "请在标出的位置填写")));
        }
        String workerUrl = value.optString("workerUrl", "");
        if (value.optString("revision").matches("(?i)[a-f0-9]{40}")) result.put("revision", value.optString("revision").toLowerCase());
        try {
            java.net.URI uri = java.net.URI.create(workerUrl);
            if ("https".equals(uri.getScheme()) && uri.getHost().endsWith(".workers.dev") && uri.getRawUserInfo() == null && uri.getPort() == -1 && uri.getRawQuery() == null && uri.getRawFragment() == null && (uri.getPath().isEmpty() || "/".equals(uri.getPath()))) result.put("workerUrl", workerUrl);
        } catch (RuntimeException error) { /* No unsafe URL leaves the native executor. */ }
        for (String key : new String[] { "waitingForUser", "waitingForPage", "pageChanged", "recovery", "written", "filled", "dispatched", "verified", "formatOnly", "forkOfTarget", "moved", "atEnd", "changed", "observing", "focused", "truncated", "disabled" }) if (value.has(key)) result.put(key, value.optBoolean(key));
        JSONArray errors = value.optJSONArray("errors");
        if (errors != null) { JSArray clean = new JSArray(); for (int index = 0; index < Math.min(10, errors.length()); index++) clean.put(safe(errors.optString(index))); result.put("errors", clean); }
        JSONArray controls = value.optJSONArray("controls");
        if (controls != null) {
            JSArray clean = new JSArray();
            for (int index = 0; index < Math.min(100, controls.length()); index++) {
                JSONObject control = controls.optJSONObject(index); if (control == null || !control.optString("target").matches("[0-9]{1,10}")) continue;
                JSObject item = new JSObject().put("target", control.optString("target")).put("label", safe(control.optString("label"))).put("kind", safe(control.optString("kind"))).put("sensitive", control.optBoolean("sensitive", true));
                if (control.has("checked")) item.put("checked", control.optBoolean("checked"));
                if (control.has("disabled")) item.put("disabled", control.optBoolean("disabled"));
                if (control.has("visible")) item.put("visible", control.optBoolean("visible"));
                if (control.has("context")) item.put("context", safe(control.optString("context")));
                if (!control.optBoolean("sensitive", true) && control.optBoolean("invalid", false)) {
                    item.put("invalid", true);
                    JSONArray feedback = control.optJSONArray("feedback");
                    if (feedback != null) { JSArray messages = new JSArray(); for (int message = 0; message < Math.min(3, feedback.length()); message++) messages.put(safe(feedback.optString(message))); item.put("feedback", messages); }
                }
                clean.put(item);
            }
            result.put("controls", clean);
        }
        return result;
    }
    @PluginMethod public void close(PluginCall call) { getActivity().runOnUiThread(() -> { if (browser != null && call.getBoolean("keepRunning", false)) { browser.hideForChat(); call.resolve(); return; } cancelStatus(); cancelInstallationWatch(); if (browser != null) browser.close(); if (pendingWait != null) { PluginCall waiting = pendingWait; pendingWait = null; waiting.resolve(metadata().put("paused", true)); } call.resolve(); }); }
    @PluginMethod public void waitReady(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (browser == null || !browser.active()) { call.reject("配置浏览器未打开"); return; }
            if (!browser.loading || DiscordSetupBrowserPolicy.authentication(browser.web.getUrl())) { call.resolve(metadata()); return; }
            if (pendingWait != null) { call.reject("已有网页加载等待，未重复等待"); return; }
            pendingWait = call;
        });
    }
    @PluginMethod public void waitStatus(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (!ready(call)) return;
            String target = call.getString("target", ""); Integer documentId = call.getInt("documentId");
            if (pendingWait != null || !DiscordSetupBrowserPolicy.statusWaitAllowed(browser.mode, browser.agentRunId, browser.paused, browser.loading, browser.failed, browser.step, browser.web.getUrl()) || documentId == null || documentId != browser.documentId || inspectedDocument != documentId || !browser.web.getUrl().equals(inspectedUrl) || !labels.containsKey(target)) { call.reject("请先观察当前运行中的实际状态；不启动重复等待"); return; }
            String marker = "srl-" + java.util.UUID.randomUUID();
            JSObject payload = new JSObject().put("step", browser.step).put("target", target).put("label", labels.get(target)).put("marker", marker);
            pendingWait = call; statusMarker = marker; statusPayload = payload;
            evaluate(call, "watch-status", payload, value -> {
                if (!value.optBoolean("observing", false)) { pendingWait = null; cancelStatus(); call.reject("没有识别到可等待的实际状态"); }
            });
        });
    }
    private void statusReady(String marker) {
        if (statusChecking || pendingWait == null || statusMarker == null || !statusMarker.equals(marker) || statusPayload == null || browser == null || browser.agentRunId.isEmpty()) return;
        PluginCall waiting = pendingWait; JSObject payload = statusPayload;
        statusChecking = true;
        evaluate(waiting, "check-status", payload, result -> {
            if (!marker.equals(statusMarker)) return;
            statusChecking = false;
            if (result.optBoolean("changed", false) || result.optBoolean("waitingForUser", false)) { pendingWait = null; cancelStatus(); waiting.resolve(metadata().put("paused", browser.paused || result.optBoolean("waitingForUser", false))); }
        });
    }
    private void cancelStatus() {
        if (statusMarker != null && browser != null && browser.web != null) browser.web.evaluateJavascript("try { window.__srlDiscordCancelWait?.(); } catch (_) {}", null);
        statusMarker = null; statusPayload = null; statusChecking = false;
    }
    @PluginMethod public void cancelWait(PluginCall call) { getActivity().runOnUiThread(() -> { cancelStatus(); if (pendingWait != null) { PluginCall waiting = pendingWait; pendingWait = null; waiting.resolve(metadata().put("paused", true)); } call.resolve(); }); }
    @PluginMethod public void pauseAgent(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            cancelStatus();
            if (browser != null) { browser.agentRun(""); browser.secretStage = ""; browser.secretScope = null; browser.setPaused(true); }
            if (pendingWait != null) { PluginCall waiting = pendingWait; pendingWait = null; waiting.resolve(metadata().put("paused", true)); }
            call.resolve();
        });
    }
    @PluginMethod public void suspend(PluginCall call) { getActivity().runOnUiThread(() -> call.resolve(new JSObject().put("suspended", browser != null && browser.suspend()))); }
    @PluginMethod public void restore(PluginCall call) { getActivity().runOnUiThread(() -> { if (browser != null) browser.restore(call.getBoolean("resume", false)); call.resolve(); }); }
    @PluginMethod public void pet(PluginCall call) {
        String frame = call.getString("dataUrl", "");
        if (!frame.startsWith("data:image/png;base64,") || frame.length() > 262144) { call.reject("桌宠图片无效"); return; }
        getActivity().runOnUiThread(() -> { petFrame = frame; if (browser != null) browser.petFrame(frame); call.resolve(); });
    }
    @PluginMethod public void message(PluginCall call) { getActivity().runOnUiThread(() -> { if (browser != null) { String text = call.getString("text", ""); if (!text.isEmpty()) browser.message(safeReply(text)); String phase = call.getString("phase"); if (phase != null) browser.phase(safe(phase)); } call.resolve(); }); }
    @Override protected void handleOnPause() { if (browser != null) browser.background(); super.handleOnPause(); }
    @Override protected void handleOnResume() { super.handleOnResume(); if (browser != null) browser.foreground(); }
    @Override protected void handleOnDestroy() { cancelStatus(); cancelInstallationWatch(); if (pendingWait != null) { pendingWait.reject("配置浏览器已关闭"); pendingWait = null; } if (browser != null) browser.destroy(); super.handleOnDestroy(); }
}
