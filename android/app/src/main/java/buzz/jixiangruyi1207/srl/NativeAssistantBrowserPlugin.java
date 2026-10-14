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

@CapacitorPlugin(name = "NativeAssistantBrowser")
public class NativeAssistantBrowserPlugin extends Plugin {
    private AssistantBrowserWindow browser;
    private String executor;
    private String petFrame;
    private volatile long fileGeneration;
    private volatile okhttp3.Call fileTransfer;
    private androidx.activity.result.ActivityResultLauncher<android.content.Intent> filePicker;
    private android.webkit.ValueCallback<android.net.Uri[]> pendingUpload;
    private String uploadRun;
    private boolean pickerInFlight;
    private long pickerGeneration;
    private android.webkit.ValueCallback<android.net.Uri[]> pickerReceiver;
    private int uploadDocument, uploadTab;
    private String pendingDownloadUrl, pendingDownloadName, pendingDownloadMime;
    private int pendingDownloadDocument, pendingDownloadTab;
    @Override public void load() {
        filePicker = NativeFilePickerPlugin.registerBrowserPicker(getActivity(), files -> {
            android.webkit.ValueCallback<android.net.Uri[]> receiver = pickerReceiver; pickerReceiver = null; pickerInFlight = false;
            boolean sameSelection = receiver != null && receiver == pendingUpload && pickerGeneration == fileGeneration;
            if (sameSelection) pendingUpload = null;
            boolean current = sameSelection && browser != null && browser.active() && uploadRun != null && uploadRun.equals(browser.agentRunId)
                && uploadDocument == browser.documentId && uploadTab == browser.activeTabId();
            if (receiver != null) receiver.onReceiveValue(current ? files : null);
            if (current) { browser.setPaused(false); notifyBrowser(new JSObject().put("action", "page-ready")); }
        });
    }
    private void handleWindowAction(JSObject event) {
        if ("agent-pause".equals(event.optString("action")) || "return".equals(event.optString("action"))) stopFiles();

        if ("installation-ready".equals(event.optString("action"))) { installationReady(event.optString("marker")); return; }
        if ("page-ready".equals(event.optString("action"))) watchInstallation();
        if ("agent-pause".equals(event.optString("action")) && !browser.active()) cancelInstallationWatch();
        if ("status-ready".equals(event.optString("action"))) { statusReady(event.optString("marker")); return; }
        if ("agent-pause".equals(event.optString("action")) && pendingWait != null) { PluginCall waiting = pendingWait; pendingWait = null; cancelStatus(); waiting.resolve(metadata().put("paused", true)); }
        if ("page-ready".equals(event.optString("action")) && pendingWait != null) { PluginCall waiting = pendingWait; pendingWait = null; cancelStatus(); waiting.resolve(metadata()); return; }
        notifyBrowser(event);
    }
    private void notifyBrowser(JSObject event) {
        if (browser == null) return;
        event.put("runId", browser.taskRunId).put("conversationId", browser.conversationId).put("paused", browser.paused).put("loading", browser.loading);
        notifyListeners(browser.generalMode ? "browserAction" : "setupAction", event);
    }
    private void stopFiles() {
        cancelDelay();
        fileGeneration++; okhttp3.Call transfer = fileTransfer; if (transfer != null) transfer.cancel();
        if (pendingUpload != null) { pendingUpload.onReceiveValue(null); pendingUpload = null; }
        pendingDownloadUrl = null;
    }
    private void connectFiles() {
        browser.upload = (view, receiver, params) -> {
            if (pickerInFlight) { receiver.onReceiveValue(null); browser.message("系统文件选择器尚未返回，当前输入没有改动。"); return true; }
            long uploadGeneration = fileGeneration;
            if (pendingUpload != null) pendingUpload.onReceiveValue(null);
            pendingUpload = receiver; uploadRun = browser.agentRunId;
            uploadDocument = browser.documentId; uploadTab = browser.activeTabId();
            browser.setPaused(true);
            new AlertDialog.Builder(getActivity()).setTitle("向当前网站上传文件")
                .setMessage("由你选择文件。文件直接交给当前网页，不向模型发送文件内容。")
                .setPositiveButton("选择文件", (dialog, which) -> {
                    if (pendingUpload != receiver || uploadGeneration != fileGeneration || browser == null || !browser.active() || uploadDocument != browser.documentId || uploadTab != browser.activeTabId()) { receiver.onReceiveValue(null); return; }
                    pickerInFlight = true; pickerGeneration = uploadGeneration; pickerReceiver = receiver;
                    filePicker.launch(NativeFilePickerPlugin.browserFileIntent(params.getAcceptTypes(), params.getMode() == android.webkit.WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE));
                }).setNegativeButton("取消", (dialog, which) -> cancelUpload(receiver, uploadGeneration))
                .setOnCancelListener(dialog -> cancelUpload(receiver, uploadGeneration)).show();
            return true;
        };
        browser.download = (url, userAgent, disposition, mime) -> {
            if (!AssistantBrowserPolicy.browseAllowed(url)) { browser.message("当前文件不是 HTTPS 下载链接，尚未下载。"); return; }
            pendingDownloadUrl = url; pendingDownloadName = android.webkit.URLUtil.guessFileName(url, disposition, mime);
            pendingDownloadMime = mime; pendingDownloadDocument = browser.documentId; pendingDownloadTab = browser.activeTabId();
            browser.loading = false;
            if (!browser.agentRunId.isEmpty() && !browser.taskFinished) browser.setPaused(false);
            browser.message("网站已提供文件下载。助手可确认保存到下载目录，或交给原资源导入流程。");
            notifyBrowser(new JSObject().put("action", "page-ready"));
        };
    }
    private void cancelUpload(android.webkit.ValueCallback<android.net.Uri[]> receiver, long generation) {
        if (pendingUpload != receiver || generation != fileGeneration) return;
        pendingUpload = null; receiver.onReceiveValue(null);
        if (browser != null && browser.active() && uploadRun != null && uploadRun.equals(browser.agentRunId)
            && uploadDocument == browser.documentId && uploadTab == browser.activeTabId()) {
            browser.setPaused(false); notifyBrowser(new JSObject().put("action", "page-ready"));
        }
    }
    private final Map<String, String> labels = new HashMap<>();
    private final Map<String, String> referenceKinds = new HashMap<>();
    private final Set<String> sensitiveTargets = new java.util.HashSet<>();
    private JSObject snapshot;
    private String inspectedUrl;
    private int inspectedDocument = -1;
    private long controlSequence;
    private PluginCall pendingWait;
    private PluginCall pendingDelay;
    private Runnable delayCallback;
    private final android.os.Handler delayHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private void cancelDelay() {
        if (delayCallback != null) delayHandler.removeCallbacks(delayCallback);
        delayCallback = null;
        if (pendingDelay != null) { pendingDelay.reject("等待已停止，旧回执不继续任务"); pendingDelay = null; }
    }
    private String statusMarker;
    private JSObject statusPayload;
    private boolean statusChecking;
    private String installationMarker, installationUrl;
    private int installationDocument = -1;
    private static final Set<String> OPERATIONS = new java.util.HashSet<>(java.util.Arrays.asList("click", "upload", "select", "fill", "focus", "scroll", "press", "template", "validate", "guide", "collect-worker", "collect-config", "fill-endpoint", "open-install", "verify-step"));
    @PluginMethod public void currentTask(PluginCall call) { getActivity().runOnUiThread(() -> {
        JSObject state = browser == null ? new JSObject() : metadata();
        call.resolve(state.put("active", browser != null && browser.active()).put("purpose", browser != null && browser.generalMode ? "general" : "discord-setup")
            .put("agentRunId", browser == null ? "" : browser.agentRunId).put("runId", browser == null ? "" : browser.taskRunId).put("conversationId", browser == null ? "" : browser.conversationId).put("finished", browser != null && browser.taskFinished));
    }); }
    @PluginMethod public void open(PluginCall call) {
        boolean general = "general".equals(call.getString("purpose", "discord-setup"));
        String url = call.getString("url");
        if (url != null && !(general ? AssistantBrowserPolicy.browseAllowed(url) : AssistantBrowserPolicy.allowed(url))) { call.reject(general ? "只支持公开 HTTPS 网页，拒绝私网、本地地址和非标准端口" : "配置浏览器支持 GitHub、Cloudflare、Discord 和 workers.dev HTTPS 配置页面"); return; }
        if (general && url == null && browser == null) { call.reject("首次网页任务需要明确的 HTTPS 地址"); return; }
        String step = general ? "browser-general" : call.getString("step", "");
        JSArray steps = call.getArray("steps", new JSArray());
        boolean knownStep = false;
        for (int index = 0; index < steps.length(); index++) if (step.equals(steps.optJSONObject(index).optString("id"))) knownStep = true;
        if (!general && !knownStep) { call.reject("配置步骤无效"); return; }
        getActivity().runOnUiThread(() -> {
            if (general && url == null && (browser == null || !browser.active())) { call.reject("网页任务已经关闭，请明确打开新的网页任务"); return; }
            if (browser == null) browser = new AssistantBrowserWindow(getActivity(), getBridge().getWebView(), this::handleWindowAction);
            String requestedConversation = call.getString("conversationId", "");
            if (browser.generalMode != general || !browser.conversationId.equals(requestedConversation)) { stopFiles(); browser.destroy(); browser = null; }
            if (browser == null) {
                browser = new AssistantBrowserWindow(getActivity(), getBridge().getWebView(), this::handleWindowAction);
                connectFiles();
            }
            browser.generalMode = general;
            browser.mode = call.getString("mode", "agent");
            if (browser.conversation(call.getString("conversationId", ""))) cancelInstallationWatch();
            browser.installation(call.getString("expectedApplicationId", ""), step);
            String requestedRun = call.getString("agentRunId", "");
            String ownerTask = call.getString("ownerTaskId", requestedRun);
            if (!ownerTask.isEmpty()) { if (!ownerTask.equals(browser.taskRunId)) browser.taskFinished = false; browser.taskRunId = ownerTask; }
            connectFiles();
            browser.agentRun(requestedRun);
            String site = call.getString("site", "");
            String root = general ? url : "github".equals(site) ? "https://github.com/" : "discord".equals(site) ? "https://discord.com/developers/applications" : "https://dash.cloudflare.com/";
            String current = browser.web == null ? null : browser.web.getUrl();
            String target = general && call.getBoolean("resumeCurrent", false) && AssistantBrowserPolicy.browseAllowed(current) ? null : general ? url : AssistantBrowserPolicy.openingUrl(url, current, call.getBoolean("resumeCurrent", false), step.equals(browser.step), root);
            browser.open(target, step, call.getString("title", general ? "网页任务" : "Discord 配置"), call.getString("hint", ""), steps, call.getString("template", ""), general ? false : call.getBoolean("chooseStep", false), call.getBoolean("darkTheme", false), general, call.getBoolean("foreground", false));
            browser.petFrame(petFrame);
            if (call.getBoolean("showControls", false)) browser.controls();
            watchInstallation();
            labels.clear(); referenceKinds.clear(); sensitiveTargets.clear(); snapshot = null; inspectedUrl = null; inspectedDocument = -1; call.resolve();
        });
    }
    @PluginMethod public void inspect(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (!ready(call)) return;
            JSObject metadata = metadata();
            if (browser.paused && !secretReadback() || browser.loading || pageUserOnly()) { metadata.put("paused", true); call.resolve(metadata); return; }
            if (call.getBoolean("metadataOnly", false)) {
                if (snapshot != null && inspectedDocument == browser.documentId && browser.web.getUrl().equals(inspectedUrl)) {
                    metadata.put("controls", snapshot.optJSONArray("controls")); metadata.put("forkOfTarget", snapshot.optBoolean("forkOfTarget", false));
                    if (snapshot.has("repository")) metadata.put("repository", snapshot.optJSONObject("repository"));
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
            JSObject options = new JSObject().put("startSequence", controlSequence).put("query", query).put("step", browser.step).put("secretStage", browser.secretStage).put("general", browser.generalMode); controlSequence += 100;
            evaluate(call, "inspect", options, value -> {
                labels.clear(); referenceKinds.clear(); sensitiveTargets.clear(); JSONArray controls = value.optJSONArray("controls");
                if (controls != null) for (int index = 0; index < controls.length(); index++) {
                    JSONObject control = controls.optJSONObject(index);
                    if (control != null) { String id = control.optString("target"); if (id.matches("[0-9]{1,10}")) controlSequence = Math.max(controlSequence, Long.parseLong(id)); labels.put(id, control.optString("label")); referenceKinds.put(id, control.optString("kind", "control")); if (control.optBoolean("sensitive", true)) sensitiveTargets.add(id); }
                }
                for (String key : new String[] { "regions", "links", "forms" }) {
                    JSONArray refs = value.optJSONArray(key); String kind = "regions".equals(key) ? "region" : "links".equals(key) ? "link" : "form";
                    if (refs != null) for (int index = 0; index < refs.length(); index++) { JSONObject ref = refs.optJSONObject(index); if (ref != null) { String id = ref.optString("target"); if (!id.isEmpty()) { controlSequence = Math.max(controlSequence, Long.parseLong(id)); labels.put(id, ref.optString("label")); referenceKinds.put(id, kind); } } }
                }
                if (value.optBoolean("waitingForUser", false)) browser.setPaused(true);
                JSObject result = metadata(); result.put("controls", controls == null ? new JSArray() : controls);
                if (value.has("pageAccess")) result.put("pageAccess", value.optString("pageAccess"));
                result.put("paused", value.optBoolean("waitingForUser", false));
                result.put("forkOfTarget", value.optBoolean("forkOfTarget", false));
                if (value.has("repository")) result.put("repository", value.optJSONObject("repository"));
                result.put("pageKind", value.optString("pageKind", "")); result.put("headings", value.optJSONArray("headings"));
                for (String key : new String[] { "title", "text", "nextOffset", "regions", "links", "forms" }) if (value.has(key)) result.put(key, value.opt(key));
                if (value.has("truncated")) result.put("truncated", value.optBoolean("truncated"));
                if (value.has("searchMatched")) result.put("searchMatched", value.optBoolean("searchMatched"));
                if (value.has("applicationList")) result.put("applicationList", value.optJSONObject("applicationList"));
                if (value.has("secretSavedOnPage")) result.put("secretSavedOnPage", value.optBoolean("secretSavedOnPage"));
                snapshot = value; inspectedUrl = browser.web.getUrl(); inspectedDocument = browser.documentId;
                snapshot.put("tabId", browser.activeTabId()); result.put("tabId", browser.activeTabId());
                call.resolve(result);
            });
        });
    }
    @PluginMethod public void readPage(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (!ready(call) || !browser.generalMode) { call.reject("通用网页阅读仅适用于普通网页任务"); return; }
            Integer document = call.getInt("documentId"), tab = call.getInt("tabId");
            if (document == null || tab == null || document != browser.documentId || tab != browser.activeTabId() || browser.paused || browser.loading || pageUserOnly()) { call.reject("标签页或网页状态已变化，请先继续任务并重新观察"); return; }
            String query = call.getString("query", "").trim(), region = call.getString("region", "");
            int offset = call.getInt("offset", 0), limit = call.getInt("limit", 2400);
            if (offset < 0 || offset > 1_000_000 || limit < 200 || limit > 4000 || query.length() > 80) { call.reject("正文读取范围无效"); return; }
            if (!region.isEmpty() && (!labels.containsKey(region) || inspectedDocument != document || !browser.web.getUrl().equals(inspectedUrl) || !regionMatches(region, "region"))) { call.reject("区域引用已失效，请重新观察页面"); return; }
            JSObject payload = new JSObject().put("general", true).put("query", query).put("regionTarget", region).put("offset", offset).put("limit", limit);
            evaluate(call, "read-page", payload, value -> call.resolve(value));
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
                if (browser.generalMode) {
                    Integer tabId = call.getInt("tabId");
                    if (documentId == null || documentId != browser.documentId || tabId == null || tabId != browser.activeTabId()) { call.reject("标签页或网页代次已变化，请重新观察后再导航"); return; }
                }
                String destination = call.getString("url", "");
                boolean allowed = browser.generalMode
                    ? AssistantBrowserPolicy.generalAgentNavigationAllowed(browser.agentRunId, browser.paused, browser.loading, browser.failed, browser.web.getUrl(), destination)
                    : AssistantBrowserPolicy.agentNavigationAllowed(browser.mode, browser.agentRunId, browser.paused && !secretInspection(), browser.loading, browser.failed, browser.step, browser.web.getUrl(), destination);
                if (destination.length() > 2000 || !allowed) { call.reject("仅当前运行任务可导航 HTTPS 公网页面；私网/本地地址、暂停或已变化的页面不能继续"); return; }
                int beforeDocument = browser.documentId; String beforeUrl = browser.web.getUrl();
                labels.clear(); referenceKinds.clear(); sensitiveTargets.clear(); snapshot = null; inspectedDocument = -1;
                browser.navigate(destination);
                call.resolve(new JSObject().put("ok", true).put("dispatched", true).put("verified", false).put("documentId", browser.documentId).put("waitingForPage", browser.loading).put("pageChanged", beforeDocument != browser.documentId || !beforeUrl.equals(browser.web.getUrl())).put("waitingForUser", browser.paused && !browser.loading)); return;
            }
            if (browser.paused && !secretInspection() || browser.loading || browser.failed || pageUserOnly()) { call.reject("请用户先完成当前操作，再允许本页协助"); return; }
            if (documentId == null || documentId != browser.documentId) { call.reject("页面已变化，请重新读取"); return; }
            Integer tabId = call.getInt("tabId");
            if (browser.generalMode && (tabId == null || tabId != browser.activeTabId())) { call.reject("目标标签页已变化，请重新观察"); return; }
            String target = call.getString("target", "");
            if (!target.isEmpty() && "guide".equals(operation) && (!labels.containsKey(target) || inspectedDocument != browser.documentId || !browser.web.getUrl().equals(inspectedUrl))) { call.reject("指路目标已变化，请重新查看页面"); return; }
            if (!target.isEmpty() && ("fill-endpoint".equals(operation) || "open-install".equals(operation) || "verify-step".equals(operation) || "collect-worker".equals(operation)) && (!labels.containsKey(target) || inspectedDocument != browser.documentId || !browser.web.getUrl().equals(inspectedUrl))) { call.reject("字段已变化，请重新查看实际输入位置"); return; }
            if (("click".equals(operation) || "upload".equals(operation) || "select".equals(operation) || "fill".equals(operation) || "focus".equals(operation) || "press".equals(operation) || "scroll".equals(operation) && !target.isEmpty()) && (!labels.containsKey(target) || inspectedDocument != browser.documentId || !browser.web.getUrl().equals(inspectedUrl))) { call.reject("控件或页面已变化，请重新读取当前控件"); return; }
            String key = call.getString("key", "");
            if ("press".equals(operation) && (!browser.generalMode || !java.util.Arrays.asList("Tab", "Escape", "Enter", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "Backspace", "Delete").contains(key))) { call.reject("只支持通用网页任务中的常用按键"); return; }
            if ("upload".equals(operation) && !browser.generalMode) { call.reject("文件上传请使用通用网页任务"); return; }
            if (browser.generalMode && "fill".equals(operation) && sensitiveTargets.contains(target)) { call.reject("登录凭据和秘密值只能由你自己填写"); return; }
            JSObject payload = new JSObject(); payload.put("target", target);
            payload.put("label", labels.getOrDefault(target, ""));
            payload.put("value", call.getString("value", "")); payload.put("template", call.getString("template", "")); payload.put("key", key).put("general", browser.generalMode);
            payload.put("direction", call.getString("direction", "down"));
            payload.put("expectedApplicationId", call.getString("expectedApplicationId", ""));
            payload.put("expectedPublicKey", call.getString("expectedPublicKey", ""));
            payload.put("expectedDatabaseId", call.getString("expectedDatabaseId", ""));
            payload.put("expectedRevision", call.getString("expectedRevision", ""));
            payload.put("expectedFork", call.getString("expectedFork", ""));
            payload.put("expectedBranch", call.getString("expectedBranch", "main"));
            payload.put("expectedFile", call.getString("expectedFile", "wrangler.jsonc"));
            payload.put("repositoryKind", call.getString("repositoryKind", ""));
            payload.put("synchronizationAssessment", call.getString("synchronizationAssessment", ""));
            payload.put("preserveConfiguration", Boolean.TRUE.equals(call.getBoolean("preserveConfiguration", false)));
            payload.put("configurationConfirmation", call.getString("configurationConfirmation", ""));
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
            payload.put("nativeKey", browser.generalMode && "press".equals(operation));
            String confirmedRun = browser.agentRunId;
            Runnable execute = () -> {
                if (browser == null || !confirmedRun.equals(browser.agentRunId)) { call.reject("确认期间执行代次已变化，旧确认不操作网页"); return; }
                if (!ready(call)) return;
                if (browser.paused && !secretInspection() || browser.documentId != documentId) { call.reject("页面或接手状态已变化，未执行"); return; }
                evaluate(call, operation, payload, call::resolve);
            };
            if (AssistantBrowserPolicy.requiresConfirmation(operation, labels.getOrDefault(target, "")) && (browser.generalMode || browser.agentRunId.isEmpty())) {
                new AlertDialog.Builder(getActivity()).setTitle("确认网页修改")
                    .setMessage(AssistantBrowserPolicy.publicUrl(browser.web.getUrl()) + "\n" + ("template".equals(operation) ? "替换当前编辑内容为教程模板。未提交的编辑会被替换。" : "点击：" + labels.get(target) + "\n将修改当前账号的配置。"))
                    .setPositiveButton("执行这一步", (dialog, which) -> execute.run()).setNegativeButton("取消", (dialog, which) -> call.resolve(new JSObject().put("ok", false).put("cancelled", true))).setOnCancelListener(dialog -> call.resolve(new JSObject().put("ok", false).put("cancelled", true))).show();
            } else execute.run();
        });
    }
    private void actSecret(PluginCall call, String operation) {
        Integer documentId = call.getInt("documentId");
        String stage = browser.secretStage, url = browser.web.getUrl();
        if (browser.loading || browser.failed || documentId == null || documentId != browser.documentId || browser.secretScope == null || !browser.secretScope.equals(AssistantBrowserPolicy.secretScope(url)) || !AssistantBrowserPolicy.secretOperationAllowed(operation, browser.mode, browser.step, url, stage)) { call.reject("仅在用户授权的同一 Worker 固定步骤准备或保存 Secret；页面或接手状态变化时停止"); return; }
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
                .setMessage(AssistantBrowserPolicy.publicUrl(url) + "\n只提交你在本页手填的 DISCORD_BOT_TOKEN，并部署到本次 Worker。软件不读取值；点击不代表部署成功，之后仍需核对生产部署。")
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
            String checklist = AssistantBrowserPolicy.successChecklist(step);
            if (checklist == null || !step.equals(browser.step) || documentId == null || documentId != browser.documentId || browser.loading || browser.failed) { call.reject("页面未加载成功或步骤已变化，请重新核对"); return; }
            String url = browser.web.getUrl();
            if (!AssistantBrowserPolicy.successLocation(step, url)) { call.reject("请打开本次任务的 Worker 详情或 App 配置页；登录、授权页和总览页不能证明成功"); return; }
            browser.setPaused(true);
            new AlertDialog.Builder(getActivity()).setTitle("核对本步成功条件")
                .setMessage(AssistantBrowserPolicy.publicUrl(url) + "\n\n" + checklist + "\n\n这些网页结果由你核对；软件不会把点击或安装链接当作成功。最终还会检查连接与命令。")
                .setPositiveButton("以上均已确认", (dialog, which) -> call.resolve(new JSObject().put("confirmed", browser != null && browser.active() && documentId == browser.documentId && step.equals(browser.step) && url.equals(browser.web.getUrl()) && !browser.loading && !browser.failed)))
                .setNegativeButton("还没完成", (dialog, which) -> call.resolve(new JSObject().put("confirmed", false)))
                .setOnCancelListener(dialog -> call.resolve(new JSObject().put("confirmed", false))).show();
        });
    }
    private boolean secretInspection() {
        return browser != null && AssistantBrowserPolicy.secretPublicControlsAllowed(browser.mode, browser.agentRunId, browser.step, browser.web.getUrl(), browser.secretScope, browser.secretStage);
    }
    private boolean secretReadback() {
        return browser != null && AssistantBrowserPolicy.secretMetadataAllowed(browser.mode, browser.agentRunId, browser.step, browser.web.getUrl(), browser.secretScope, browser.secretStage);
    }
    private boolean ownsCall(PluginCall call) {
        String expected = call.getString("ownerRunId", "");
        if (!expected.isEmpty() && (browser == null || !browser.generalMode || !expected.equals(browser.taskRunId))) { call.reject("网页已交给另一任务，旧调用不执行"); return false; }
        String expectedAgent = call.getString("ownerAgentRunId", "");
        if (!expectedAgent.isEmpty() && (browser == null || !expectedAgent.equals(browser.agentRunId))) { call.reject("执行代次已变化，暂停前的旧操作不执行"); return false; }
        return true;
    }
    private boolean ready(PluginCall call) {
        if (!ownsCall(call)) return false;
        if (browser == null || !browser.active() || browser.web.getUrl() == null) { call.reject("配置浏览器未打开，请先打开当前步骤"); return false; }
        if (!(browser.generalMode ? AssistantBrowserPolicy.browseAllowed(browser.web.getUrl()) : AssistantBrowserPolicy.allowed(browser.web.getUrl()))) { call.reject("当前页面不是受支持的HTTPS网页"); return false; }
        return true;
    }
    private boolean pageUserOnly() { return browser != null && (browser.generalMode ? AssistantBrowserPolicy.generalUserOnly(browser.web.getUrl()) : AssistantBrowserPolicy.userOnly(browser.step, browser.web.getUrl())); }
    private boolean regionMatches(String target, String kind) { return kind.equals(referenceKinds.get(target)); }
    private JSObject metadata() {
        String url = browser.generalMode ? AssistantBrowserPolicy.generalPublicUrl(browser.web.getUrl()) : AssistantBrowserPolicy.publicUrl(browser.web.getUrl());
        String title = browser.web.getTitle() == null ? "" : browser.web.getTitle();
        JSObject value = new JSObject().put("documentId", browser.documentId).put("tabId", browser.activeTabId()).put("url", url).put("title", safe(title)).put("loading", browser.loading).put("paused", browser.paused || pageUserOnly());
        value.put("chatOpen", browser.chatOpen);
        value.put("downloadPending", browser.generalMode && pendingDownloadUrl != null && pendingDownloadDocument == browser.documentId && pendingDownloadTab == browser.activeTabId());
        if ("discord-install".equals(browser.step)) value.put("installationCompleted", browser.installationCompleted && browser.installationApplicationId.matches("[0-9]{17,20}") && browser.installationApplicationId.equals(browser.installationStartedApp));
        value.put("failed", browser.failed).put("pageAccess", browser.generalMode ? AssistantBrowserPolicy.generalPageAccess(browser.web.getUrl()) : AssistantBrowserPolicy.pageAccess(browser.step, browser.web.getUrl()));
        if (snapshot != null && inspectedDocument == browser.documentId && browser.web.getUrl().equals(inspectedUrl) && snapshot.has("pageAccess")) value.put("pageAccess", snapshot.optString("pageAccess"));
        if ("cf-secret".equals(browser.step) && browser.secretScope != null && browser.secretScope.equals(AssistantBrowserPolicy.secretScope(browser.web.getUrl())) && !browser.loading && !browser.secretStage.isEmpty()) value.put("secretStage", browser.secretStage);
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
        if (!"discord-install".equals(browser.step) || !AssistantBrowserPolicy.installationResultPage(url, app, started)) { cancelInstallationWatch(); return; }
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
        try (java.io.InputStream stream = getContext().getAssets().open("assistant-browser.js"); java.io.ByteArrayOutputStream content = new java.io.ByteArrayOutputStream()) {
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
            if (!"agent".equals(browser.mode) || browser.loading || browser.failed || requestedDocument == null || requestedDocument != browser.documentId || !AssistantBrowserPolicy.botSecretLocation(browser.web.getUrl(), app)) { call.reject("请先打开本次 App 的 Bot 页面并显示 Token"); return; }
            int document = browser.documentId;
            try {
                loadExecutor();
                String script = "(" + executor.trim().replaceFirst(";\\s*$", "") + ")(\"capture-bot-secret\"," + new JSObject().put("expectedApplicationId", app) + ")";
                browser.web.evaluateJavascript(script, raw -> {
                    if (browser == null || !browser.active() || browser.documentId != document || !AssistantBrowserPolicy.botSecretLocation(browser.web.getUrl(), app)) { call.reject("网页已变化，密钥结果已丢弃"); return; }
                    JSONObject receipt = null;
                    try {
                        receipt = new JSONObject(raw);
                        if (!receipt.optBoolean("ok", false)) { call.reject(AssistantBrowserPolicy.botSecretCaptureError(receipt.optString("reason", ""))); return; }
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
            if (!"agent".equals(browser.mode) || browser.agentRunId.isEmpty() || !"cf-secret".equals(browser.step) || !"input".equals(browser.secretStage) || browser.loading || browser.failed || document == null || document != browser.documentId || browser.secretScope == null || !browser.secretScope.equals(AssistantBrowserPolicy.secretScope(browser.web.getUrl()))) { call.reject("请先准备本次 Worker 的 Secret 表单"); return; }
            JSObject payload = new JSObject().put("step", "cf-secret").put("secretStage", "input").put("secretMarker", browser.secretMarker).put("secret", call.getString("secret", ""));
            evaluate(call, "fill-stored-secret", payload, result -> call.resolve(new JSObject().put("ok", result.optBoolean("ok", false))));
        });
    }
    private void evaluate(PluginCall call, String operation, JSObject payload, Result done) {
        evaluate(call, operation, payload, done, false, message -> rejectEvaluation(call, message));
    }
    private void evaluate(PluginCall call, String operation, JSObject payload, Result done, boolean inputFocused, java.util.function.Consumer<String> failed) {
        if (!inputFocused && java.util.Set.of("click", "key", "focus", "fill", "select", "template", "fill-config", "fill-endpoint", "prepare-secret", "submit-secret", "fill-stored-secret").contains(operation)) {
            AssistantBrowserWindow owner = browser;
            int previousDocument = owner.documentId, previousTab = owner.activeTabId();
            String previousRun = owner.agentRunId;
            JSObject[] result = new JSObject[1];
            String[] inputError = new String[1];
            owner.dispatchChatInput(completed -> evaluate(call, operation, payload, value -> {
                result[0] = value; completed.accept(true);
            }, true, message -> { inputError[0] = message; completed.accept(false); }), accepted -> {
                if (inputError[0] != null) { failed.accept(inputError[0]); return; }
                if (!accepted || browser != owner || !owner.active() || !previousRun.equals(owner.agentRunId)) { failed.accept("任务或页面已变化，未继续旧输入；先核对现有结果"); return; }
                JSObject value = result[0];
                if (value == null) { failed.accept("输入回执尚未完成，请核对当前页面"); return; }
                if (value.optBoolean("dispatched", false) || value.optBoolean("filled", false) || value.optBoolean("written", false)) {
                    boolean changed = previousDocument != owner.documentId || previousTab != owner.activeTabId();
                    value.put("documentId", owner.documentId).put("tabId", owner.activeTabId()).put("pageChanged", changed).put("waitingForPage", owner.loading);
                    if (changed) value.put("verified", false);
                }
                done.accept(value);
            });
            return;
        }
        int documentId = browser.documentId; String url = browser.web.getUrl();
        int tabId = browser.activeTabId();
        String runId = browser.agentRunId;
        String step = browser.step;
        boolean fixedSecret = "prepare-secret".equals(operation) || "submit-secret".equals(operation) || "fill-stored-secret".equals(operation);
        boolean statusWait = "watch-status".equals(operation) || "check-status".equals(operation);
        try {
            loadExecutor();
            String script = "(" + executor.trim().replaceFirst(";\\s*$", "") + ")(" + JSONObject.quote(operation) + "," + payload.toString() + ")";
            browser.web.evaluateJavascript(script, raw -> {
                if (statusWait && pendingWait != call) return;
                if (browser == null || !browser.active()) { failed.accept("页面已关闭，未采用旧回执；页面关闭不说明原操作失败，继续前核验现有结果"); return; }
                if (!runId.equals(browser.agentRunId)) { failed.accept("任务运行已变化，旧回执不恢复任务；不据此认定已发出的保存/部署失败，继续前核验现有结果"); return; }
                if (!step.equals(browser.step)) { failed.accept("配置步骤已变化，旧结果不用于新步骤；不据此认定原操作失败"); return; }
                JSONObject receipt;
                try {
                    receipt = new JSONObject(raw);
                    if (receipt.has("waitingForUser")) receipt.put("waitingForUser", AssistantBrowserPolicy.userHandoffRequired(operation, receipt.optBoolean("waitingForUser", false), runId));
                }
                catch (Exception error) { failed.accept("网页未返回可验证回执，操作是否生效尚未核验；先 inspect 现有结果，不重复提交，没有发送页面源码"); return; }
                if (fixedSecret) {
                    if ("fill-stored-secret".equals(operation) && (runId.isEmpty() || !runId.equals(browser.agentRunId) || documentId != browser.documentId || !url.equals(browser.web.getUrl()))) { failed.accept("任务或输入页面已变化，未继续保存"); return; }
                    if (!"cf-secret".equals(browser.step) || !payload.optString("secretStage").equals(browser.secretStage) || browser.secretScope == null || !browser.secretScope.equals(AssistantBrowserPolicy.secretScope(browser.web.getUrl()))) { failed.accept("Secret 页面或接手状态变化，结果已丢弃"); return; }
                } else if (documentId != browser.documentId || tabId != browser.activeTabId() || !url.equals(browser.web.getUrl()) || browser.paused && !secretInspection() && !("inspect".equals(operation) && secretReadback())) {
                    JSObject dispatched = navigationReceipt(operation, receipt, documentId != browser.documentId || tabId != browser.activeTabId() || !url.equals(browser.web.getUrl()), !runId.isEmpty() && runId.equals(browser.agentRunId));
                    if (dispatched != null) {
                        dispatched.put("documentId", browser.documentId).put("tabId", browser.activeTabId()).put("waitingForPage", browser.loading).put("waitingForUser", dispatched.optBoolean("waitingForUser", false) || browser.paused && !browser.loading);
                        done.accept(dispatched); return;
                    }
                    failed.accept("页面或接手状态已变化，本次读取/核验不用于当前页；重新 inspect，不据此认定此前保存或部署失败"); return;
                }
                try {
                    if (receipt.optBoolean("keyDispatch", false)) {
                        if (!browser.pressPublicKey(payload.optString("key"), documentId, runId)) { failed.accept("按键前任务或页面已变化"); return; }
                        receipt.remove("keyDispatch"); receipt.put("dispatched", true).put("verified", false);
                    }
                    if (receipt.optBoolean("ok", false) && receipt.optJSONObject("clickPoint") != null) {
                        if (!browser.clickPublicTarget(receipt.optJSONObject("clickPoint"), documentId, runId)) { failed.accept("未确认完整点击手势，动作是否生效尚未核验；inspect 当前结果，不用脚本重复点击"); return; }
                        receipt.remove("clickPoint"); receipt.put("dispatched", true).put("verified", false);
                        if (!runId.equals(browser.agentRunId) || !step.equals(browser.step)) { failed.accept("任务或步骤已停止/变化，已发出的动作不自动重试；先核对当前结果"); return; }
                    }
                    JSObject result = sanitize(receipt, "collect-config".equals(operation) && payload.optBoolean("allowParameters", false));
                    if ("open-install".equals(operation) && result.optBoolean("ok", false)) {
                        String installUrl = receipt.optString("installUrl", "");
                        if (!AssistantBrowserPolicy.installLink(installUrl, payload.optString("expectedApplicationId"))) { failed.accept("安装链接不属于本次 App 或超出安装范围"); return; }
                        browser.setPaused(true);
                        browser.installationStartedApp = payload.optString("expectedApplicationId");
                        browser.web.loadUrl(installUrl);
                        result.put("dispatched", true).put("waitingForUser", true);
                    }
                    if (fixedSecret && result.optBoolean("ok", false)) {
                        String stage = result.optString("secretStage", "");
                        if ("input".equals(stage) && (documentId != browser.documentId || !url.equals(browser.web.getUrl()))) { failed.accept("输入表单已变化，请重新准备"); return; }
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
                catch (Exception error) { failed.accept("回执处理未完成，操作是否生效尚未核验；先 inspect 现有结果，不重复提交，没有发送页面源码"); }
            });
        } catch (Exception error) { failed.accept("配置执行器不可用"); }
    }
    private void rejectEvaluation(PluginCall call, String message) {
        if (pendingWait == call) { pendingWait = null; cancelStatus(); }
        call.reject(message);
    }
    private static String safe(String value) { String clean = AssistantBrowserPolicy.maskSecrets(value); return clean.substring(0, Math.min(140, clean.length())); }
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
    private static String safeReply(String value) { String clean = AssistantBrowserPolicy.maskSecrets(value); return clean.substring(0, Math.min(16000, clean.length())); }
    static JSObject sanitize(JSONObject value, boolean allowParameters) {
        JSObject result = new JSObject().put("ok", value.optBoolean("ok", false));
        String confirmation = value.optString("configurationConfirmation", "");
        if (confirmation.matches("[a-f0-9-]{36}")) result.put("configurationConfirmation", confirmation);
        JSONObject repository = value.optJSONObject("repository");
        if (repository != null && repository.optString("name").matches("[A-Za-z0-9-]+/[A-Za-z0-9_.-]+") && repository.optString("kind").matches("fork|owned-source")) {
            JSObject identity = new JSObject().put("name", repository.optString("name")).put("kind", repository.optString("kind"));
            if (GitHubAssistantPolicy.branch(repository.optString("branch"))) identity.put("branch", repository.optString("branch"));
            if (repository.optString("file").matches("wrangler\\.jsonc?")) identity.put("file", repository.optString("file"));
            result.put("repository", identity);
        }
        if (value.optString("pageAccess", "").matches("public|authentication|protected")) result.put("pageAccess", value.optString("pageAccess"));
        if (value.opt("searchMatched") instanceof Boolean) result.put("searchMatched", value.optBoolean("searchMatched"));
        if (value.opt("secretSavedOnPage") instanceof Boolean) result.put("secretSavedOnPage", value.optBoolean("secretSavedOnPage"));
        if (value.optBoolean("configurationConflict", false)) {
            result.put("configurationConflict", true);
            result.put("replacementRequired", value.optBoolean("replacementRequired", false));
            String endpoint = value.optString("previousEndpoint", "");
            if (endpoint.length() <= 2000 && endpoint.startsWith("https://") && safe(endpoint).equals(endpoint)) result.put("previousEndpoint", endpoint);
        }
        String pageKind = value.optString("pageKind", "");
        if (pageKind.matches("webpage|discord-app-list|discord-app-information|discord-app-installation|discord-other|d1-detail|worker-detail|worker-site|cloudflare-overview|wrangler-editor|wrangler-file|github-fork|github-repository|github-app-installation")) result.put("pageKind", pageKind);
        JSONObject applications = value.optJSONObject("applicationList");
        if ("discord-app-list".equals(pageKind) && applications != null && applications.optString("state").matches("available|empty|unknown") && applications.optInt("count", -1) >= 0) result.put("applicationList", new JSObject().put("state", applications.optString("state")).put("count", applications.optInt("count")));
        JSONArray headings = value.optJSONArray("headings");
        if (headings != null) { JSArray clean = new JSArray(); for (int index = 0; index < Math.min(12, headings.length()); index++) clean.put(safe(headings.optString(index))); result.put("headings", clean); }
        if (value.has("title")) result.put("title", safe(value.optString("title")));
        if (value.has("text")) result.put("text", safeReply(value.optString("text")));
        if (value.has("nextOffset") && !value.isNull("nextOffset")) result.put("nextOffset", Math.max(0, value.optInt("nextOffset", 0)));
        for (String key : new String[] { "regions", "links", "forms" }) {
            JSONArray refs = value.optJSONArray(key); if (refs == null) continue; JSArray clean = new JSArray();
            for (int index = 0; index < Math.min("links".equals(key) ? 50 : 30, refs.length()); index++) {
                JSONObject ref = refs.optJSONObject(index); if (ref == null || !ref.optString("target").matches("[0-9]{1,10}")) continue;
                JSObject item = new JSObject().put("target", ref.optString("target")).put("label", safe(ref.optString("label")));
                if ("links".equals(key)) {
                    String href = ref.optString("url", "");
                    if (!AssistantBrowserPolicy.browseAllowed(href)) continue;
                    item.put("url", AssistantBrowserPolicy.generalPublicUrl(href)).put("disabled", ref.optBoolean("disabled", false));
                }
                if ("forms".equals(key)) item.put("controls", Math.max(0, Math.min(100, ref.optInt("controls", 0)))).put("invalid", ref.optBoolean("invalid", false));
                clean.put(item);
            }
            result.put(key, clean);
        }
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
    @PluginMethod public void close(PluginCall call) { getActivity().runOnUiThread(() -> { if (!ownsCall(call)) return; if (browser != null && call.getBoolean("keepRunning", false)) { browser.hideForChat(); call.resolve(); return; } stopFiles(); cancelStatus(); cancelInstallationWatch(); if (browser != null) browser.close(); if (pendingWait != null) { PluginCall waiting = pendingWait; pendingWait = null; waiting.resolve(metadata().put("paused", true)); } call.resolve(); }); }
    @PluginMethod public void chatPresentation(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (browser == null || !browser.chatPresentation(call.getString("mode", ""), call.getString("conversationId", ""), call.getObject("bounds"))) { call.reject("当前网页任务不支持此显示方式"); return; }
            call.resolve();
        });
    }
    @PluginMethod public void back(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (!ready(call)) return;
            Integer expectedTab = call.getInt("tabId");
            if (browser.generalMode && (expectedTab == null || expectedTab != browser.activeTabId())) { call.reject("标签页已变化，请重新读取"); return; }
            boolean moved = browser.goBack(true); labels.clear(); referenceKinds.clear(); sensitiveTargets.clear(); snapshot = null; inspectedDocument = -1;
            call.resolve(metadata().put("moved", moved));
        });
    }
    @PluginMethod public void listTabs(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (!ownsCall(call)) return;
            if (browser == null || !browser.active()) { call.resolve(new JSObject().put("tabs", new JSArray())); return; }
            JSArray tabs = new JSArray(); JSONArray values = browser.tabSnapshot();
            for (int i = 0; i < values.length(); i++) try { tabs.put(values.getJSONObject(i)); } catch (Exception ignored) {}
            call.resolve(new JSObject().put("tabs", tabs));
        });
    }
    @PluginMethod public void switchTab(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (!ownsCall(call)) return;
            if (browser == null || !browser.active() || !browser.generalMode) { call.reject("当前没有通用网页任务标签页"); return; }
            Integer id = call.getInt("tabId"); if (id == null || id < 1 || !browser.switchTab(id)) { call.reject("标签页不存在或已关闭"); return; }
            labels.clear(); referenceKinds.clear(); sensitiveTargets.clear(); snapshot = null; inspectedDocument = -1;
            call.resolve(metadata());
        });
    }
    @PluginMethod public void wait(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (!ready(call) || !browser.generalMode) { call.reject("等待仅适用于通用网页任务"); return; }
            Integer document = call.getInt("documentId"), tab = call.getInt("tabId"); int delay = call.getInt("milliseconds", 1000);
            if (document == null || tab == null || document != browser.documentId || tab != browser.activeTabId() || delay < 0 || delay > 30000 || browser.paused && !browser.loading) { call.reject("等待范围无效或页面任务已暂停"); return; }
            String run = browser.agentRunId;
            if (pendingDelay != null) { call.reject("已有网页等待，未重复启动"); return; }
            pendingDelay = call;
            delayCallback = () -> {
                pendingDelay = null; delayCallback = null;
                if (browser == null || !browser.active() || !run.equals(browser.agentRunId)) { call.reject("等待期间任务已停止，旧操作已丢弃"); return; }
                call.resolve(metadata().put("pageChanged", document != browser.documentId || tab != browser.activeTabId()));
            };
            delayHandler.postDelayed(delayCallback, delay);
        });
    }
    @PluginMethod public void capture(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (!ready(call) || !browser.generalMode) { call.reject("截图仅适用于通用网页任务"); return; }
            Integer expectedDocument = call.getInt("documentId"), expectedTab = call.getInt("tabId");
            if (expectedDocument == null || expectedTab == null || expectedDocument != browser.documentId || expectedTab != browser.activeTabId() || browser.loading || browser.failed || browser.paused || pageUserOnly()) { call.reject("当前页处于登录、私密、暂停或已变化状态，不能截图"); return; }
            int document = browser.documentId, tab = browser.activeTabId(); String run = browser.agentRunId;
            try {
                loadExecutor();
                String script = "(" + executor.trim().replaceFirst(";\\s*$", "") + ")(\"privacy-check\"," + new JSObject().put("general", true).put("startSequence", 0).put("query", "").toString() + ")";
                browser.web.evaluateJavascript(script, raw -> {
                    if (browser == null || !browser.active() || document != browser.documentId || tab != browser.activeTabId() || !run.equals(browser.agentRunId)) { call.reject("页面或任务已变化，截图未采用"); return; }
                    try {
                        JSONObject inspected = new JSONObject(raw);
                        if (!"public".equals(inspected.optString("pageAccess"))) { call.reject("当前页包含登录或秘密字段，截图已阻止"); return; }
                        android.graphics.Bitmap source = android.graphics.Bitmap.createBitmap(Math.max(1, browser.web.getWidth()), Math.max(1, browser.web.getHeight()), android.graphics.Bitmap.Config.ARGB_8888);
                        android.graphics.Canvas canvas = new android.graphics.Canvas(source); browser.web.draw(canvas);
                        int max = 1280; float scale = Math.min(1f, (float)max / Math.max(source.getWidth(), source.getHeight()));
                        android.graphics.Bitmap output = scale < 1f ? android.graphics.Bitmap.createScaledBitmap(source, Math.max(1, Math.round(source.getWidth() * scale)), Math.max(1, Math.round(source.getHeight() * scale)), true) : source;
                        java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream(); output.compress(android.graphics.Bitmap.CompressFormat.JPEG, 82, bytes);
                        if (output != source) output.recycle(); source.recycle();
                        if (bytes.size() > 2_000_000) { call.reject("网页截图超过安全大小限制"); return; }
                        call.resolve(new JSObject().put("dataUrl", "data:image/jpeg;base64," + android.util.Base64.encodeToString(bytes.toByteArray(), android.util.Base64.NO_WRAP)).put("documentId", document).put("tabId", tab));
                    } catch (Exception error) { call.reject("无法读取目标网页截图"); }
                });
            } catch (Exception error) { call.reject("网页截图不可用"); }
        });
    }
    @PluginMethod public void download(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (!ready(call) || !browser.generalMode) { call.reject("请先打开通用网页任务"); return; }
            Integer document = call.getInt("documentId"), tab = call.getInt("tabId");
            if (document == null || tab == null || document != browser.documentId || tab != browser.activeTabId() || browser.agentRunId.isEmpty() || browser.paused) { call.reject("下载目标页面或任务已变化"); return; }
            String target = call.getString("target", "");
            if ("pending".equals(target) && pendingDownloadUrl != null && pendingDownloadDocument == document && pendingDownloadTab == tab) {
                confirmDownload(call, pendingDownloadUrl, pendingDownloadName, pendingDownloadMime, document, tab); return;
            }
            if (!target.matches("[0-9]{1,10}") || !regionMatches(target, "link") || inspectedDocument != document || !browser.web.getUrl().equals(inspectedUrl)) { call.reject("下载链接引用已失效，先观察当前页面"); return; }
            String run = browser.agentRunId;
            browser.web.evaluateJavascript("JSON.stringify((()=>{const e=document.querySelector('[data-srl-discord-control=\"" + target + "\"]');return e?.matches('a[href]')?{url:e.href,name:e.getAttribute('download')||''}:{};})())", raw -> {
                if (browser == null || !browser.active() || document != browser.documentId || tab != browser.activeTabId() || !run.equals(browser.agentRunId)) { call.reject("下载目标已变化"); return; }
                try {
                    JSONObject data = new JSONObject(new org.json.JSONTokener(raw).nextValue().toString());
                    String url = data.optString("url");
                    String name = data.optString("name"); if (name.isEmpty()) name = android.webkit.URLUtil.guessFileName(url, null, null);
                    confirmDownload(call, url, name, "application/octet-stream", document, tab);
                } catch (Exception error) { call.reject("未读到当前有效下载链接"); }
            });
        });
    }
    private void confirmDownload(PluginCall call, String url, String name, String mime, int document, int tab) {
        if (!AssistantBrowserPolicy.browseAllowed(url)) { call.reject("只支持当前网页的 HTTPS 文件下载"); return; }
        String run = browser.agentRunId; long generation = fileGeneration;
        String userAgent = browser.web.getSettings().getUserAgentString(), pageUrl = browser.web.getUrl();
        new AlertDialog.Builder(getActivity()).setTitle("保存网页文件")
            .setMessage("网站：" + android.net.Uri.parse(url).getHost() + "\n文件：" + name + "\n" + ("import".equals(call.getString("destination")) ? "保存后交给资源库原导入流程；导入结果另行核验。" : "保存到系统下载目录 / SRL。"))
            .setNegativeButton("取消", (dialog, which) -> call.resolve(new JSObject().put("ok", false).put("cancelled", true)))
            .setOnCancelListener(dialog -> call.resolve(new JSObject().put("ok", false).put("cancelled", true)))
            .setPositiveButton("保存", (dialog, which) -> {
                if (browser == null || !browser.active() || !run.equals(browser.agentRunId) || document != browser.documentId || tab != browser.activeTabId() || generation != fileGeneration) { call.reject("确认期间网页任务已变化"); return; }
                NativeExecutors.network().execute(() -> {
                    try {
                        NativeFileExportPlugin owner = (NativeFileExportPlugin) getBridge().getPlugin("NativeFileExport").getInstance();
                        long[] last = {0};
                        JSObject file = owner.downloadBrowserFile(url, name, mime, pageUrl, userAgent, () -> generation == fileGeneration,
                            transfer -> { if (generation == fileGeneration) fileTransfer = transfer; else if (transfer != null) transfer.cancel(); }, bytes -> { long now = android.os.SystemClock.uptimeMillis(); if (now - last[0] >= 250) { last[0] = now; getActivity().runOnUiThread(() -> { if (generation == fileGeneration) notifyBrowser(new JSObject().put("action", "download-progress").put("bytes", bytes)); }); } });
                        boolean importing = "import".equals(call.getString("destination"));
                        if (importing && generation == fileGeneration) {
                            android.content.Intent source = new android.content.Intent(android.content.Intent.ACTION_SEND)
                                .putExtra(android.content.Intent.EXTRA_STREAM, android.net.Uri.parse(file.getString("uri"))).addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);
                            android.content.Intent intake = new android.content.Intent(getContext(), NativeShareImportService.class)
                                .putExtra(NativeShareImportService.EXTRA_SOURCE, source).putExtra(NativeShareImportService.EXTRA_ROUTE, "resource");
                            androidx.core.content.ContextCompat.startForegroundService(getContext(), intake);
                        }
                        call.resolve(new JSObject().put("ok", true).put("downloaded", true).put("bytes", file.getLong("bytes")).put("importQueued", importing).put("fileName", file.getString("name")));
                    } catch (Exception error) { call.reject("网页文件保存未完成：" + AssistantBrowserPolicy.maskSecrets(error.getMessage())); }
                });
            }).show();
    }
    @PluginMethod public void waitReady(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (browser == null || !browser.active()) { call.reject("配置浏览器未打开"); return; }
            if (!browser.loading || AssistantBrowserPolicy.authentication(browser.web.getUrl())) { call.resolve(metadata()); return; }
            if (pendingWait != null) { call.reject("已有网页加载等待，未重复等待"); return; }
            pendingWait = call;
        });
    }
    @PluginMethod public void waitStatus(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (!ready(call)) return;
            String target = call.getString("target", ""); Integer documentId = call.getInt("documentId");
            if (pendingWait != null || !AssistantBrowserPolicy.statusWaitAllowed(browser.mode, browser.agentRunId, browser.paused, browser.loading, browser.failed, browser.step, browser.web.getUrl()) || documentId == null || documentId != browser.documentId || inspectedDocument != documentId || !browser.web.getUrl().equals(inspectedUrl) || !labels.containsKey(target)) { call.reject("请先观察当前运行中的实际状态；不启动重复等待"); return; }
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
    @PluginMethod public void cancelWait(PluginCall call) { getActivity().runOnUiThread(() -> { if (!ownsCall(call)) return; cancelDelay(); cancelStatus(); if (pendingWait != null) { PluginCall waiting = pendingWait; pendingWait = null; waiting.resolve(metadata().put("paused", true)); } call.resolve(); }); }
    @PluginMethod public void pauseAgent(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (!ownsCall(call)) return;
            stopFiles(); cancelStatus();
            if (browser != null) { if (call.getBoolean("finished", false)) browser.taskFinished = true; browser.agentRun(""); browser.secretStage = ""; browser.secretScope = null; browser.setPaused(true); }
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
    @Override protected void handleOnDestroy() { stopFiles(); if (filePicker != null) filePicker.unregister(); cancelStatus(); cancelInstallationWatch(); if (pendingWait != null) { pendingWait.reject("配置浏览器已关闭"); pendingWait = null; } if (browser != null) browser.destroy(); super.handleOnDestroy(); }
}
