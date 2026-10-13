package buzz.jixiangruyi1207.srl;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.Dialog;
import android.graphics.Color;
import android.os.Message;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceError;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.ProgressBar;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.JSObject;
import org.json.JSONArray;
import org.json.JSONObject;

/** Dedicated browser dialog: external pages never receive a JavascriptInterface or SRL assets. */
final class AssistantBrowserWindow {
    interface Actions { void emit(JSObject event); }
    private final Activity activity;
    private final Actions actions;
    private final WebView appWeb;
    private FrameLayout surface;
    private FrameLayout chatLayer;
    private android.view.View preview;
    private String chatMode = "";
    private android.graphics.drawable.Drawable appBackground;
    private boolean drawingPreview;
    private Dialog dialog;
    WebView web;
    private final java.util.Deque<WebView> parentWindows = new java.util.ArrayDeque<>();
    private final java.util.Map<Integer, WebView> tabs = new java.util.LinkedHashMap<>();
    private final java.util.Map<WebView, Integer> tabIds = new java.util.IdentityHashMap<>();
    private int nextTabId = 1;
    private final java.util.Set<WebView> loadingWindows = new java.util.HashSet<>();
    private boolean dispatchingAgentTouch;
    private TextView instruction;
    private TextView address;
    private TextView heading, status, failureText, failureTitle;
    private Button previousPage;
    private android.window.OnBackInvokedCallback systemBack;
    private final java.util.Set<Button> quietButtons = new java.util.HashSet<>();
    private LinearLayout failure;
    private ProgressBar progress;
    private String details = "", stepTitle = "", failedUrl;
    boolean failed;
    private LinearLayout root;
    private DiscordSetupPetOverlay pet;
    private boolean suspended, resumeAllowed;
    private int suspendedDocument;
    private String suspendedUrl;
    private boolean darkTheme;
    private final java.util.List<Button> buttons = new java.util.ArrayList<>();
    String step = "";
    String mode = "agent";
    boolean generalMode;
    private TextView chatTranscript;
    private String replyText = "", agentPhase = "";
    private String conversationId = "";
    String installationApplicationId = "", installationStartedApp = "";
    boolean installationCompleted;
    private boolean closed = true;
    String template = "";
    JSONArray steps = new JSONArray();
    boolean paused = true;
    boolean chatOpen;
    boolean loading;
    int documentId;
    String agentRunId = "";
    private String readyKey = "";
    private String verificationUrl, verificationStep, verificationRun;
    private int verificationDocument;
    void agentRun(String id) {
        String next = "agent".equals(mode) && id != null && id.matches("[a-zA-Z0-9-]{1,60}") ? id : "";
        if (!next.equals(agentRunId)) { agentRunId = next; readyKey = ""; }
        if (status != null) updateStatus();
    }
    private void pageReady() {
        if (loading || suspended || closed || dialog == null || web.getUrl() == null) return;
        if (!agentRunId.isEmpty() && !failed && !userOnly(web.getUrl())) setPaused(!generalMode && "cf-secret".equals(step) && secretStage.matches("input|submit|saved|submitted") && !AssistantBrowserPolicy.secretPublicControlsAllowed(mode, agentRunId, step, web.getUrl(), secretScope, secretStage));
        String key = agentRunId + ":" + documentId + ":" + step + ":" + web.getUrl() + ":" + failed;
        if (key.equals(readyKey)) return;
        readyKey = key;
        actions.emit(new JSObject().put("action", "page-ready"));
        if (!agentRunId.isEmpty() && "cf-secret".equals(step) && !failed && !"submit".equals(secretStage) && AssistantBrowserPolicy.secretScope(web.getUrl()) != null) prepareSecret();
    }
    String secretStage = "", secretMarker = "", secretScope;

