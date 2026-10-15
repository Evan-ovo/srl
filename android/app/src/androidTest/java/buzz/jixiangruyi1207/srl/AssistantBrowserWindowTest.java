package buzz.jixiangruyi1207.srl;

import static org.junit.Assert.*;
import static androidx.test.espresso.Espresso.onView;
import static androidx.test.espresso.action.ViewActions.click;
import static androidx.test.espresso.action.ViewActions.doubleClick;
import static androidx.test.espresso.matcher.ViewMatchers.withText;
import static androidx.test.espresso.matcher.RootMatchers.isDialog;
import static androidx.test.espresso.matcher.ViewMatchers.withContentDescription;
import static androidx.test.espresso.matcher.ViewMatchers.isAssignableFrom;
import static androidx.test.espresso.matcher.ViewMatchers.isCompletelyDisplayed;
import static androidx.test.espresso.assertion.ViewAssertions.matches;
import static androidx.test.espresso.action.ViewActions.typeTextIntoFocusedView;
import static androidx.test.espresso.Espresso.closeSoftKeyboard;

import android.graphics.Bitmap;
import android.view.WindowManager;
import android.webkit.*;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Local HTML only, run on an explicitly selected isolated emulator; never logs into a site. */
@RunWith(AndroidJUnit4.class)
public class AssistantBrowserWindowTest {
    @Test public void pluginTeardownClearsPendingDelayOnPauseCloseAndDestroy() {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> {
                for (String operation : new String[] {"pause", "close", "destroy"}) {
                    NativeAssistantBrowserPlugin plugin = new NativeAssistantBrowserPlugin() {
                        @Override public androidx.appcompat.app.AppCompatActivity getActivity() { return activity; }
                    };
                    java.util.concurrent.atomic.AtomicBoolean rejected = new java.util.concurrent.atomic.AtomicBoolean();
                    com.getcapacitor.PluginCall delay = new com.getcapacitor.PluginCall(null, "NativeAssistantBrowser", "delay", "wait", new com.getcapacitor.JSObject()) {
                        @Override public void reject(String message) { rejected.set(true); }
                    };
                    com.getcapacitor.PluginCall call = new com.getcapacitor.PluginCall(null, "NativeAssistantBrowser", "stop", operation, new com.getcapacitor.JSObject()) {
                        @Override public void resolve() {}
                    };
                    Runnable callback = () -> fail("Cancelled delay must not run");
                    try {
                        java.lang.reflect.Field pending = NativeAssistantBrowserPlugin.class.getDeclaredField("pendingDelay"); pending.setAccessible(true); pending.set(plugin, delay);
                        java.lang.reflect.Field scheduled = NativeAssistantBrowserPlugin.class.getDeclaredField("delayCallback"); scheduled.setAccessible(true); scheduled.set(plugin, callback);
                        java.lang.reflect.Field handlers = NativeAssistantBrowserPlugin.class.getDeclaredField("delayHandler"); handlers.setAccessible(true);
                        android.os.Handler handler = (android.os.Handler) handlers.get(plugin); handler.postDelayed(callback, 60000);
                        if ("pause".equals(operation)) plugin.pauseAgent(call);
                        else if ("close".equals(operation)) plugin.close(call);
                        else plugin.handleOnDestroy();
                        assertTrue(rejected.get()); assertNull(pending.get(plugin)); assertNull(scheduled.get(plugin));
                        if (android.os.Build.VERSION.SDK_INT >= 29) assertFalse(handler.hasCallbacks(callback));
                    } catch (ReflectiveOperationException error) { throw new AssertionError(error); }
                }
            });
        }
    }
    @Test public void workflowPluginInspectsAndFillsAnotherPublicOriginWithoutChangingPurpose() throws Exception {
        AssistantBrowserWindow[] window = new AssistantBrowserWindow[1];
        NativeAssistantBrowserPlugin[] plugin = new NativeAssistantBrowserPlugin[1];
        CountDownLatch loaded = new CountDownLatch(1);
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> {
                plugin[0] = (NativeAssistantBrowserPlugin) activity.getBridge().getPlugin("NativeAssistantBrowser").getInstance();
                window[0] = new AssistantBrowserWindow(activity, event -> {});
                window[0].open(null, "cf-deploy", "配置", "本机执行Owner夹具", new JSONArray(), "", false, false, false);
                try {
                    java.lang.reflect.Field owner = NativeAssistantBrowserPlugin.class.getDeclaredField("browser");
                    owner.setAccessible(true); owner.set(plugin[0], window[0]);
                } catch (Exception error) { throw new RuntimeException(error); }
                WebViewClient client = window[0].web.getWebViewClient();
                window[0].web.setWebViewClient(new WebViewClient() {
                    @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) { return fixtureHtml("<meta name='viewport' content='width=device-width'><main><p>Create an application</p><label for='name'>Name</label><input id='name'></main>"); }
                    @Override public void onPageStarted(WebView view, String url, Bitmap icon) { client.onPageStarted(view, url, icon); }
                    @Override public void onPageFinished(WebView view, String url) { client.onPageFinished(view, url); loaded.countDown(); }
                });
                window[0].agentRun("plugin-public-run");
                window[0].web.loadUrl("https://example.org/form");
            });
            assertTrue(loaded.await(15, TimeUnit.SECONDS));
            java.util.concurrent.BlockingQueue<com.getcapacitor.JSObject> replies = new java.util.concurrent.LinkedBlockingQueue<>();
            scenario.onActivity(activity -> plugin[0].inspect(recordingCall("inspect", new com.getcapacitor.JSObject(), replies)));
            com.getcapacitor.JSObject observed = replies.poll(10, TimeUnit.SECONDS);
            assertNotNull(observed); assertFalse(observed.has("testError"));
            assertTrue(observed.optString("text").contains("Create an application"));
            String target = "";
            JSONArray controls = observed.optJSONArray("controls");
            assertNotNull(controls);
            for (int i = 0; i < controls.length(); i++) if ("Name".equals(controls.getJSONObject(i).optString("label"))) target = controls.getJSONObject(i).optString("target");
            assertFalse(target.isEmpty());
            com.getcapacitor.JSObject fill = new com.getcapacitor.JSObject().put("operation", "fill").put("documentId", observed.optInt("documentId")).put("target", target).put("value", "SRL Bridge");
            scenario.onActivity(activity -> plugin[0].act(recordingCall("act", fill, replies)));
            com.getcapacitor.JSObject receipt = replies.poll(10, TimeUnit.SECONDS);
            assertNotNull(receipt); assertTrue(receipt.toString(), receipt.optBoolean("ok"));
            CountDownLatch filled = new CountDownLatch(1);
            scenario.onActivity(activity -> window[0].web.evaluateJavascript("document.querySelector('#name').value", value -> { assertEquals("\"SRL Bridge\"", value); filled.countDown(); }));
            assertTrue(filled.await(5, TimeUnit.SECONDS));
            scenario.onActivity(activity -> { assertFalse(window[0].generalMode); assertEquals("cf-deploy", window[0].step); window[0].close(); });
        }
    }
    private static com.getcapacitor.PluginCall recordingCall(String method, com.getcapacitor.JSObject data, java.util.concurrent.BlockingQueue<com.getcapacitor.JSObject> replies) {
        return new com.getcapacitor.PluginCall(null, "NativeAssistantBrowser", "fixture", method, data) {
            @Override public void resolve(com.getcapacitor.JSObject value) { replies.offer(value); }
            @Override public void resolve() { replies.offer(new com.getcapacitor.JSObject()); }
            @Override public void reject(String message, String code, Exception error, com.getcapacitor.JSObject value) { replies.offer(new com.getcapacitor.JSObject().put("testError", message)); }
        };
    }
    @Test public void workflowAgentTouchesAnotherPublicOriginAndStillHonorsPauseAndGeneration() throws Exception {
        AssistantBrowserWindow[] window = new AssistantBrowserWindow[1];
        CountDownLatch loaded = new CountDownLatch(1);
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> {
                window[0] = new AssistantBrowserWindow(activity, event -> {});
                window[0].open(null, "cf-deploy", "配置", "本机跨站代理夹具", new JSONArray(), "", false, false, false);
                WebViewClient owner = window[0].web.getWebViewClient();
                window[0].web.setWebViewClient(new WebViewClient() {
                    @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) { return fixtureHtml("<meta name='viewport' content='width=device-width'><button style='width:100vw;height:100vh' onclick=\"document.body.dataset.trusted=event.isTrusted\">Save</button>"); }
                    @Override public void onPageStarted(WebView view, String url, Bitmap icon) { owner.onPageStarted(view, url, icon); }
                    @Override public void onPageFinished(WebView view, String url) { owner.onPageFinished(view, url); loaded.countDown(); }
                });
                window[0].agentRun("public-origin-run");
                window[0].web.loadUrl("https://example.org/form");
            });
            assertTrue(loaded.await(15, TimeUnit.SECONDS));
            clickFixture(scenario, window, false);
            CountDownLatch trusted = new CountDownLatch(1);
            scenario.onActivity(activity -> window[0].web.evaluateJavascript("document.body.dataset.trusted", value -> {
                assertEquals("\"true\"", value); trusted.countDown();
            }));
            assertTrue(trusted.await(5, TimeUnit.SECONDS));
            scenario.onActivity(activity -> {
                assertFalse("viewing an ordinary site does not pause the workflow", window[0].paused);
                try {
                    JSONObject point = new JSONObject().put("x", 5).put("y", 5);
                    int observedDocument = window[0].documentId;
                    window[0].setPaused(true);
                    assertFalse(window[0].clickPublicTarget(point, observedDocument, "public-origin-run"));
                    window[0].setPaused(false); window[0].documentId++;
                    assertFalse(window[0].clickPublicTarget(point, observedDocument, "public-origin-run"));
                } catch (Exception error) { throw new RuntimeException(error); }
                window[0].close();
            });
        }
    }
    @Test public void discordWorkflowAllowsManualLoginRedirectsAndEmptyPopupDocuments() {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> {
                AssistantBrowserWindow window = new AssistantBrowserWindow(activity, event -> {});
                window.open(null, "cf-deploy", "登录", "本机导航夹具", new JSONArray(), "", false, false, false);
                window.agentRun("login-navigation-run");
                WebViewClient client = window.web.getWebViewClient();
                for (String destination : new String[] { "https://accounts.google.com/v3/signin/identifier", "https://challenges.cloudflare.com/", "about:blank", "about:srcdoc" }) {
                    WebResourceRequest request = new WebResourceRequest() {
                        public android.net.Uri getUrl() { return android.net.Uri.parse(destination); }
                        public boolean isForMainFrame() { return true; }
                        public boolean isRedirect() { return true; }
                        public boolean hasGesture() { return false; }
                        public String getMethod() { return "GET"; }
                        public java.util.Map<String, String> getRequestHeaders() { return java.util.Collections.emptyMap(); }
                    };
                    assertFalse("WebView must handle login navigation: " + destination, client.shouldOverrideUrlLoading(window.web, request));
                    client.onPageStarted(window.web, destination, null);
                    assertTrue("navigation does not authorize the agent", window.paused);
                }
                window.close();
            });
        }
    }
    @Test public void renderedChatSwitchAcknowledgesTheHostAndDiscardsALateClosedRequest() throws Exception {
        AssistantBrowserWindow[] window = new AssistantBrowserWindow[1];
        CountDownLatch loaded = new CountDownLatch(1), switched = new CountDownLatch(1), returned = new CountDownLatch(1), discarded = new CountDownLatch(1);
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> {
                WebView app = activity.getBridge().getWebView();
                app.setWebViewClient(new WebViewClient() {
                    @Override public void onPageFinished(WebView view, String url) { loaded.countDown(); }
                });
                app.loadDataWithBaseURL("https://localhost/", "<!doctype html><meta name='viewport' content='width=device-width'><style>html,body{background:transparent}</style><p>同一聊天小窗</p>", "text/html", "UTF-8", null);
            });
            assertTrue(loaded.await(15, TimeUnit.SECONDS));
            scenario.onActivity(activity -> {
                window[0] = new AssistantBrowserWindow(activity, activity.getBridge().getWebView(), event -> {});
                window[0].conversation("rendered-task-chat");
                window[0].open(null, "cf-deploy", "配置网页", "", new JSONArray(), "", false, false, false);
            });
            scenario.onActivity(activity -> window[0].presentChat("compact", "rendered-task-chat", null, accepted -> {
                assertTrue(accepted);
                assertFalse(window[0].browserShowing());
                switched.countDown();
            }));
            assertTrue(switched.await(10, TimeUnit.SECONDS));
            scenario.onActivity(activity -> window[0].presentChat("browser", "rendered-task-chat", null, accepted -> {
                assertTrue("return completes only after the browser draws", accepted);
                assertTrue(window[0].browserShowing());
                returned.countDown();
            }));
            assertTrue(returned.await(10, TimeUnit.SECONDS));
            scenario.onActivity(activity -> {
                window[0].presentChat("fullscreen", "rendered-task-chat", new JSONObject(), accepted -> {
                    assertFalse("late rendered frame must not reopen a closed task", accepted);
                    assertFalse(window[0].browserShowing());
                    discarded.countDown();
                });
                window[0].close();
            });
            assertTrue(discarded.await(10, TimeUnit.SECONDS));
            scenario.onActivity(activity -> window[0].destroy());
        }
    }
    @Test public void loadingVerificationKeepsManualTouchAndCookieSupport() throws Exception {
        AssistantBrowserWindow[] window = new AssistantBrowserWindow[1];
        CountDownLatch rendered = new CountDownLatch(1), clicked = new CountDownLatch(1);
        String[] result = new String[1];
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> {
                window[0] = new AssistantBrowserWindow(activity, activity.getBridge().getWebView(), event -> {});
                window[0].open(null, "d1-create", "登录验证", "隔离页面", new JSONArray(), "", false, false, false);
                WebViewClient owner = window[0].web.getWebViewClient();
                window[0].web.setWebViewClient(new WebViewClient() {
                    @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                        return fixtureHtml("<!doctype html><meta name='viewport' content='width=device-width,initial-scale=1'><body style='margin:0'><button style='width:100vw;height:100vh' onclick=\"console.log('verification-click:'+event.isTrusted)\">完成网站验证</button>");
                    }
                    @Override public void onPageStarted(WebView view, String url, Bitmap icon) { owner.onPageStarted(view, url, icon); }
                    // The verification document is interactive before its final load/redirect completes.
                    @Override public void onPageFinished(WebView view, String url) { rendered.countDown(); }
                });
                window[0].web.setWebChromeClient(new android.webkit.WebChromeClient() {
                    @Override public boolean onConsoleMessage(android.webkit.ConsoleMessage message) {
                        if (message.message().startsWith("verification-click:")) { result[0] = message.message(); clicked.countDown(); return true; }
                        return false;
                    }
                });
                window[0].agentRun("verification-loading-run");
                window[0].navigate("https://dash.cloudflare.com/");
            });
            assertTrue(rendered.await(15, TimeUnit.SECONDS));
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            scenario.onActivity(activity -> {
                assertTrue(window[0].loading); assertTrue(window[0].paused);
                assertTrue(android.webkit.CookieManager.getInstance().acceptThirdPartyCookies(window[0].web));
            });
            onView(new org.hamcrest.TypeSafeMatcher<android.view.View>() {
                @Override public void describeTo(org.hamcrest.Description description) { description.appendText("target verification WebView"); }
                @Override protected boolean matchesSafely(android.view.View view) { return view == window[0].web; }
            }).perform(click());
            assertTrue(clicked.await(5, TimeUnit.SECONDS));
            assertEquals("manual verification is not consumed by the agent input guard", "verification-click:true", result[0]);
            scenario.onActivity(activity -> window[0].destroy());
        }
    }
    @Test public void cancelledChatInputDoesNotDispatchOrRestoreAnOldRun() throws Exception {
        AssistantBrowserWindow[] window = new AssistantBrowserWindow[1];
        AtomicInteger dispatched = new AtomicInteger(); CountDownLatch rejected = new CountDownLatch(1);
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> {
                window[0] = new AssistantBrowserWindow(activity, activity.getBridge().getWebView(), event -> {});
                window[0].conversation("cancel-native-chat"); window[0].agentRun("old-focus-run");
                window[0].open(null, "github-fork", "配置网页", "", new JSONArray(), "", false, false, false);
                assertTrue(window[0].chatPresentation("compact", "cancel-native-chat", null));
                window[0].dispatchChatInput(completed -> { dispatched.incrementAndGet(); completed.accept(true); }, accepted -> { assertFalse(accepted); rejected.countDown(); });
                window[0].agentRun("new-focus-run");
            });
            assertTrue(rejected.await(5, TimeUnit.SECONDS)); assertEquals(0, dispatched.get());
            scenario.onActivity(activity -> { assertEquals("new-focus-run", window[0].agentRunId); window[0].destroy(); });
        }
    }
    @Test public void restorationWithoutResumeNeverRestartsAPausedPage() throws Exception {
        AssistantBrowserWindow[] window = new AssistantBrowserWindow[1];
        CountDownLatch loaded = new CountDownLatch(1);
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> {
                window[0] = new AssistantBrowserWindow(activity, activity.getBridge().getWebView(), event -> {});
                window[0].conversation("restore-without-resume");
                window[0].open(null, "browser-general", "恢复检查", "", new JSONArray(), "", false, false, true);
                WebViewClient owner = window[0].web.getWebViewClient();
                window[0].web.setWebViewClient(new WebViewClient() {
                    @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) { return fixtureHtml("<!doctype html><p>公开表单</p>"); }
                    @Override public void onPageStarted(WebView view, String url, Bitmap icon) { owner.onPageStarted(view, url, icon); }
                    @Override public void onPageFinished(WebView view, String url) { owner.onPageFinished(view, url); loaded.countDown(); }
                });
                window[0].agentRun("restore-without-resume-run");
                window[0].navigate("https://example.com/form");
            });
            assertTrue(loaded.await(15, TimeUnit.SECONDS));
            scenario.onActivity(activity -> {
                int document = window[0].documentId;
                assertFalse(window[0].paused);
                assertTrue(window[0].suspend());
                window[0].restore(false);
                assertTrue("revealing the original page does not authorize agent resumption", window[0].paused);
                assertTrue(window[0].suspend());
                window[0].restore(true);
                assertTrue("a page already paused before suspension stays paused", window[0].paused);
                assertEquals(document, window[0].documentId);
                window[0].destroy();
            });
        }
    }
    @Test public void explicitContinueRestoresChatOrSuspendedPageWithoutReloading() throws Exception {
        AssistantBrowserWindow[] window = new AssistantBrowserWindow[1];
        CountDownLatch loaded = new CountDownLatch(1);
        AtomicInteger documents = new AtomicInteger();
        AtomicInteger chatRequests = new AtomicInteger();
        String url = "https://github.com/example/repo";
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> {
                window[0] = new AssistantBrowserWindow(activity, activity.getBridge().getWebView(), event -> {
                    if ("quick-chat".equals(event.optString("action"))) chatRequests.incrementAndGet();
                });
                window[0].conversation("resume-native-chat"); window[0].agentRun("resume-native-run");
                window[0].open(null, "github-fork", "配置网页", "", new JSONArray(), "", false, false, false);
                WebViewClient client = window[0].web.getWebViewClient();
                window[0].web.setWebViewClient(new WebViewClient() {
                    @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest request) { return fixtureHtml("<body>已打开的配置表单</body>"); }
                    @Override public void onPageStarted(WebView v, String target, Bitmap icon) { documents.incrementAndGet(); client.onPageStarted(v, target, icon); }
                    @Override public void onPageFinished(WebView v, String target) { client.onPageFinished(v, target); loaded.countDown(); }
                });
                window[0].web.loadUrl(url);
            });
            assertTrue(loaded.await(15, TimeUnit.SECONDS));
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            onView(withContentDescription("蒜惹菈，点击对话，拖动移动")).perform(click());
            scenario.onActivity(activity -> {
                assertEquals(1, chatRequests.get());
                assertTrue("pet click waits for the shared chat before hiding the browser", window[0].browserShowing());
                WebView original = window[0].web;
                int document = window[0].documentId, requests = documents.get();
                assertTrue(window[0].chatPresentation("compact", "resume-native-chat", null));
                window[0].open(null, "github-save", "下一配置步骤", "", new JSONArray(), "", false, false, false);
                assertFalse(window[0].browserShowing());
                window[0].open(null, "github-save", "继续配置", "", new JSONArray(), "", false, false, false, true);
                assertTrue(window[0].browserShowing());
                assertSame(original, window[0].web); assertEquals(document, window[0].documentId);
                assertEquals(url, original.getUrl()); assertEquals(requests, documents.get());
                assertTrue(window[0].suspend());
                window[0].open(null, "github-save", "继续配置", "", new JSONArray(), "", false, false, false, true);
                assertTrue(window[0].browserShowing());
                assertFalse(window[0].paused); assertEquals("resume-native-run", window[0].agentRunId);
                window[0].restore(false);
                assertFalse("late restoration cannot undo explicit continuation", window[0].paused);
                assertSame(original, window[0].web); assertEquals(document, window[0].documentId);
                assertEquals(requests, documents.get()); window[0].destroy();
            });
        }
    }

    @org.junit.Test public void generalTaskUsesTrustedClickAndNativeKeyboardOnItsOwnWebView() throws Exception {
        AssistantBrowserWindow[] window = new AssistantBrowserWindow[1]; CountDownLatch loaded = new CountDownLatch(1);
        String html = "<meta name='viewport' content='width=device-width,initial-scale=1'><button style='width:200px;height:60px' onclick='document.body.dataset.clicked=event.isTrusted'>普通表单</button><input id='field'><script>document.querySelector('input').onkeydown=e=>{document.body.dataset.key=e.key;document.body.dataset.trusted=e.isTrusted}</script>";
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> {
                window[0] = new AssistantBrowserWindow(activity, event -> {});
                window[0].open(null, "browser-general", "网页任务", "原生通用执行器", new JSONArray(), "", false, false, true);
                WebView view = window[0].web; WebViewClient original = view.getWebViewClient();
                view.setWebViewClient(new WebViewClient() {
                    @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest request) { return fixtureHtml(html); }
                    @Override public void onPageStarted(WebView v, String url, Bitmap icon) { original.onPageStarted(v,url,icon); }
                    @Override public void onPageFinished(WebView v, String url) { original.onPageFinished(v,url); loaded.countDown(); }
                });
                window[0].agentRun("general-native-run"); view.loadUrl("https://example.org/form");
            });
            assertTrue(loaded.await(15, TimeUnit.SECONDS));
            CountDownLatch click = new CountDownLatch(1);
            scenario.onActivity(activity -> window[0].web.evaluateJavascript("(()=>{const r=document.querySelector('button').getBoundingClientRect();return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2})})()", raw -> {
                try { assertTrue(window[0].clickPublicTarget(new JSONObject(new org.json.JSONTokener(raw).nextValue().toString()), window[0].documentId, "general-native-run")); click.countDown(); }
                catch (Exception e) { throw new AssertionError(e); }
            }));
            assertTrue(click.await(5, TimeUnit.SECONDS));
            CountDownLatch focus = new CountDownLatch(1);
            scenario.onActivity(activity -> window[0].dispatchChatInput(completed -> window[0].web.evaluateJavascript("document.querySelector('input').focus()", raw -> completed.accept(window[0].pressPublicKey("Enter", window[0].documentId, "general-native-run"))), accepted -> { assertTrue(accepted); focus.countDown(); }));
            assertTrue(focus.await(5, TimeUnit.SECONDS));
            CountDownLatch checked = new CountDownLatch(1);
            scenario.onActivity(activity -> window[0].web.evaluateJavascript("JSON.stringify([document.body.dataset.clicked,document.body.dataset.key,document.body.dataset.trusted])", raw -> { try { JSONArray values = new JSONArray(new org.json.JSONTokener(raw).nextValue().toString()); assertEquals("true", values.getString(0)); assertEquals("Enter", values.getString(1)); assertEquals("true", values.getString(2)); checked.countDown(); } catch (Exception e) { throw new AssertionError(e); } }));
            assertTrue(checked.await(5, TimeUnit.SECONDS));
            CountDownLatch discordKey = new CountDownLatch(1);
            scenario.onActivity(activity -> {
                window[0].generalMode = false; window[0].step = "d1-create";
                assertFalse(window[0].pressPublicKey("Escape", window[0].documentId - 1, "general-native-run"));
                assertFalse(window[0].pressPublicKey("Escape", window[0].documentId, "stale-run"));
                window[0].paused = true;
                assertFalse(window[0].pressPublicKey("Escape", window[0].documentId, "general-native-run"));
                window[0].paused = false;
                window[0].dispatchChatInput(completed -> window[0].web.evaluateJavascript("document.querySelector('input').focus()", raw -> completed.accept(window[0].pressPublicKey("Escape", window[0].documentId, "general-native-run"))), accepted -> {
                    assertTrue(accepted);
                    window[0].web.evaluateJavascript("JSON.stringify([document.body.dataset.key,document.body.dataset.trusted])", raw -> { try { JSONArray values = new JSONArray(new org.json.JSONTokener(raw).nextValue().toString()); assertEquals("Escape", values.getString(0)); assertEquals("true", values.getString(1)); discordKey.countDown(); } catch (Exception e) { throw new AssertionError(e); } });
                });
            });
            assertTrue(discordKey.await(5, TimeUnit.SECONDS));
            scenario.onActivity(activity -> { window[0].close(); assertFalse(window[0].pressPublicKey("Enter", window[0].documentId, "general-native-run")); window[0].destroy(); assertEquals(0, window[0].tabSnapshot().length()); });
        }
    }
    @Test public void sharedChatRetainsThePageAndAgentUntilPreviewReturns() throws Exception {
        AssistantBrowserWindow[] window = new AssistantBrowserWindow[1]; WebView[] original = new WebView[1];
        WebView[] chatWeb = new WebView[1];
        int[] document = new int[1];
        int[] viewport = new int[2];
        AtomicInteger attachmentChanges = new AtomicInteger();
        CountDownLatch loaded = new CountDownLatch(1);
        String html = "<!doctype html><meta name='viewport' content='width=device-width'><body style='background:#21767f;color:white'><h1>当前配置网页</h1><button style='width:200px;height:60px' onclick=\"document.body.dataset.clicked=event.isTrusted\">保存配置</button><p>全屏对话时助手继续工作</p>";
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> {
                WebView app = activity.getBridge().getWebView();
                chatWeb[0] = app;
                app.loadDataWithBaseURL("https://localhost/", "<body style='background:#f2f9fa'><h1>蒜惹菈完整对话</h1><p>保留同一份聊天记录</p><form class='chat-composer'><textarea id='draft'>用户尚未发送的消息</textarea></form></body>", "text/html", "UTF-8", null);
                window[0] = new AssistantBrowserWindow(activity, app, event -> {});
                window[0].conversation("chat-native-test");
                window[0].open(null, "cf-deploy", "配置 Worker", "本地回归", new JSONArray(), "", false, false, false);
                original[0] = window[0].web;
                WebViewClient client = original[0].getWebViewClient();
                original[0].setWebViewClient(new WebViewClient() {
                    @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) { return fixtureHtml(html); }
                    @Override public void onPageStarted(WebView view, String url, Bitmap icon) { client.onPageStarted(view, url, icon); }
                    @Override public void onPageFinished(WebView view, String url) { client.onPageFinished(view, url); loaded.countDown(); }
                });
                window[0].agentRun("chat-native-run");
                original[0].loadUrl("https://dash.cloudflare.com/account/workers/services/view/bridge/production/settings");
            });
            assertTrue(loaded.await(15, TimeUnit.SECONDS));
            scenario.onActivity(activity -> {
                original[0].addOnAttachStateChangeListener(new android.view.View.OnAttachStateChangeListener() {
                    @Override public void onViewAttachedToWindow(android.view.View view) { attachmentChanges.incrementAndGet(); }
                    @Override public void onViewDetachedFromWindow(android.view.View view) { attachmentChanges.incrementAndGet(); }
                });
                document[0] = window[0].documentId;
                viewport[0] = original[0].getWidth(); viewport[1] = original[0].getHeight();
                assertFalse(window[0].paused);
                assertTrue(window[0].chatPresentation("compact", "chat-native-test", null));
                assertTrue(original[0].isShown());
                assertFalse(window[0].paused);
                assertFalse(window[0].chatPresentation("fullscreen", "expired-chat", new JSONObject()));
            });
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            scenario.onActivity(activity -> {
                assertEquals("chat keeps the observed page width", viewport[0], original[0].getWidth());
                assertEquals("chat keeps the observed page height", viewport[1], original[0].getHeight());
                JSONObject bounds = new JSONObject();
                try { bounds.put("left", 160).put("top", 280).put("width", 180).put("height", 150).put("viewportWidth", activity.getBridge().getWebView().getWidth() / activity.getResources().getDisplayMetrics().density); } catch (org.json.JSONException impossible) { throw new AssertionError(impossible); }
                assertTrue(window[0].chatPresentation("fullscreen", "chat-native-test", bounds));
                window[0].phase("正在保存配置"); window[0].revealForAction("click");
                assertFalse(window[0].browserShowing());
                assertSame(original[0], window[0].web); assertEquals(document[0], window[0].documentId);
                assertFalse(window[0].paused); assertEquals("chat-native-run", window[0].agentRunId);
            });
            CountDownLatch focused = new CountDownLatch(1);
            scenario.onActivity(activity -> {
                chatWeb[0].requestFocus();
                chatWeb[0].evaluateJavascript("document.querySelector('#draft').focus();document.querySelector('#draft').setSelectionRange(2,4)", raw -> focused.countDown());
            });
            assertTrue(focused.await(5, TimeUnit.SECONDS));
            CountDownLatch acted = new CountDownLatch(1);
            scenario.onActivity(activity -> original[0].evaluateJavascript("(()=>{const r=document.querySelector('button').getBoundingClientRect();return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2})})()", raw -> {
                try { JSONObject anchor = new JSONObject(new org.json.JSONTokener(raw).nextValue().toString()); window[0].dispatchChatInput(completed -> completed.accept(window[0].clickPublicTarget(anchor, document[0], "chat-native-run")), accepted -> { assertTrue(accepted); acted.countDown(); }); } catch (org.json.JSONException error) { throw new AssertionError(error); }
            }));
            assertTrue(acted.await(5, TimeUnit.SECONDS));
            CountDownLatch checked = new CountDownLatch(1);
            String[] clickResult = new String[1];
            scenario.onActivity(activity -> original[0].evaluateJavascript("document.body.dataset.clicked", raw -> { clickResult[0] = raw; checked.countDown(); }));
            assertTrue(checked.await(5, TimeUnit.SECONDS));
            assertEquals("\"true\"", clickResult[0]);
            CountDownLatch draftChecked = new CountDownLatch(1);
            String[] draftResult = new String[1];
            scenario.onActivity(activity -> {
                assertTrue("background action must return the chat input focus", chatWeb[0].hasFocus());
                chatWeb[0].evaluateJavascript("JSON.stringify([document.activeElement.id,document.querySelector('#draft').value,document.querySelector('#draft').selectionStart,document.querySelector('#draft').selectionEnd])", raw -> { draftResult[0] = raw; draftChecked.countDown(); });
            });
            assertTrue(draftChecked.await(5, TimeUnit.SECONDS));
            JSONArray draft = new JSONArray(new org.json.JSONTokener(draftResult[0]).nextValue().toString());
            assertEquals("draft", draft.getString(0)); assertEquals("用户尚未发送的消息", draft.getString(1));
            assertEquals(2, draft.getInt(2)); assertEquals(4, draft.getInt(3));
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            // Compare the current page after keyboard/inset layout has settled, not its pre-chat size.
            scenario.onActivity(activity -> { viewport[0] = original[0].getWidth(); viewport[1] = original[0].getHeight(); });
            onView(withContentDescription("当前网页和助手进度，可拖动和缩放，双击返回网页协助")).perform(click());
            scenario.onActivity(activity -> {
                assertFalse("a single tap keeps the chat open", window[0].browserShowing());
                android.view.View preview = previewView(window[0]);
                float x = preview.getX(), y = preview.getY();
                previewGesture(preview, 24, 24, -56, 104);
                assertTrue("drag changes the floating position", preview.getX() != x || preview.getY() != y);
                assertFalse(window[0].browserShowing());
            });
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            scenario.onActivity(activity -> {
                android.view.View preview = previewView(window[0]);
                int width = preview.getWidth(), height = preview.getHeight();
                previewGesture(preview, width - 8, height - 8, width + 52, height + 42);
                assertTrue("corner resize changes preview dimensions", preview.getLayoutParams().width > width);
                assertTrue(preview.getLayoutParams().height > height);
                assertEquals("resizing never changes the target page", viewport[0], original[0].getWidth());
                assertEquals(viewport[1], original[0].getHeight());
                assertEquals(document[0], window[0].documentId);
                assertTrue(window[0].suspend());
                assertEquals(android.view.View.GONE, preview.getVisibility());
                window[0].restore(true);
                assertEquals(android.view.View.VISIBLE, preview.getVisibility());
                assertFalse("confirm restoration keeps fullscreen chat", window[0].browserShowing());
                assertFalse(window[0].paused);
            });
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            int[] previewBounds = new int[4];
            scenario.onActivity(activity -> {
                try { java.lang.reflect.Field field = AssistantBrowserWindow.class.getDeclaredField("preview"); field.setAccessible(true); android.view.View view = (android.view.View) field.get(window[0]); int[] position = new int[2]; view.getLocationOnScreen(position); previewBounds[0] = position[0]; previewBounds[1] = position[1]; previewBounds[2] = view.getWidth(); previewBounds[3] = view.getHeight(); }
                catch (ReflectiveOperationException error) { throw new AssertionError(error); }
            });
            Bitmap screen = InstrumentationRegistry.getInstrumentation().getUiAutomation().takeScreenshot();
            assertNotNull(screen);
            int visiblePagePixels = 0;
            for (int y = previewBounds[1] + 8; y < previewBounds[1] + previewBounds[3] / 2; y += 4)
                for (int x = previewBounds[0] + 8; x < previewBounds[0] + previewBounds[2] - 8; x += 4)
                    if ((screen.getPixel(x, y) & 0xffffff) == 0x21767f) visiblePagePixels++;
            assertTrue("preview must render the target page, not a blank placeholder", visiblePagePixels > 20);
            try (FileOutputStream out = new FileOutputStream(new File(InstrumentationRegistry.getInstrumentation().getTargetContext().getExternalFilesDir(null), "task-chat-native.png"))) { screen.compress(Bitmap.CompressFormat.PNG, 100, out); }
            screen.recycle();
            onView(withContentDescription("当前网页和助手进度，可拖动和缩放，双击返回网页协助")).perform(doubleClick());
            scenario.onActivity(activity -> {
                assertSame(original[0], window[0].web); assertEquals(document[0], window[0].documentId);
                assertFalse(window[0].paused); assertEquals("chat-native-run", window[0].agentRunId);
                assertEquals("compact, fullscreen and return keep the renderer attached", 0, attachmentChanges.get());
                assertTrue(window[0].suspend());
                window[0].close(); window[0].restore(true);
                assertFalse("late consent restoration cannot reopen a closed window", window[0].browserShowing());
                assertFalse(window[0].chatPresentation("fullscreen", "chat-native-test", new JSONObject()));
                window[0].destroy();
            });
        }
    }
    private static android.view.View previewView(AssistantBrowserWindow window) {
        try { java.lang.reflect.Field field = AssistantBrowserWindow.class.getDeclaredField("preview"); field.setAccessible(true); return (android.view.View) field.get(window); }
        catch (ReflectiveOperationException error) { throw new AssertionError(error); }
    }
    private static void previewGesture(android.view.View view, float x, float y, float endX, float endY) {
        long time = android.os.SystemClock.uptimeMillis();
        int[] actions = { android.view.MotionEvent.ACTION_DOWN, android.view.MotionEvent.ACTION_MOVE, android.view.MotionEvent.ACTION_UP };
        for (int i = 0; i < actions.length; i++) {
            android.view.MotionEvent event = android.view.MotionEvent.obtain(time, time + i * 32, actions[i], i == 0 ? x : endX, i == 0 ? y : endY, 0);
            try { view.dispatchTouchEvent(event); } finally { event.recycle(); }
        }
    }
    @Test public void agentTouchOpensPopupAndReturnsToItsOpener() throws Exception {
        String parentUrl = "https://dash.cloudflare.com/account/workers-and-pages/create";
        String popupUrl = "https://github.com/settings/installations/1234";
        String parentHtml = "<!doctype html><meta name='viewport' content='width=device-width'><button style='width:200px;height:60px' onclick=\"document.body.dataset.trusted=event.isTrusted;window.open('" + popupUrl + "','authorize')\">Connect GitHub</button><script>addEventListener('message',e=>{if(e.origin==='https://github.com')document.body.dataset.connected=e.data})</script>";
        String popupHtml = "<!doctype html><meta name='viewport' content='width=device-width'><button style='width:200px;height:60px' onclick=\"document.body.dataset.clicked=event.isTrusted;window.opener.postMessage('connected','https://dash.cloudflare.com');window.close()\">Save</button>";
        AssistantBrowserWindow[] window = new AssistantBrowserWindow[1]; WebView[] parent = new WebView[1];
        CountDownLatch loaded = new CountDownLatch(1), popupLoaded = new CountDownLatch(1), returned = new CountDownLatch(1);
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> {
                window[0] = new AssistantBrowserWindow(activity, event -> {});
                window[0].open(null, "cf-deploy", "窗口回归", "隔离 HTML", new JSONArray(), "", false, false, false);
                parent[0] = window[0].web;
                WebViewClient parentClient = parent[0].getWebViewClient(); WebChromeClient parentChrome = parent[0].getWebChromeClient();
                parent[0].setWebViewClient(new WebViewClient() {
                    @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) { return fixtureHtml(parentHtml); }
                    @Override public void onPageStarted(WebView view, String url, Bitmap icon) { parentClient.onPageStarted(view, url, icon); }
                    @Override public void onPageFinished(WebView view, String url) { parentClient.onPageFinished(view, url); loaded.countDown(); }
                });
                parent[0].setWebChromeClient(new WebChromeClient() {
                    @Override public boolean onCreateWindow(WebView view, boolean isDialog, boolean gesture, android.os.Message result) {
                        assertTrue("native touch must supply user activation", gesture);
                        boolean accepted = parentChrome.onCreateWindow(view, isDialog, gesture, result);
                        if (accepted) {
                            WebViewClient client = window[0].web.getWebViewClient(); WebChromeClient chrome = window[0].web.getWebChromeClient();
                            window[0].web.setWebViewClient(new WebViewClient() {
                                @Override public WebResourceResponse shouldInterceptRequest(WebView child, WebResourceRequest request) { return fixtureHtml(popupHtml); }
                                @Override public void onPageStarted(WebView child, String url, Bitmap icon) { client.onPageStarted(child, url, icon); }
                                @Override public void onPageFinished(WebView child, String url) { client.onPageFinished(child, url); popupLoaded.countDown(); }
                            });
                            window[0].web.setWebChromeClient(new WebChromeClient() {
                                @Override public void onCloseWindow(WebView child) { chrome.onCloseWindow(child); returned.countDown(); }
                            });
                        }
                        return accepted;
                    }
                });
                window[0].agentRun("popup-test"); parent[0].loadUrl(parentUrl);
            });
            assertTrue(loaded.await(15, TimeUnit.SECONDS));
            clickFixture(scenario, window, true);
            assertTrue(popupLoaded.await(15, TimeUnit.SECONDS));
            scenario.onActivity(activity -> { assertNotSame(parent[0], window[0].web); assertEquals(popupUrl, window[0].web.getUrl()); });
            clickFixture(scenario, window, false);
            boolean closedPopup = returned.await(10, TimeUnit.SECONDS);
            if (!closedPopup) {
                java.util.concurrent.BlockingQueue<String> diagnostic = new java.util.concurrent.LinkedBlockingQueue<>();
                scenario.onActivity(activity -> window[0].web.evaluateJavascript("JSON.stringify({clicked:document.body.dataset.clicked,opener:!!opener})", diagnostic::offer));
                fail("popup did not close: " + diagnostic.poll(5, TimeUnit.SECONDS));
            }
            CountDownLatch checked = new CountDownLatch(1);
            scenario.onActivity(activity -> {
                assertSame(parent[0], window[0].web); assertEquals("popup-test", window[0].agentRunId); assertFalse(window[0].paused);
                parent[0].evaluateJavascript("document.body.dataset.trusted==='true' && document.body.dataset.connected==='connected'", raw -> { assertEquals("true", raw); checked.countDown(); });
            });
            assertTrue(checked.await(5, TimeUnit.SECONDS));
            scenario.onActivity(activity -> window[0].close());
        }
    }
    private static WebResourceResponse fixtureHtml(String value) { return new WebResourceResponse("text/html", "UTF-8", new ByteArrayInputStream(value.getBytes(StandardCharsets.UTF_8))); }
    private static void clickFixture(ActivityScenario<MainActivity> scenario, AssistantBrowserWindow[] window, boolean checkPause) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        scenario.onActivity(activity -> window[0].web.evaluateJavascript("(()=>{let r=document.querySelector('button').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()", raw -> {
            try {
                JSONObject point = new JSONObject(raw);
                if (checkPause) {
                    window[0].setPaused(true); assertFalse(window[0].clickPublicTarget(point, window[0].documentId, window[0].agentRunId));
                    window[0].setPaused(false); assertFalse(window[0].clickPublicTarget(point, window[0].documentId, "old-run"));
                }
                assertTrue("click state active=" + window[0].active() + " paused=" + window[0].paused + " loading=" + window[0].loading + " failed=" + window[0].failed + " mode=" + window[0].mode + " run=" + window[0].agentRunId + " url=" + window[0].web.getUrl() + " size=" + window[0].web.getWidth() + "x" + window[0].web.getHeight() + " scale=" + window[0].web.getScale() + " point=" + point, window[0].clickPublicTarget(point, window[0].documentId, window[0].agentRunId)); done.countDown();
            } catch (Exception error) { throw new RuntimeException(error); }
        }));
        assertTrue(done.await(5, TimeUnit.SECONDS));
    }
    @Test public void nativeCryptoProviderSealsBotTokenWithoutPlaintextReply() throws Exception {
        java.security.KeyPairGenerator generator = java.security.KeyPairGenerator.getInstance("RSA"); generator.initialize(2048);
        java.security.KeyPair pair = generator.generateKeyPair();
        String key = android.util.Base64.encodeToString(pair.getPublic().getEncoded(), android.util.Base64.NO_WRAP);
        String token = "discord-test-secret-value";
        java.util.Map<String, String> receipt = DiscordSetupSecretTransfer.seal(token, key);
        assertEquals(3, receipt.size()); assertFalse(receipt.toString().contains(token));
        byte[] iv = android.util.Base64.decode(receipt.get("iv"), android.util.Base64.NO_WRAP);
        assertEquals(12, iv.length);
        javax.crypto.Cipher rsa = javax.crypto.Cipher.getInstance("RSA/ECB/OAEPWithSHA-256AndMGF1Padding");
        javax.crypto.spec.OAEPParameterSpec oaep = new javax.crypto.spec.OAEPParameterSpec("SHA-256", "MGF1", java.security.spec.MGF1ParameterSpec.SHA256, javax.crypto.spec.PSource.PSpecified.DEFAULT);
        rsa.init(javax.crypto.Cipher.DECRYPT_MODE, pair.getPrivate(), oaep);
        byte[] aesKey = rsa.doFinal(android.util.Base64.decode(receipt.get("key"), android.util.Base64.NO_WRAP));
        javax.crypto.Cipher aes = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");
        javax.crypto.spec.GCMParameterSpec gcm = new javax.crypto.spec.GCMParameterSpec(128, iv);
        javax.crypto.spec.SecretKeySpec secretKey = new javax.crypto.spec.SecretKeySpec(aesKey, "AES");
        byte[] encrypted = android.util.Base64.decode(receipt.get("data"), android.util.Base64.NO_WRAP);
        aes.init(javax.crypto.Cipher.DECRYPT_MODE, secretKey, gcm);
        aes.updateAAD("srl-discord-bot-transfer-v1".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        assertEquals(token, new String(aes.doFinal(encrypted), java.nio.charset.StandardCharsets.UTF_8));
        aes.init(javax.crypto.Cipher.DECRYPT_MODE, secretKey, gcm);
        aes.updateAAD("wrong-purpose".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        assertThrows(Exception.class, () -> aes.doFinal(encrypted));
        rsa.init(javax.crypto.Cipher.DECRYPT_MODE, generator.generateKeyPair().getPrivate(), oaep);
        assertThrows(Exception.class, () -> rsa.doFinal(android.util.Base64.decode(receipt.get("key"), android.util.Base64.NO_WRAP)));
    }
    private static final String URL = "https://discord.com/developers/applications/1234567890123456789/information";

    @Test public void loginBackAndExternalVerificationResumeUseTheCurrentTaskOnly() throws Exception {
        String login = "https://dash.cloudflare.com/login";
        AssistantBrowserWindow[] window = new AssistantBrowserWindow[1];
        AtomicInteger resumes = new AtomicInteger(), pauses = new AtomicInteger(), loads = new AtomicInteger();
        java.util.concurrent.BlockingQueue<String> loaded = new java.util.concurrent.LinkedBlockingQueue<>();
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> {
                window[0] = new AssistantBrowserWindow(activity, event -> {
                    if ("agent-resume".equals(event.optString("action"))) resumes.incrementAndGet();
                    if ("agent-pause".equals(event.optString("action"))) pauses.incrementAndGet();
                });
                window[0].open(null, "d1-create", "创建 D1 数据库", "本机登录返回夹具", new JSONArray().put(new com.getcapacitor.JSObject().put("id", "d1-create")), "", false, false, false);
                WebViewClient owner = window[0].web.getWebViewClient();
                window[0].web.setWebViewClient(new WebViewClient() {
                    @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                        return new WebResourceResponse("text/html", "UTF-8", new ByteArrayInputStream("<!doctype html><h1>Local verification fixture</h1>".getBytes(StandardCharsets.UTF_8)));
                    }
                    @Override public void onPageStarted(WebView view, String url, Bitmap icon) { owner.onPageStarted(view, url, icon); }
                    @Override public void doUpdateVisitedHistory(WebView view, String url, boolean reload) { owner.doUpdateVisitedHistory(view, url, reload); }
                    @Override public void onPageFinished(WebView view, String url) { owner.onPageFinished(view, url); loads.incrementAndGet(); loaded.offer(url); }
                });
                window[0].agentRun("verification-run");
                window[0].web.loadUrl(login);
            });
            assertEquals(login, loaded.poll(15, TimeUnit.SECONDS));
            scenario.onActivity(activity -> { window[0].background(); window[0].foreground(); });
            onView(withText("尚未完成")).inRoot(isDialog()).perform(click());
            assertEquals("no refresh or model resume without user confirmation", 1, loads.get());
            assertEquals(0, resumes.get());
            scenario.onActivity(activity -> { window[0].background(); window[0].foreground(); });
            onView(withText("已完成，继续")).inRoot(isDialog()).perform(click());
            assertEquals(login, loaded.poll(15, TimeUnit.SECONDS));
            assertEquals(1, resumes.get());
            scenario.onActivity(activity -> {
                window[0].background(); window[0].agentRun(""); window[0].foreground();
                assertEquals("returning to the foreground cannot revive a stopped run", 1, resumes.get());
                window[0].web.loadUrl("https://dash.cloudflare.com/account/d1/create");
            });
            assertEquals("https://dash.cloudflare.com/account/d1/create", loaded.poll(15, TimeUnit.SECONDS));
            scenario.onActivity(activity -> {
                window[0].background(); window[0].foreground();
                assertTrue(window[0].web.canGoBack());
                window[0].agentRun("back-run"); window[0].setPaused(false);
            });
            onView(withContentDescription("返回上一网页")).perform(click());
            assertEquals(login, loaded.poll(15, TimeUnit.SECONDS));
            assertEquals(1, pauses.get());
            scenario.onActivity(activity -> { assertTrue(window[0].paused); assertEquals("", window[0].agentRunId); window[0].web.loadUrl("https://dash.cloudflare.com/account/d1/create"); });
            assertEquals("https://dash.cloudflare.com/account/d1/create", loaded.poll(15, TimeUnit.SECONDS));
            scenario.onActivity(activity -> { window[0].agentRun("system-back-run"); window[0].setPaused(false); });
            androidx.test.espresso.Espresso.pressBack();
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            scenario.onActivity(activity -> {
                assertFalse("system Back exits assistance instead of navigating history", window[0].browserShowing());
                assertFalse(window[0].active());
                assertEquals("https://dash.cloudflare.com/account/d1/create", window[0].web.getUrl());
                assertTrue(window[0].paused); assertEquals("", window[0].agentRunId); window[0].destroy();
            });
        }
    }
    @Test public void compactBrowserFailureAndSensitiveNavigation() throws Exception {
        boolean dark = Boolean.parseBoolean(InstrumentationRegistry.getArguments().getString("dark", "false"));
        String capture = InstrumentationRegistry.getArguments().getString("capture", "discord-ui");
        AssistantBrowserWindow[] window = new AssistantBrowserWindow[1];
        WebViewClient[] client = new WebViewClient[1];
        AtomicInteger pauses = new AtomicInteger(), chats = new AtomicInteger();
        CountDownLatch loaded = new CountDownLatch(1);
        CountDownLatch failureLoaded = new CountDownLatch(1);
        CountDownLatch retried = new CountDownLatch(1);
        AtomicBoolean failNextLoad = new AtomicBoolean();
        CountDownLatch sensitiveLoaded = new CountDownLatch(1), publicCommitted = new CountDownLatch(1);
        AtomicBoolean returningToPublic = new AtomicBoolean();
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> {
                try {
                    window[0] = new AssistantBrowserWindow(activity, event -> {
                        if ("agent-pause".equals(event.optString("action"))) pauses.incrementAndGet();
                        if ("quick-chat".equals(event.optString("action"))) chats.incrementAndGet();
                    });
                    JSONArray steps = new JSONArray().put(new JSONObject().put("id", "discord-app").put("title", "找到 Discord 三个配置值"));
                    window[0].open(null, "discord-app", "找到 Discord 配置值", "打开自己的 App → General Information。Application ID 与 Public Key 可保存在本机；Bot Token 去 Bot 页由你保存，不读取。", steps, "", false, dark, false);
                    File petFile = new File(activity.getExternalFilesDir(null), "test-pet.png");
                    if (petFile.exists()) {
                        Bitmap original = android.graphics.BitmapFactory.decodeFile(petFile.getAbsolutePath());
                        Bitmap frame = Bitmap.createScaledBitmap(original, 176, 176, true);
                        java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream(); frame.compress(Bitmap.CompressFormat.PNG, 100, bytes);
                        window[0].petFrame("data:image/png;base64," + android.util.Base64.encodeToString(bytes.toByteArray(), android.util.Base64.NO_WRAP));
                        if (frame != original) frame.recycle(); original.recycle();
                    }
                    client[0] = window[0].web.getWebViewClient();
                    window[0].web.setWebViewClient(new WebViewClient() {
                        @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                            String html = "<!doctype html><meta name='viewport' content='width=device-width'><body style='margin:0;background:" + (dark ? "#1e1f22;color:#f2f3f5" : "#fff;color:#313338") + ";font:16px sans-serif;padding:24px'><small>本机测试页面 · 不连接 Discord</small><h2>General Information</h2><p>Application ID</p><input value='1234567890123456789' style='box-sizing:border-box;width:100%;padding:12px'><p>Public Key</p><input placeholder='示例字段' style='box-sizing:border-box;width:100%;padding:12px'><p>配置填好后，点击蒜惹菈继续。</p>";
                            ByteArrayInputStream body = new ByteArrayInputStream(html.getBytes(StandardCharsets.UTF_8));
                            if (request.isForMainFrame() && failNextLoad.getAndSet(false)) return new WebResourceResponse("text/html", "UTF-8", 503, "Service Unavailable", java.util.Collections.emptyMap(), body);
                            return new WebResourceResponse("text/html", "UTF-8", body);
                        }
                        @Override public void onPageStarted(WebView view, String url, Bitmap icon) { client[0].onPageStarted(view, url, icon); }
                        @Override public void onPageCommitVisible(WebView view, String url) { client[0].onPageCommitVisible(view, url); if (returningToPublic.get() && URL.equals(url)) publicCommitted.countDown(); }
                        @Override public void doUpdateVisitedHistory(WebView view, String url, boolean reload) { client[0].doUpdateVisitedHistory(view, url, reload); }
                        @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) { client[0].onReceivedHttpError(view, request, response); }
                        @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) { client[0].onReceivedError(view, request, error); }
                        @Override public void onPageFinished(WebView view, String url) {
                            client[0].onPageFinished(view, url);
                            if ("https://discord.com/login".equals(url)) sensitiveLoaded.countDown();
                            if (window[0].failed) failureLoaded.countDown(); else if (loaded.getCount() == 0) retried.countDown(); else loaded.countDown();
                        }
                    });
                    window[0].web.loadUrl(URL);
                } catch (Exception error) { throw new RuntimeException(error); }
            });
            assertTrue("local WebView fixture loaded", loaded.await(15, TimeUnit.SECONDS));
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            scenario.onActivity(activity -> window[0].setPaused(false));
            scenario.onActivity(activity -> {
                assertFalse(window[0].paused);
                assertTrue("browser keeps the working area", window[0].web.getHeight() > activity.getResources().getDisplayMetrics().heightPixels * .65);
                try { assertEquals(0, activity.getWindow().getAttributes().flags & WindowManager.LayoutParams.FLAG_SECURE); } catch (Exception error) { throw new RuntimeException(error); }
            });
            screenshot(capture + "-page");
            CountDownLatch inputComplete = new CountDownLatch(1), inputHooked = new CountDownLatch(1);
            scenario.onActivity(activity -> {
                android.webkit.WebChromeClient owner = window[0].web.getWebChromeClient();
                window[0].web.setWebChromeClient(new android.webkit.WebChromeClient() {
                    @Override public boolean onConsoleMessage(android.webkit.ConsoleMessage message) {
                        if ("test-input-complete".equals(message.message())) { inputComplete.countDown(); return true; }
                        return owner.onConsoleMessage(message);
                    }
                });
                window[0].web.evaluateJavascript("document.addEventListener('input',e=>{if(e.target.value==='test-public')console.log('test-input-complete')})", ignored -> inputHooked.countDown());
            });
            assertTrue(inputHooked.await(5, TimeUnit.SECONDS));
            tapField(window[0].web);
            InstrumentationRegistry.getInstrumentation().sendStringSync("test-public");
            assertTrue("all input events reached the page", inputComplete.await(5, TimeUnit.SECONDS));
            CountDownLatch typed = new CountDownLatch(1);
            scenario.onActivity(activity -> window[0].web.evaluateJavascript("document.activeElement.value", value -> { assertEquals("\"test-public\"", value); typed.countDown(); }));
            assertTrue("web input keeps the typed text", typed.await(5, TimeUnit.SECONDS));
            screenshot(capture + "-browser-keyboard");
            onView(withContentDescription("蒜惹菈，点击对话，拖动移动")).check(matches(isCompletelyDisplayed()));
            closeSoftKeyboard();
            onView(withText("1/1  ·  找到 Discord 配置值  ›")).perform(click());
            onView(withText("知道了")).inRoot(isDialog()).check((view, error) -> {
                if (error != null) throw error;
                int[] location = new int[2]; view.getRootView().getLocationOnScreen(location);
                android.graphics.Rect popup = new android.graphics.Rect(location[0], location[1], location[0] + view.getRootView().getWidth(), location[1] + view.getRootView().getHeight());
                android.graphics.Rect screen = ((WindowManager) view.getContext().getSystemService(android.content.Context.WINDOW_SERVICE)).getCurrentWindowMetrics().getBounds();
                int tolerance = Math.round(24 * view.getResources().getDisplayMetrics().density);
                assertTrue("dialog centered horizontally: " + popup + " / " + screen, Math.abs(popup.centerX() - screen.centerX()) <= tolerance);
                assertTrue("dialog centered vertically: " + popup + " / " + screen, Math.abs(popup.centerY() - screen.centerY()) <= tolerance);
            });
            screenshot(capture + "-details");
            onView(withText("知道了")).inRoot(isDialog()).perform(click());
            scenario.onActivity(activity -> { window[0].agentRun("test-agent-run"); window[0].setPaused(false); window[0].phase("正在查找 App 配置"); window[0].message("已找到本次 App，正在保存公开参数。\n\nApp ID 和公钥仅保存在本机部署资料卡，工具不会把原值发给模型。下一步会进入同一 App 的 Bot 页面，请完成网站验证并显示 Token。\n\n你可以单独确认加密保存当前 Token，也可自行保存并明确继续。完成之前不会进入 Cloudflare。\n\n之后助手会创建 D1、保存 UUID、Fork 指定仓库并填写 Wrangler。Worker 根网址保存到资源库，Discord 交互地址使用根网址加 /interactions。\n\n你只需接手登录、验证码、授权和密钥显示/填写；遇到多个无法确定的 App 会请你选择。操作结果会经过本机核验，点击并不代表部署完成。\n\n点击桌宠查看回复不会打断工作。需要自己操作时选择暂停。"); });
            onView(withText(org.hamcrest.Matchers.startsWith("小助手操作中"))).check(matches(isCompletelyDisplayed()));
            screenshot(capture + "-working");
            tapField(window[0].web);
            scenario.onActivity(activity -> assertFalse("working page ignores user touch and hides webpage keyboard", window[0].web.hasFocus()));
            onView(withContentDescription("蒜惹菈，点击对话，拖动移动")).perform(click());
            scenario.onActivity(activity -> { assertFalse("viewing pet keeps the agent running", window[0].paused); assertEquals("test-agent-run", window[0].agentRunId); });
            assertEquals("agent opens the shared chat, not a second native chat", 1, chats.get());
            scenario.onActivity(activity -> window[0].mode = "economy");
            onView(withContentDescription("蒜惹菈，点击对话，拖动移动")).perform(click());
            onView(isAssignableFrom(android.widget.EditText.class)).inRoot(isDialog()).perform(click(), typeTextIntoFocusedView("Help me"));
            onView(withText("Help me")).inRoot(isDialog()).check(matches(isCompletelyDisplayed()));
            onView(withText("发送 / 继续")).inRoot(isDialog()).check(matches(isCompletelyDisplayed()));
            onView(withText("暂停")).inRoot(isDialog()).check(matches(isCompletelyDisplayed()));
            screenshot(capture + "-keyboard"); closeSoftKeyboard();
            onView(withText("返回网页")).inRoot(isDialog()).perform(click());
            assertEquals(0, pauses.get());
            onView(withContentDescription("蒜惹菈，点击对话，拖动移动")).perform(click());
            onView(withText("暂停")).inRoot(isDialog()).perform(click());
            scenario.onActivity(activity -> { assertTrue(window[0].paused); assertEquals("", window[0].agentRunId); });
            assertEquals(1, pauses.get());
            failNextLoad.set(true);
            scenario.onActivity(activity -> window[0].web.loadUrl(URL + "?fixture=failure"));
            assertTrue("main-frame HTTP failure is shown", failureLoaded.await(15, TimeUnit.SECONDS));
            screenshot(capture + "-failure");
            assertEquals(1, pauses.get());
            scenario.onActivity(activity -> {
                assertTrue(window[0].failed); assertTrue(window[0].paused);
                assertTrue("page finish must not clear the failure", window[0].failed);
            });
            onView(withText("重试")).perform(click());
            assertTrue("manual retry loads fixture", retried.await(15, TimeUnit.SECONDS));
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            scenario.onActivity(activity -> { assertFalse(window[0].failed); assertTrue(window[0].paused); });
            scenario.onActivity(activity -> window[0].web.loadUrl("https://discord.com/login"));
            assertTrue("sensitive page loads", sensitiveLoaded.await(15, TimeUnit.SECONDS));
            scenario.onActivity(activity -> {
                try {
                    assertEquals("manual screenshots remain allowed on login pages", 0, activity.getWindow().getAttributes().flags & WindowManager.LayoutParams.FLAG_SECURE);
                    returningToPublic.set(true);
                    window[0].open(URL, "discord-app", "找到 Discord 配置值", "打开自己的 App → General Information。", window[0].steps, "", false, dark, false);
                    assertEquals("navigation does not force screenshot protection", 0, activity.getWindow().getAttributes().flags & WindowManager.LayoutParams.FLAG_SECURE);
                } catch (Exception error) { throw new RuntimeException(error); }
            });
            assertTrue("public replacement is visible", publicCommitted.await(15, TimeUnit.SECONDS));
            scenario.onActivity(activity -> { try { assertEquals(0, activity.getWindow().getAttributes().flags & WindowManager.LayoutParams.FLAG_SECURE); } catch (Exception error) { throw new RuntimeException(error); } });
            scenario.onActivity(activity -> window[0].destroy());
        }
    }
    private void screenshot(String name) throws Exception {
        InstrumentationRegistry.getInstrumentation().waitForIdleSync();
        CountDownLatch rendered = new CountDownLatch(1);
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> android.view.Choreographer.getInstance().postFrameCallback(time -> android.view.Choreographer.getInstance().postFrameCallback(next -> rendered.countDown())));
        assertTrue("current UI rendered before screenshot", rendered.await(5, TimeUnit.SECONDS));
        Bitmap bitmap = InstrumentationRegistry.getInstrumentation().getUiAutomation().takeScreenshot(); assertNotNull(bitmap);
        File file = new File(InstrumentationRegistry.getInstrumentation().getTargetContext().getExternalFilesDir(null), name + ".png");
        try (FileOutputStream output = new FileOutputStream(file)) { bitmap.compress(Bitmap.CompressFormat.PNG, 100, output); }
        bitmap.recycle();
    }
    private void tapField(WebView web) throws Exception {
        android.app.UiAutomation automation = InstrumentationRegistry.getInstrumentation().getUiAutomation();
        CountDownLatch located = new CountDownLatch(1); float[] point = new float[2];
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> web.evaluateJavascript("(() => { const r = document.querySelector('input[placeholder]').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,width:innerWidth}; })()", value -> {
            try {
                JSONObject rect = new JSONObject(value); int[] origin = new int[2]; web.getLocationOnScreen(origin);
                float scale = web.getWidth() / (float) rect.getDouble("width");
                point[0] = origin[0] + (float) rect.getDouble("x") * scale; point[1] = origin[1] + (float) rect.getDouble("y") * scale; located.countDown();
            } catch (Exception error) { throw new RuntimeException(error); }
        }));
        assertTrue("local fixture field is located", located.await(5, TimeUnit.SECONDS));
        long now = android.os.SystemClock.uptimeMillis();
        android.view.MotionEvent down = android.view.MotionEvent.obtain(now, now, android.view.MotionEvent.ACTION_DOWN, point[0], point[1], 0);
        android.view.MotionEvent up = android.view.MotionEvent.obtain(now, now + 80, android.view.MotionEvent.ACTION_UP, point[0], point[1], 0);
        down.setSource(android.view.InputDevice.SOURCE_TOUCHSCREEN); up.setSource(android.view.InputDevice.SOURCE_TOUCHSCREEN);
        assertTrue(automation.injectInputEvent(down, true)); assertTrue(automation.injectInputEvent(up, true)); down.recycle(); up.recycle();
        automation.waitForIdle(300, 5000);
    }
}