    AssistantBrowserWindow(Activity activity, Actions actions) { this(activity, null, actions); }
    AssistantBrowserWindow(Activity activity, WebView appWeb, Actions actions) { this.activity = activity; this.appWeb = appWeb; this.actions = actions; }
    private int dp(int value) { return Math.round(value * activity.getResources().getDisplayMetrics().density); }
    void open(String url, String newStep, String title, String hint, JSONArray newSteps, String newTemplate, boolean choose, boolean dark, boolean general) {
        darkTheme = dark;
        generalMode = general;
        if (dialog == null) create();
        int ink = Color.parseColor(dark ? "#eef8f8" : "#183842");
        int muted = Color.parseColor(dark ? "#b5c8cc" : "#59727c");
        int canvas = Color.parseColor(dark ? "#1f323a" : "#f2f9fa");
        root.setBackgroundColor(canvas); ((android.view.View) root.getParent()).setBackgroundColor(canvas);
        android.graphics.drawable.GradientDrawable webShape = new android.graphics.drawable.GradientDrawable();
        webShape.setColor(Color.parseColor(dark ? "#293f48" : "#fbfefe")); webShape.setCornerRadius(dp(12));
        web.setBackground(webShape); web.setClipToOutline(true);
        heading.setTextColor(ink); instruction.setTextColor(ink); failureText.setTextColor(muted); failureTitle.setTextColor(ink);
        address.setTextColor(muted); status.setTextColor(muted);
        for (Button button : buttons) {
            boolean primary = false;
            button.setTextColor(primary ? Color.parseColor(dark ? "#17272e" : "#ffffff") : ink);
            android.graphics.drawable.GradientDrawable shape = new android.graphics.drawable.GradientDrawable();
            shape.setColor(quietButtons.contains(button) ? Color.TRANSPARENT : Color.parseColor(primary ? dark ? "#92d7d3" : "#1d707b" : dark ? "#293f48" : "#fbfefe"));
            if (!primary && !quietButtons.contains(button)) shape.setStroke(dp(1), Color.parseColor(dark ? "#48636c" : "#d5e4e6"));
            shape.setCornerRadius(dp(8));
            button.setBackground(new android.graphics.drawable.RippleDrawable(android.content.res.ColorStateList.valueOf(Color.parseColor("#3359727c")), shape, null));
        }
        if (!step.equals(newStep)) { secretStage = ""; secretScope = null; }
        step = newStep; steps = newSteps; template = newTemplate;
        stepTitle = title; heading.setText("网页协助");
        details = general ? hint + "\n网页登录、验证码及秘密值由你自己处理；公开页面由助手观察和操作。" : hint + ("economy".equals(mode) ? "\n省 Token 模式：本机固定步骤、模板、格式检查和指路，不调用 AI 操作网页。" : "\n代理模式：控件标签交给模型；参数只在本机保存回填；Bot Token 可手填，或单独确认本机加密保存。");
        int position = 0;
        for (int index = 0; index < steps.length(); index++) if (step.equals(steps.optJSONObject(index).optString("id"))) position = index + 1;
        instruction.setText((general ? "网页任务  ·  " : position > 0 ? position + "/" + steps.length() + "  ·  " : "") + title + "  ›");
        instruction.setContentDescription(title + "。点击查看操作说明");
        pet.theme(dark);
        setPaused(true);
        closed = false;
        if (chatMode.isEmpty()) {
            dialog.show();
            actions.emit(new JSObject().put("action", "visibility").put("visible", true));
        }
        Window window = dialog.getWindow();
        if (window != null) {
            window.setLayout(-1, -1); window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
            androidx.core.view.WindowInsetsControllerCompat controller = new androidx.core.view.WindowInsetsControllerCompat(window, window.getDecorView());
            controller.setAppearanceLightStatusBars(!dark); controller.setAppearanceLightNavigationBars(!dark);
        }
        web.setVisibility(android.view.View.VISIBLE);
        if (!choose && url != null && !url.equals(web.getUrl())) navigate(url);
        if (choose) chooseStep();
        else pageReady();
    }
    private void create() {
        dialog = new Dialog(activity, darkTheme ? android.R.style.Theme_DeviceDefault_NoActionBar : android.R.style.Theme_DeviceDefault_Light_NoActionBar);
        root = new LinearLayout(dialog.getContext()); root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(12), 0, dp(12), dp(8));
        LinearLayout header = new LinearLayout(activity); header.setGravity(android.view.Gravity.CENTER_VERTICAL);
        Button back = button(header, "‹", this::back);
        quietButtons.add(back);
        back.setContentDescription("返回助手"); back.setTextSize(26);
        heading = new TextView(activity); heading.setTextSize(18); heading.setTypeface(null, android.graphics.Typeface.BOLD);
        heading.setSingleLine(true); heading.setEllipsize(android.text.TextUtils.TruncateAt.END);
        heading.setPadding(dp(8), 0, dp(8), 0); header.addView(heading, new LinearLayout.LayoutParams(0, dp(44), 1));
        heading.setGravity(android.view.Gravity.CENTER_VERTICAL);
        previousPage = button(header, "上一页", this::goBack);
        previousPage.setContentDescription("返回上一网页"); quietButtons.add(previousPage);
        root.addView(header);
        address = new TextView(activity); address.setTextSize(12); address.setSingleLine(true); address.setEllipsize(android.text.TextUtils.TruncateAt.MIDDLE); root.addView(address);
        address.setOnClickListener(view -> showDetails());
        instruction = new TextView(activity); instruction.setTextSize(14); instruction.setTypeface(null, android.graphics.Typeface.BOLD); instruction.setMaxLines(2); instruction.setEllipsize(android.text.TextUtils.TruncateAt.END);
        instruction.setMinHeight(dp(44)); instruction.setGravity(android.view.Gravity.CENTER_VERTICAL);
        instruction.setOnClickListener(view -> showDetails()); root.addView(instruction);
        status = new TextView(activity); status.setTextSize(12); status.setPadding(dp(2), dp(8), 0, dp(4));
        progress = new ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal); progress.setIndeterminate(true);
        root.addView(progress, new LinearLayout.LayoutParams(-1, dp(2)));
        web = createWebView();
        root.addView(web, new LinearLayout.LayoutParams(-1, 0, 1));
        failure = new LinearLayout(activity); failure.setOrientation(LinearLayout.VERTICAL); failure.setGravity(android.view.Gravity.CENTER); failure.setPadding(dp(16), dp(12), dp(16), dp(12));
        failureTitle = new TextView(activity); failureTitle.setTextSize(18); failureTitle.setTypeface(null, android.graphics.Typeface.BOLD); failureTitle.setGravity(android.view.Gravity.CENTER); failure.addView(failureTitle);
        failureText = new TextView(activity); failureText.setTextSize(14); failure.addView(failureText);
        LinearLayout recovery = new LinearLayout(activity);
        button(recovery, "重试", () -> { if (failedUrl != null) navigate(failedUrl); });
        button(recovery, "系统浏览器", () -> {
            String url = AssistantBrowserPolicy.publicUrl(failedUrl);
            if (!AssistantBrowserPolicy.allowed(url)) return;
            try { activity.startActivity(new android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url))); }
            catch (android.content.ActivityNotFoundException error) { message("没有可用的系统浏览器，请先检查网络后重试。"); }
        });
        failure.addView(recovery); failure.setVisibility(android.view.View.GONE); root.addView(failure, new LinearLayout.LayoutParams(-1, 0, 1));
        root.addView(status);
        surface = new FrameLayout(dialog.getContext());
        surface.addView(root, new FrameLayout.LayoutParams(-1, -1));
        ViewCompat.setOnApplyWindowInsetsListener(surface, (view, insets) -> {
            if (!chatMode.isEmpty()) return insets;
            androidx.core.graphics.Insets safe = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout() | WindowInsetsCompat.Type.ime());
            view.setPadding(safe.left, safe.top, safe.right, safe.bottom); return insets;
        });
        ViewCompat.setOnApplyWindowInsetsListener(root, null);
        pet = new DiscordSetupPetOverlay(surface, this::talk);
        dialog.setContentView(surface);
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            systemBack = this::back;
            dialog.getOnBackInvokedDispatcher().registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, systemBack);
        }
        dialog.setOnKeyListener((ignored, key, event) -> {
            if (key != android.view.KeyEvent.KEYCODE_BACK) return false;
            if (event.getAction() == android.view.KeyEvent.ACTION_UP) back();
            return true;
        });
        dialog.setOnCancelListener(ignored -> { closed = true; setPaused(true); agentRun(""); actions.emit(new JSObject().put("action", "agent-pause")); actions.emit(new JSObject().put("action", "visibility").put("visible", false)); });
    }
    private WebView createWebView() {
        WebView created = new WebView(activity) {
            @Override protected void onDraw(android.graphics.Canvas canvas) {
                super.onDraw(canvas);
                if (preview != null && !drawingPreview) preview.postInvalidateOnAnimation();
            }
        };
        int newTabId = nextTabId++; tabs.put(newTabId, created); tabIds.put(created, newTabId);
        created.setOnTouchListener((view, event) -> !dispatchingAgentTouch && blocksUserInput(web.getUrl()));
        created.getSettings().setJavaScriptEnabled(true); created.getSettings().setDomStorageEnabled(true);
        created.getSettings().setAllowFileAccess(false); created.getSettings().setAllowContentAccess(false);
        created.getSettings().setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        created.getSettings().setSupportMultipleWindows(true); created.getSettings().setJavaScriptCanOpenWindowsAutomatically(false);
        created.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame()) return false;
                if ((generalMode ? AssistantBrowserPolicy.browseAllowed(request.getUrl().toString()) : AssistantBrowserPolicy.allowed(request.getUrl().toString()))) {
                    return false;
                }
                message("本次跳转未打开，当前网页仍可使用。"); return true;
            }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                loadingWindows.add(view);
                if (view != web) return;
                // Main-frame HTTP errors can arrive before onPageStarted (including cached responses).
                // Keep that document's failure until an explicit retry or a different navigation.
                boolean sameFailure = failed && url.equals(failedUrl);
                documentId++; loading = !sameFailure;
                if (!sameFailure) { failed = false; failedUrl = null; failure.setVisibility(android.view.View.GONE); created.setVisibility(android.view.View.VISIBLE); }
                setPaused(true);
                updateStatus();
                if (!AssistantBrowserPolicy.retainSecretStageOnNavigation(secretScope, url, secretStage)) { secretStage = ""; secretScope = null; }
                address.setText(android.net.Uri.parse(url).getHost());
                if (!(generalMode ? AssistantBrowserPolicy.browseAllowed(url) : AssistantBrowserPolicy.allowed(url))) { view.stopLoading(); message("已停止不支持的网页地址。"); }
            }
            @Override public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
                if (view != web) return;
                // Discord and Cloudflare can change routes without replacing the document.
                if (userOnly(url)) setPaused(true);
                pageReady();
            }
            @Override public void onPageFinished(WebView view, String url) { loadingWindows.remove(view); if (view != web) return; loading = false; address.setText(android.net.Uri.parse(url).getHost()); updateStatus(); pageReady(); }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (view == web && request.isForMainFrame()) loadFailed(request.getUrl().toString(), error.getErrorCode() == ERROR_TIMEOUT ? "连接超时" : error.getErrorCode() == ERROR_HOST_LOOKUP ? "无法解析网站地址" : "连接失败");
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (view == web && request.isForMainFrame()) loadFailed(request.getUrl().toString(), "网站返回 HTTP " + response.getStatusCode());
            }
        });
        created.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(android.webkit.ConsoleMessage message) {
                if (created != web) return false;
                String text = message.message();
                if (text != null && text.matches("SRL_DISCORD_READY:srl-[a-f0-9-]{36}")) { actions.emit(new JSObject().put("action", "status-ready").put("marker", text.substring("SRL_DISCORD_READY:".length()))); return true; }
                if (text != null && text.matches("SRL_DISCORD_INSTALLED:srl-[a-f0-9-]{36}")) { actions.emit(new JSObject().put("action", "installation-ready").put("marker", text.substring("SRL_DISCORD_INSTALLED:".length()))); return true; }
                return super.onConsoleMessage(message);
            }
            @Override public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
                if (!isUserGesture || view != web || !active()) return false;
                WebView popup = createWebView();
                parentWindows.push(web); web.setVisibility(android.view.View.GONE);
                web = popup; documentId++; loading = true; failed = false; failedUrl = null; readyKey = ""; setPaused(true);
                address.setText("新窗口"); failure.setVisibility(android.view.View.GONE);
                root.addView(popup, root.indexOfChild(parentWindows.peek()) + 1, new LinearLayout.LayoutParams(-1, 0, 1));
                ((WebView.WebViewTransport) resultMsg.obj).setWebView(popup); resultMsg.sendToTarget(); return true;
            }
            @Override public void onCloseWindow(WebView window) { if (window == web && !parentWindows.isEmpty()) returnToParentWindow(); }
        });
        return created;
    }
    private void returnToParentWindow() {
        WebView popup = web; web = parentWindows.pop(); root.removeView(popup); popup.destroy();
        Integer removedId = tabIds.remove(popup); if (removedId != null) tabs.remove(removedId);
        web.setVisibility(android.view.View.VISIBLE); documentId++; readyKey = ""; failed = false; failedUrl = null;
        loadingWindows.remove(popup); loading = loadingWindows.contains(web); failure.setVisibility(android.view.View.GONE);
        address.setText(android.net.Uri.parse(web.getUrl() == null ? "" : web.getUrl()).getHost());
        setPaused(true); pageReady();
    }
    @SuppressWarnings("deprecation")
    boolean clickPublicTarget(JSONObject point, int expectedDocument, String expectedRun) {
        boolean publicSecret = AssistantBrowserPolicy.secretPublicControlsAllowed(mode, agentRunId, step, web.getUrl(), secretScope, secretStage);
        if (!active() || paused && !publicSecret || loading || failed || documentId != expectedDocument || !expectedRun.equals(agentRunId)
            || !AssistantBrowserPolicy.blocksUserInput(mode, agentRunId, paused && !publicSecret, loading, failed, step, web.getUrl())) return false;
        double x = point.optDouble("x", Double.NaN) * web.getScale(), y = point.optDouble("y", Double.NaN) * web.getScale();
        if (!Double.isFinite(x) || !Double.isFinite(y) || x < 0 || y < 0 || x >= web.getWidth() || y >= web.getHeight()) return false;
        WebView target = web; long now = android.os.SystemClock.uptimeMillis();
        android.view.MotionEvent down = android.view.MotionEvent.obtain(now, now, android.view.MotionEvent.ACTION_DOWN, (float)x, (float)y, 0);
        android.view.MotionEvent up = android.view.MotionEvent.obtain(now, now + 16, android.view.MotionEvent.ACTION_UP, (float)x, (float)y, 0);
        dispatchingAgentTouch = true;
        try { boolean started = target.dispatchTouchEvent(down); boolean ended = target.dispatchTouchEvent(up); return started && ended; }
        finally { dispatchingAgentTouch = false; down.recycle(); up.recycle(); }
    }
    private void back() {
        agentRun(""); close(); actions.emit(new JSObject().put("action", "return"));
    }
    boolean goBack() {
        if (web != null && web.canGoBack()) {
            if (!generalMode) { setPaused(true); agentRun(""); actions.emit(new JSObject().put("action", "agent-pause")); }
            web.stopLoading(); web.goBack();
            return true;
        } else if (!parentWindows.isEmpty()) {
            if (!generalMode) { setPaused(true); agentRun(""); actions.emit(new JSObject().put("action", "agent-pause")); }
            returnToParentWindow();
            return true;
        }
        return false;
    }
    int activeTabId() { return tabIds.getOrDefault(web, 0); }
    JSONArray tabSnapshot() {
        JSONArray result = new JSONArray();
        for (java.util.Map.Entry<Integer, WebView> entry : tabs.entrySet()) {
            WebView view = entry.getValue(); if (view == null || view.getUrl() == null) continue;
            try { String title = AssistantBrowserPolicy.maskSecrets(view.getTitle() == null ? "" : view.getTitle());
                if (title.length() > 120) title = title.substring(0, 120);
                result.put(new JSONObject().put("tabId", entry.getKey()).put("active", view == web).put("url", AssistantBrowserPolicy.generalPublicUrl(view.getUrl())).put("title", title)); }
            catch (Exception ignored) {}
        }
        return result;
    }
    boolean switchTab(int id) {
        WebView selected = tabs.get(id); if (selected == null || selected == web || closed || root == null) return selected == web;
        if (web != null) web.setVisibility(android.view.View.GONE);
        web = selected; web.setVisibility(android.view.View.VISIBLE); documentId++; loading = loadingWindows.contains(web); failed = false; failedUrl = null; readyKey = "";
        address.setText(android.net.Uri.parse(web.getUrl() == null ? "" : web.getUrl()).getHost()); setPaused(true); pageReady(); return true;
    }
    private boolean userOnly(String url) { return generalMode ? AssistantBrowserPolicy.generalUserOnly(url) : AssistantBrowserPolicy.userOnly(step, url); }
    private boolean blocksUserInput(String url) { return generalMode ? "agent".equals(mode) && !agentRunId.isEmpty() && !failed && !userOnly(url) && (loading || !paused) : AssistantBrowserPolicy.blocksUserInput(mode, agentRunId, paused, loading, failed, step, url); }
    void background() {
        verificationUrl = null;
        if (!active() || suspended || !dialog.isShowing() || failed || loading
            || !(generalMode ? AssistantBrowserPolicy.browseAllowed(web.getUrl()) : AssistantBrowserPolicy.allowed(web.getUrl()))
            || !AssistantBrowserPolicy.authentication(web.getUrl())) return;
        verificationUrl = web.getUrl(); verificationDocument = documentId;
        verificationStep = step; verificationRun = agentRunId;
    }
    private boolean sameVerification(String url, int document, String expectedStep, String run) {
        return active() && !suspended && dialog.isShowing() && !failed && !loading
            && document == documentId && url.equals(web.getUrl()) && expectedStep.equals(step) && run.equals(agentRunId);
    }
    void foreground() {
        String url = verificationUrl, expectedStep = verificationStep, run = verificationRun;
        int document = verificationDocument;
        verificationUrl = null;
        if (url == null || !sameVerification(url, document, expectedStep, run)) return;
        new AlertDialog.Builder(themedContext(), dialogTheme()).setTitle("登录验证完成了吗？")
            .setMessage("如果已在邮箱或系统浏览器完成验证，继续后会重新检查这里的登录状态。登录状态仍以当前网页为准。")
            .setPositiveButton("已完成，继续", (ignored, which) -> {
                if (!sameVerification(url, document, expectedStep, run)) return;
                loading = true; setPaused(true); readyKey = "";
                web.reload(); actions.emit(new JSObject().put("action", "agent-resume"));
            }).setNegativeButton("尚未完成", null).show();
    }
    private Button button(LinearLayout row, String title, Runnable action) {
        Button button = new Button(dialog.getContext()); button.setText(title); button.setTextSize(14); button.setAllCaps(false);
        button.setStateListAnimator(null); button.setElevation(0);
        button.setMinHeight(dp(44)); button.setMinimumHeight(dp(44)); button.setMinWidth(dp(44)); button.setMinimumWidth(dp(44)); button.setPadding(dp(8), 0, dp(8), 0);
        LinearLayout.LayoutParams layout = new LinearLayout.LayoutParams(-2, dp(44)); layout.setMargins(dp(2), dp(2), dp(2), dp(2));
        button.setOnClickListener(view -> action.run()); row.addView(button, layout); buttons.add(button); return button;
    }
    void navigate(String url) {
        failed = false; failedUrl = null; loading = true; setPaused(true);
        web.loadUrl(url);
    }
    private void updateStatus() {
        if (status == null) return;
        boolean hasPreviousPage = web.canGoBack() || parentWindows.containsKey(web);
        previousPage.setEnabled(hasPreviousPage); previousPage.setAlpha(hasPreviousPage ? 1f : .4f);
        boolean working = !failed && !loading && !paused && !agentRunId.isEmpty() && !userOnly(web.getUrl());
        status.setTypeface(null, working ? android.graphics.Typeface.BOLD : android.graphics.Typeface.NORMAL);
        status.setTextColor(Color.parseColor(working ? darkTheme ? "#92d7d3" : "#1d707b" : darkTheme ? "#b5c8cc" : "#59727c"));
        status.setText(failed ? "网页加载失败 · " + (!agentRunId.isEmpty() && !userOnly(web.getUrl()) ? "助手可继续" : "可重试或返回") : loading ? "正在加载网页…" : userOnly(web.getUrl()) ? (generalMode ? "请你完成登录或私密步骤，再点我继续" : AssistantBrowserPolicy.handoffReason(step, web.getUrl()) + " · 点桌宠查看") : paused || agentRunId.isEmpty() && "agent".equals(mode) ? "已暂停 · 点桌宠查看或继续
" + agentPhase : !agentRunId.isEmpty() ? "小助手操作中 · 点桌宠查看或暂停
" + agentPhase : "点桌宠继续当前步骤");
        progress.setVisibility((loading || !agentRunId.isEmpty() && !paused) && !failed ? android.view.View.VISIBLE : android.view.View.INVISIBLE);
        if (preview != null) preview.invalidate();
    }
    private void loadFailed(String url, String reason) {
        failed = true; loading = false; failedUrl = url; setPaused(true);
        web.setVisibility(android.view.View.GONE); failure.setVisibility(android.view.View.VISIBLE);
        failureTitle.setText("暂时打不开网页");
        boolean canReturn = !agentRunId.isEmpty() && !AssistantBrowserPolicy.userOnly(step, url);
        failureText.setText(reason + " · " + android.net.Uri.parse(url).getHost() + "\n\n" + (canReturn ? "助手可以返回配置页继续，不会自动重试此网址。" : "可以重试此网址，或返回上一页。") + "\n\n也可用系统浏览器检查；登录状态独立，网页协助仍在这里继续。");
        failureText.setPadding(0, dp(12), 0, dp(16));
        pet.say(canReturn ? "这个网页加载失败了，我可以返回配置页继续。" : "这个网页加载失败了，可以重试或返回上一页。");
        pet.rest();
        pageReady();
    }
    private void showDetails() {
        TextView text = new TextView(themedContext()); text.setText(details + "\n\n当前网页：" + AssistantBrowserPolicy.publicUrl(web.getUrl())); text.setTextSize(14); text.setPadding(dp(16), dp(8), dp(16), dp(8));
        text.setTextColor(Color.parseColor(darkTheme ? "#b5c8cc" : "#59727c"));
        ScrollView scroll = new ScrollView(themedContext()); scroll.addView(text);
        new AlertDialog.Builder(themedContext(), dialogTheme()).setTitle(stepTitle).setView(scroll).setPositiveButton("知道了", null).show();
    }
    private int dialogTheme() { return darkTheme ? R.style.DiscordSetupDialogDark : R.style.DiscordSetupDialogLight; }
    private android.content.Context themedContext() { return new android.view.ContextThemeWrapper(activity, dialogTheme()); }
    void setPaused(boolean value) {
        paused = value || loading || failed;
        if (web != null && AssistantBrowserPolicy.blocksUserInput(mode, agentRunId, paused, loading, failed, step, web.getUrl())) {
            web.clearFocus();
            android.view.inputmethod.InputMethodManager keyboard = (android.view.inputmethod.InputMethodManager) activity.getSystemService(android.content.Context.INPUT_METHOD_SERVICE);
            if (keyboard != null) keyboard.hideSoftInputFromWindow(web.getWindowToken(), 0);
        }
        updateStatus();
    }
    void message(String text) { if (text.equals(replyText)) return; replyText = text; if (pet != null && (paused || agentRunId.isEmpty())) pet.say(text.length() > 100 ? text.substring(0, 100) + "…点我看完整回复" : text); updateTranscript(); }
    void phase(String text) { agentPhase = text; if (pet != null && !paused && !agentRunId.isEmpty()) pet.say(""); updateStatus(); updateTranscript(); }
    boolean conversation(String id) { if (conversationId.equals(id)) return false; clearChatPresentation(); conversationId = id; replyText = ""; installationCompleted = false; installationStartedApp = ""; updateTranscript(); return true; }
    void installation(String app, String nextStep) { if (!"discord-install".equals(nextStep) || !app.equals(installationApplicationId)) { installationCompleted = false; installationStartedApp = ""; } installationApplicationId = "discord-install".equals(nextStep) ? app : ""; }
    private void updateTranscript() { if (chatTranscript != null) chatTranscript.setText(stepTitle + "\n" + agentPhase + "\n\n" + (replyText.isEmpty() ? details : replyText)); }
    void petFrame(String data) { if (pet != null) pet.frame(data); }
    void point(JSONObject anchor, String text) { if (pet != null) pet.point(web, anchor, text); }
    private void prepareSecret() {
        String scope = AssistantBrowserPolicy.secretScope(web.getUrl());
        if (loading || failed || scope == null) { message("请先打开本次已确认的 Worker；登录仍由你操作。"); return; }
        if ("input".equals(secretStage)) { message("名称和 Secret 类型已选好。只填写值，填好点我继续；不会读取值。"); return; }
        if ("submit".equals(secretStage) || "saved".equals(secretStage)) { actions.emit(new JSObject().put("action", "secret-submit")); return; }
        if ("submitted".equals(secretStage)) { message("已发出保存部署操作，助手会核验生产结果；不要重复添加 Secret。"); return; }
        if ("prepare".equals(secretStage) && scope.equals(secretScope)) { setPaused(false); return; }
        secretScope = scope; secretStage = "prepare"; secretMarker = "srl-" + Long.toHexString(System.nanoTime());
        setPaused(false); actions.emit(new JSObject().put("action", "secret-prepare"));
    }
    private void talk() {
        if ("agent".equals(mode)) { actions.emit(new JSObject().put("action", "quick-chat")); return; }
        manualTalk();
    }
    void controls() {
        java.util.ArrayList<String> labels = new java.util.ArrayList<>();
        labels.add("填好了，继续"); labels.add("切换步骤");
        String url = web == null ? null : web.getUrl();
        boolean botPage = url != null && url.matches("https://discord.com/developers/applications/[0-9]{17,20}/bot");
        if (botPage) labels.add("加密保存当前 Bot Token");
        if ("discord-token".equals(step)) labels.add("我已自行保存 Token，继续");
        new AlertDialog.Builder(themedContext(), dialogTheme()).setTitle("网页配置操作")
            .setItems(labels.toArray(new String[0]), (ignored, index) -> {
                String selected = labels.get(index);
                if (index == 0) continuePage();
                else if (index == 1) chooseStep();
                else if (selected.equals("加密保存当前 Bot Token")) actions.emit(new JSObject().put("action", "capture-bot-secret"));
                else actions.emit(new JSObject().put("action", "resume"));
            }).setNegativeButton("关闭菜单", null).show();
    }
    private void continuePage() {
        if (loading || failed) { message("网页尚未加载成功，请先检查网络或重试。"); return; }
        boolean secretPage = "cf-secret".equals(step) && AssistantBrowserPolicy.secretScope(web.getUrl()) != null;
        if (secretPage && agentRunId.isEmpty()) {
            if ("input".equals(secretStage)) secretStage = "submit";
            actions.emit(new JSObject().put("action", "agent-resume")); return;
        }
        if (secretPage && ("input".equals(secretStage) || "submit".equals(secretStage) || "saved".equals(secretStage))) {
            if ("input".equals(secretStage)) secretStage = "submit";
            actions.emit(new JSObject().put("action", agentRunId.isEmpty() ? "agent-resume" : "secret-submit")); return;
        }
        if (secretPage) { prepareSecret(); return; }
        if ("discord-token".equals(step)) { message("请先加密保存 Token，或明确确认已自行保存。"); return; }
        if (AssistantBrowserPolicy.userOnly(step, web.getUrl())) { message(AssistantBrowserPolicy.handoffReason(step, web.getUrl())); return; }
        if (!agentRunId.isEmpty() && !paused) { message("我正在继续配置。查看对话不会暂停任务。"); return; }
        setPaused(false); actions.emit(new JSObject().put("action", "resume"));
    }
    private void manualTalk() {
        chatOpen = true;
        EditText input = new EditText(themedContext()); input.setHint("我卡在…（不要填写密钥）");
        input.setTextSize(14); input.setMaxLines(3);
        input.setFilters(new android.text.InputFilter[] { new android.text.InputFilter.LengthFilter(200) });
        LinearLayout content = new LinearLayout(themedContext()); content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(dp(16), 0, dp(16), 0);
        Button fullscreen = new Button(themedContext()); fullscreen.setText("全屏对话"); fullscreen.setTextSize(14); fullscreen.setAllCaps(false);
        fullscreen.setStateListAnimator(null); fullscreen.setElevation(0); fullscreen.setBackgroundColor(Color.TRANSPARENT);
        fullscreen.setTextColor(Color.parseColor(darkTheme ? "#92d7d3" : "#1d707b"));
        content.addView(fullscreen, new LinearLayout.LayoutParams(-1, dp(44)));
        chatTranscript = new TextView(themedContext()); chatTranscript.setTextSize(14);
        chatTranscript.setTextIsSelectable(true);
        chatTranscript.setTextColor(Color.parseColor(darkTheme ? "#eef8f8" : "#183842"));
        ScrollView transcript = new ScrollView(themedContext()); transcript.addView(chatTranscript);
        int transcriptHeight = Math.min(dp(220), activity.getResources().getDisplayMetrics().heightPixels / 3);
        content.addView(transcript, new LinearLayout.LayoutParams(-1, transcriptHeight)); updateTranscript();
        Button tools = new Button(themedContext()); tools.setAllCaps(false); tools.setText("economy".equals(mode) ? "手动工具与步骤" : "切换步骤");
        tools.setStateListAnimator(null); tools.setElevation(0); tools.setBackgroundColor(Color.TRANSPARENT);
        tools.setTextColor(Color.parseColor(darkTheme ? "#92d7d3" : "#1d707b"));
        tools.setOnClickListener(view -> { if ("economy".equals(mode)) more(); else chooseStep(); });
        content.addView(tools, new LinearLayout.LayoutParams(-1, dp(44))); content.addView(input);
        String currentUrl = web.getUrl();
        Button saveSecret = null, manualSaved = null;
        if ("agent".equals(mode) && currentUrl != null && currentUrl.matches("https://discord.com/developers/applications/[0-9]{17,20}/bot")) {
            saveSecret = new Button(themedContext()); saveSecret.setAllCaps(false); saveSecret.setText("加密保存当前 Bot Token");
            content.addView(saveSecret, new LinearLayout.LayoutParams(-1, dp(44)));
        }
        if ("discord-token".equals(step)) {
            manualSaved = new Button(themedContext()); manualSaved.setAllCaps(false); manualSaved.setText("我已自行保存 Token，继续");
            content.addView(manualSaved, new LinearLayout.LayoutParams(-1, dp(44)));
        }
        ScrollView chatContent = new ScrollView(themedContext()); chatContent.addView(content);
        AlertDialog chat = new AlertDialog.Builder(themedContext(), dialogTheme()).setTitle("蒜惹菈在这里")
            .setView(chatContent)
            .setPositiveButton("发送 / 继续", (ignored, which) -> {
                if (loading || failed) { message("网页尚未加载成功，请先检查网络或重试。"); return; }
                String question = input.getText().toString().trim();
                if (!question.isEmpty()) {
                    if (!AssistantBrowserPolicy.maskSecrets(question).equals(question)) { message("不要把密钥填在对话里，请填在网页或密钥资源里。"); return; }
                    actions.emit(new JSObject().put("action", "assist").put("text", question)); return;
                }
                boolean secretPage = "cf-secret".equals(step) && AssistantBrowserPolicy.secretScope(web.getUrl()) != null;
                if ("agent".equals(mode) && secretPage && agentRunId.isEmpty()) {
                    if ("input".equals(secretStage)) secretStage = "submit";
                    actions.emit(new JSObject().put("action", "agent-resume")); return;
                }
                if ("agent".equals(mode) && secretPage && ("input".equals(secretStage) || "submit".equals(secretStage) || "saved".equals(secretStage))) {
                    if ("input".equals(secretStage)) secretStage = "submit";
                    actions.emit(new JSObject().put("action", "secret-submit")); return;
                }
                if ("agent".equals(mode) && secretPage) { prepareSecret(); return; }
                if ("discord-token".equals(step)) { message("请先选择加密保存 Bot Token，或明确确认已自行保存；现在不会跳去 Cloudflare。"); return; }
                if (AssistantBrowserPolicy.userOnly(step, web.getUrl())) { message(AssistantBrowserPolicy.handoffReason(step, web.getUrl())); return; }
                if (!agentRunId.isEmpty() && !paused) { message("我正在继续配置。这里只查看进度不会打断任务；需要接手请点暂停。"); return; }
                setPaused(false);
                actions.emit(new JSObject().put("action", "resume"));
            })
            .setNeutralButton("暂停", (ignored, which) -> {
                setPaused(true); agentRun(""); actions.emit(new JSObject().put("action", "agent-pause"));
            }).setNegativeButton("返回网页", null).create();
        fullscreen.setOnClickListener(view -> {
            String draft = input.getText().toString().trim();
            if (!AssistantBrowserPolicy.maskSecrets(draft).equals(draft)) { input.setError("密钥填在网页里，不转到聊天"); return; }
            chat.dismiss(); actions.emit(new JSObject().put("action", "fullscreen").put("text", draft));
        });
        chat.setOnDismissListener(ignored -> { chatOpen = false; chatTranscript = null; });
        if (saveSecret != null) saveSecret.setOnClickListener(view -> { chat.dismiss(); actions.emit(new JSObject().put("action", "capture-bot-secret")); });
        if (manualSaved != null) manualSaved.setOnClickListener(view -> { chat.dismiss(); actions.emit(new JSObject().put("action", "resume")); });
        chat.show();
        if (chat.getWindow() != null) chat.getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
    }
    void chooseStep() {
        setPaused(true);
        if (!agentRunId.isEmpty()) { agentRun(""); actions.emit(new JSObject().put("action", "agent-pause")); }
        String[] titles = new String[steps.length()];
        for (int index = 0; index < steps.length(); index++) titles[index] = steps.optJSONObject(index).optString("title");
        new AlertDialog.Builder(themedContext(), dialogTheme()).setTitle("你现在卡在哪一步？").setItems(titles, (dialog, index) -> {
            setPaused(true); actions.emit(new JSObject().put("action", "select-step").put("step", steps.optJSONObject(index).optString("id")));
        }).setNegativeButton("先返回", (dialog, which) -> close()).show();
    }
    private void more() {
        String[] labels = { "粘贴教程模板", "检查 Wrangler 格式", "填写 Worker 链接", "打开同一 App 的 Bot 页面", "复制教程模板（手动粘贴）", "指路：标出配置位置", "读取部署页的 Worker 链接", "切换步骤" };
        new AlertDialog.Builder(themedContext(), dialogTheme()).setItems(labels, (ignored, index) -> {
            if (index == 0) actions.emit(new JSObject().put("action", "template"));
            else if (index == 1) actions.emit(new JSObject().put("action", "validate"));
            else if (index == 2) workerInput();
            else if (index == 3) {
                String url = web.getUrl();
                if (url != null && url.matches("https://discord.com/developers/applications/[0-9]{17,20}(/.*)?")) {
                    String app = android.net.Uri.parse(url).getPathSegments().get(2); navigate("https://discord.com/developers/applications/" + app + "/bot");
                } else message("请先打开自己的 Discord App。");
            } else if (index == 4) {
                android.content.ClipboardManager clipboard = (android.content.ClipboardManager) activity.getSystemService(Activity.CLIPBOARD_SERVICE);
                if (clipboard != null) clipboard.setPrimaryClip(android.content.ClipData.newPlainText("Wrangler 教程模板", template));
                message("模板已按你的选择复制。请在自己 Fork 的编辑器粘贴并填写三个空。");
            } else if (index == 5) actions.emit(new JSObject().put("action", "guide"));
            else if (index == 6) actions.emit(new JSObject().put("action", "collect-worker"));
            else if (index == 7) chooseStep();
        }).show();
    }
    private void workerInput() {
        setPaused(true); EditText input = new EditText(themedContext()); input.setSingleLine(true); input.setHint("https://你的-worker.workers.dev");
        input.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        new AlertDialog.Builder(themedContext(), dialogTheme()).setTitle("部署成功的 Worker 根链接").setView(input).setPositiveButton("回填资源库", (dialog, which) -> actions.emit(new JSObject().put("action", "worker-url").put("workerUrl", input.getText().toString()))).setNegativeButton("取消", null).show();
    }
    boolean active() { return !closed && dialog != null && web != null; }
    /** Reparent the existing page, never reopen it or pause the agent for chat. */
    boolean chatPresentation(String presentation, String id, JSONObject bounds) {
        if (!active() || suspended || !conversationId.equals(id) || id.isEmpty() || appWeb == null
            || !(appWeb.getParent() instanceof ViewGroup)) return false;
        if ("browser".equals(presentation)) {
            clearChatPresentation(); dialog.show();
            actions.emit(new JSObject().put("action", "visibility").put("visible", true));
            return true;
        }
        if (!"compact".equals(presentation) && !"fullscreen".equals(presentation)) return false;
        ViewGroup host = (ViewGroup) appWeb.getParent();
        chatMode = presentation;
        if (chatLayer == null) {
            appBackground = appWeb.getBackground();
            chatLayer = new FrameLayout(activity);
            host.addView(chatLayer, host.indexOfChild(appWeb), new ViewGroup.LayoutParams(-1, -1));
            dialog.hide();
            int sourceWidth = surface.getWidth(), sourceHeight = surface.getHeight();
            ((ViewGroup) surface.getParent()).removeView(surface);
            chatLayer.addView(surface, new FrameLayout.LayoutParams(sourceWidth, sourceHeight));
            ViewCompat.requestApplyInsets(surface);
            pet.visible(false);
        }
        chatMode = presentation;
        appWeb.setBackgroundColor("compact".equals(presentation) ? Color.TRANSPARENT : Color.parseColor(darkTheme ? "#1f323a" : "#f2f9fa"));
        if (preview != null) { host.removeView(preview); preview = null; }
        if ("fullscreen".equals(presentation) && bounds != null && bounds.optDouble("width") > 0 && bounds.optDouble("height") > 0) {
            // A local rendering of the target WebView. No bitmap, model request or SRL-page capture.
            preview = new android.view.View(activity) {
                private final android.graphics.Paint paint = new android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG);
                @Override protected void onDraw(android.graphics.Canvas canvas) {
                    if (!active() || !"fullscreen".equals(chatMode)) return;
                    android.graphics.Path clip = new android.graphics.Path();
                    clip.addRoundRect(new android.graphics.RectF(0, 0, getWidth(), getHeight()), dp(12), dp(12), android.graphics.Path.Direction.CW);
                    canvas.save(); canvas.clipPath(clip);
                    canvas.drawColor(Color.parseColor(darkTheme ? "#293f48" : "#fbfefe"));
                    canvas.save(); canvas.clipRect(0, 0, getWidth(), getHeight() - dp(34));
                    android.view.View page = failed ? failure : web;
                    float scale = (float) getWidth() / Math.max(1, page.getWidth()); canvas.scale(scale, scale);
                    drawingPreview = true;
                    try { page.draw(canvas); } finally { drawingPreview = false; }
                    canvas.restore();
                    paint.setColor(Color.parseColor(darkTheme ? "#eef8f8" : "#183842")); paint.setTextSize(dp(11));
                    canvas.drawText(paused ? "已暂停 · 点此返回网页" : "助手操作中 · 点此返回网页", dp(8), getHeight() - dp(18), paint);
                    paint.setTextSize(dp(10));
                    String phase = agentPhase.isEmpty() ? stepTitle : agentPhase;
                    canvas.drawText(phase, dp(8), getHeight() - dp(5), paint);
                    canvas.restore();
                }
            };
            preview.setContentDescription("当前网页和助手进度，点击返回网页协助");
            preview.setOnClickListener(view -> chatPresentation("browser", conversationId, null));
            float scale = appWeb.getWidth() / (float) Math.max(1, bounds.optDouble("viewportWidth", appWeb.getWidth() / activity.getResources().getDisplayMetrics().density));
            int[] appPosition = new int[2], hostPosition = new int[2]; appWeb.getLocationInWindow(appPosition); host.getLocationInWindow(hostPosition);
            ViewGroup.LayoutParams layout = new ViewGroup.LayoutParams(Math.max(1, Math.round((float) bounds.optDouble("width") * scale)), Math.max(1, Math.round((float) bounds.optDouble("height") * scale)));
            host.addView(preview, layout);
            preview.setX(appPosition[0] - hostPosition[0] + Math.round((float) bounds.optDouble("left") * scale));
            preview.setY(appPosition[1] - hostPosition[1] + Math.round((float) bounds.optDouble("top") * scale));
        }
        actions.emit(new JSObject().put("action", "visibility").put("visible", false));
        return true;
    }
    private void clearChatPresentation() {
        if (preview != null) { ((ViewGroup) preview.getParent()).removeView(preview); preview = null; }
        if (chatLayer != null) {
            chatLayer.removeView(surface);
            ((ViewGroup) chatLayer.getParent()).removeView(chatLayer); chatLayer = null;
            dialog.setContentView(surface); pet.visible(true);
            appWeb.setBackground(appBackground);
        }
        chatMode = "";
    }
    void hideForChat() { if (dialog != null) dialog.hide(); actions.emit(new JSObject().put("action", "visibility").put("visible", false)); }
    void revealForAction(String operation) {
        if (!active() || suspended || !chatMode.isEmpty() || agentRunId.isEmpty() || dialog.isShowing()
            || !java.util.Arrays.asList("click", "select", "fill", "focus", "scroll", "navigate", "template", "fill-config", "fill-endpoint", "open-install", "prepare-secret", "submit-secret").contains(operation)) return;
        boolean publicSecret = AssistantBrowserPolicy.secretPublicControlsAllowed(mode, agentRunId, step, web.getUrl(), secretScope, secretStage);
        if (paused && !publicSecret || loading || failed) return;
        dialog.show(); actions.emit(new JSObject().put("action", "visibility").put("visible", true));
    }
    boolean suspend() {
        if (!active() || !dialog.isShowing()) return false;
        suspended = true; resumeAllowed = !paused; suspendedDocument = documentId; suspendedUrl = web.getUrl(); setPaused(true); dialog.hide(); return true;
    }
    void restore(boolean resume) {
        if (!suspended || dialog == null || web == null) return;
        suspended = false; dialog.show();
        setPaused(!(resume && resumeAllowed && !loading && suspendedDocument == documentId && suspendedUrl != null && suspendedUrl.equals(web.getUrl()) && !AssistantBrowserPolicy.userOnly(step, web.getUrl())));
        actions.emit(new JSObject().put("action", "visibility").put("visible", true));
        pageReady();
    }
    void close() { closed = true; setPaused(true); clearChatPresentation(); if (dialog != null) dialog.hide(); actions.emit(new JSObject().put("action", "visibility").put("visible", false)); }
    void destroy() { clearChatPresentation(); if (pet != null) pet.destroy(); if (dialog != null) { if (android.os.Build.VERSION.SDK_INT >= 33 && systemBack != null) dialog.getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(systemBack); dialog.dismiss(); } if (web != null) { web.stopLoading(); web.destroy(); web = null; } }
}
