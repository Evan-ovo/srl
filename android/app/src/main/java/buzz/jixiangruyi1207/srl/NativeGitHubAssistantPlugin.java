package buzz.jixiangruyi1207.srl;

import android.app.AlertDialog;
import android.content.Intent;
import android.net.Uri;
import android.os.SystemClock;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import okhttp3.*;
import org.json.JSONArray;
import org.json.JSONObject;

/** Device authorization and GitHub requests; neither token nor device code crosses the bridge. */
@CapacitorPlugin(name = "NativeGitHubAssistant")
public class NativeGitHubAssistantPlugin extends Plugin {
    private static final String KEY = "assistant-github-oauth-v1";
    private final java.util.concurrent.ExecutorService io = Executors.newSingleThreadExecutor();
    private final OkHttpClient http = new OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).build();
    private final Map<String, Work> active = new ConcurrentHashMap<>();
    private NativeSecretStore secrets;
    private static final class Work {
        volatile boolean cancelled;
        volatile Call request;
        volatile AlertDialog dialog;
        synchronized void cancel() { cancelled = true; if (request != null) request.cancel(); notifyAll(); }
        synchronized void check() { if (cancelled) throw new IllegalStateException("GitHub 操作已取消，任务和网页已保留"); }
        synchronized void waitFor(long millis) throws InterruptedException {
            long deadline = SystemClock.elapsedRealtime() + millis;
            while (SystemClock.elapsedRealtime() < deadline) { check(); long remaining = deadline - SystemClock.elapsedRealtime(); if (remaining <= 0) break; wait(remaining); }
            check();
        }
    }
    @Override public void load() { secrets = new NativeSecretStore(getContext()); }
    @PluginMethod public void status(PluginCall call) {
        call.resolve(new JSObject().put("connected", secrets.has(KEY)));
    }
    @PluginMethod public void cancel(PluginCall call) {
        Work work = active.get(call.getString("requestId", ""));
        if (work != null) { work.cancel(); dismiss(work); }
        call.resolve();
    }
    @PluginMethod public void disconnect(PluginCall call) {
        for (Work work : active.values()) { work.cancel(); dismiss(work); }
        secrets.clear(KEY); call.resolve();
    }
    private void dismiss(Work work) {
        getActivity().runOnUiThread(() -> { if (work.dialog != null) { work.dialog.dismiss(); work.dialog = null; } });
    }
    private interface Operation { JSObject run(Work work) throws Exception; }
    private void perform(PluginCall call, Operation operation) {
        String id = call.getString("requestId", "");
        if (!id.matches("[a-zA-Z0-9-]{1,60}")) { call.reject("GitHub 操作身份无效"); return; }
        Work work = new Work();
        if (active.putIfAbsent(id, work) != null) { call.reject("同一 GitHub 操作正在执行"); return; }
        io.execute(() -> {
            try { work.check(); JSObject result = operation.run(work); work.check(); call.resolve(result); }
            catch (Exception error) { call.reject(error instanceof IllegalStateException ? error.getMessage() : "GitHub 请求失败，任务已保留；请检查网络或授权后再试"); }
            finally { active.remove(id, work); dismiss(work); }
        });
    }
    private Object request(Work work, String url, String method, String token, JSONObject body) throws Exception {
        work.check();
        Request.Builder builder = new Request.Builder().url(url).header("Accept", "application/json")
            .header("User-Agent", "SRL-GitHub-Assistant");
        if (token != null) builder.header("Authorization", "Bearer " + token).header("X-GitHub-Api-Version", "2022-11-28");
        if (!"GET".equals(method)) builder.method(method, RequestBody.create(body.toString(), MediaType.get("application/json; charset=utf-8")));
        Call request = http.newCall(builder.build()); work.request = request;
        try (Response response = request.execute()) {
            work.check();
            if (response.code() == 404) return null;
            if (!response.isSuccessful()) {
                if (response.code() == 401) throw new IllegalStateException("GitHub 授权已失效，请重新连接");
                if (response.code() == 409 || response.code() == 422) throw new IllegalStateException("GitHub 分支或文件发生冲突；未强制覆盖，请核对当前版本");
                if (response.code() == 403 || response.code() == 429) throw new IllegalStateException("GitHub 拒绝本次操作或请求已限流，请检查授权和网站提示；未自动重试");
                throw new IllegalStateException("GitHub 返回 HTTP " + response.code() + "，本次结果尚未确认");
            }
            String text = response.body() == null ? "{}" : response.body().string();
            return text.trim().startsWith("[") ? new JSONArray(text) : new JSONObject(text);
        } finally { work.request = null; }
    }
    private JSONObject object(Object value) {
        if (!(value instanceof JSONObject)) throw new IllegalStateException("GitHub 目标不存在或响应无效，请检查当前仓库");
        return (JSONObject) value;
    }
    private JSONObject oauth(Work work, String path, JSONObject data) throws Exception {
        return object(request(work, "https://github.com" + path, "POST", null, data));
    }
    private JSONObject api(Work work, String token, String path, String method, JSONObject body) throws Exception {
        return object(request(work, "https://api.github.com" + path, method, token, body));
    }
    private JSONObject validateToken(Work work, JSONObject credential) throws Exception {
        String token = credential.optString("access_token");
        java.util.List<String> scopes = java.util.Arrays.asList(credential.optString("scope").split("[ ,]+"));
        if (token.isEmpty() || !(scopes.contains("public_repo") || scopes.contains("repo")))
            throw new IllegalStateException("GitHub 仓库授权未完整授予，请重新连接");
        JSONObject user = api(work, token, "/user", "GET", null);
        String login = user.optString("login");
        if (!login.matches("[A-Za-z0-9-]{1,39}")) throw new IllegalStateException("GitHub 登录身份无效");
        credential.put("login", login);
        int expiry = credential.optInt("expires_in");
        if (expiry > 0) credential.put("expires_at", System.currentTimeMillis() + expiry * 1000L);
        synchronized (work) { work.check(); secrets.save(KEY, credential.toString()); }
        return credential;
    }
    private JSONObject credential(Work work) throws Exception {
        String stored = secrets.read(KEY);
        if (stored == null) throw new IllegalStateException("请先连接 GitHub；系统浏览器登录不会自动共享网页 Cookie");
        JSONObject result = new JSONObject(stored);
        if (result.optLong("expires_at", Long.MAX_VALUE) <= System.currentTimeMillis()) {
            JSONObject refreshed = oauth(work, "/login/oauth/access_token", new JSONObject()
                .put("client_id", GitHubAssistantPolicy.CLIENT_ID).put("grant_type", "refresh_token").put("refresh_token", result.optString("refresh_token")));
            if (refreshed.has("error")) throw new IllegalStateException(GitHubAssistantPolicy.authError(refreshed.optString("error")));
            if (!refreshed.has("scope")) refreshed.put("scope", result.optString("scope"));
            result = validateToken(work, refreshed);
        }
        return result;
    }
    @PluginMethod public void authorize(PluginCall call) {
        perform(call, work -> {
            JSONObject start = oauth(work, "/login/device/code", new JSONObject().put("client_id", GitHubAssistantPolicy.CLIENT_ID).put("scope", "public_repo"));
            if (start.has("error")) throw new IllegalStateException(GitHubAssistantPolicy.authError(start.optString("error")));
            String code = start.optString("device_code"), userCode = start.optString("user_code");
            if (!code.matches("[A-Za-z0-9_-]{20,100}") || !userCode.matches("[A-Z0-9]{4}-[A-Z0-9]{4}") || !"https://github.com/login/device".equals(start.optString("verification_uri")))
                throw new IllegalStateException("GitHub 授权信息无效，未打开登录页");
            long expiry = SystemClock.elapsedRealtime() + start.getInt("expires_in") * 1000L;
            int interval = Math.max(1, start.getInt("interval"));
            getActivity().runOnUiThread(() -> {
                if (work.cancelled) return;
                work.dialog = new AlertDialog.Builder(getActivity()).setTitle("连接 GitHub")
                    .setMessage("授权码：" + userCode + "\n\n在系统浏览器用 Google、Apple 或原账号登录，并输入上方授权码。\n\nGitHub 将授予公开仓库访问；蒜惹菈只为本次 Bridge 任务操作已确认的部署仓库（你的 Fork 或当前账号拥有的源仓库）。令牌在本机加密保存，不发送给模型；可在 GitHub 随时撤销。返回资源库后会核验授权结果。")
                    .setPositiveButton("打开登录授权", null).setNegativeButton("取消连接", (d, which) -> work.cancel())
                    .setOnCancelListener(d -> work.cancel()).create();
                work.dialog.setOnShowListener(d -> work.dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
                    try { getActivity().startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("https://github.com/login/device"))); }
                    catch (android.content.ActivityNotFoundException error) { work.cancel(); }
                }));
                work.dialog.show();
            });
            while (SystemClock.elapsedRealtime() < expiry) {
                work.waitFor(Math.min(interval * 1000L, expiry - SystemClock.elapsedRealtime()));
                if (SystemClock.elapsedRealtime() >= expiry) break;
                JSONObject result = oauth(work, "/login/oauth/access_token", new JSONObject()
                    .put("client_id", GitHubAssistantPolicy.CLIENT_ID).put("device_code", code).put("grant_type", "urn:ietf:params:oauth:grant-type:device_code"));
                if (result.has("access_token")) {
                    JSONObject saved = validateToken(work, result);
                    return new JSObject().put("connected", true).put("login", saved.getString("login"));
                }
                interval = GitHubAssistantPolicy.pollInterval(result.optString("error"), interval, result.optInt("interval"));
                if (interval < 0) throw new IllegalStateException(GitHubAssistantPolicy.authError(result.optString("error")));
            }
            throw new IllegalStateException("GitHub 授权码已过期，请重新连接");
        });
    }
    private JSONObject checkedRepo(Work work, String token, String name, String login) throws Exception {
        if (!GitHubAssistantPolicy.repository(name, login)) throw new IllegalStateException("当前仓库不属于授权账号，未写入；请核对连接账号和自己的 Fork");
        Object raw = request(work, "https://api.github.com/repos/" + name, "GET", token, null);
        if (raw == null) return null;
        JSONObject repo = object(raw), source = repo.optJSONObject("source"), parent = repo.optJSONObject("parent");
        boolean ownedSource = GitHubAssistantPolicy.UPSTREAM.equalsIgnoreCase(name);
        if (repo.optBoolean("private") || !(ownedSource || repo.optBoolean("fork") && (source != null && GitHubAssistantPolicy.UPSTREAM.equalsIgnoreCase(source.optString("full_name")) || parent != null && GitHubAssistantPolicy.UPSTREAM.equalsIgnoreCase(parent.optString("full_name")))))
            return null;
        if (!name.equalsIgnoreCase(repo.optString("full_name"))) throw new IllegalStateException("GitHub 仓库已迁移，请重新确认目标");
        return repo;
    }
    private String findRepo(Work work, String token, String login, String requested) throws Exception {
        if (!requested.isEmpty()) {
            if (checkedRepo(work, token, requested, login) == null) throw new IllegalStateException("原 Fork 未找到或不属于指定 Bridge，请先检查目标；未创建重复仓库");
            return requested;
        }
        String conventional = login + "/SRL-Discord-Bridge";
        java.util.List<String> found = new java.util.ArrayList<>();
        if (checkedRepo(work, token, conventional, login) != null) {
            if (GitHubAssistantPolicy.UPSTREAM.equalsIgnoreCase(conventional)) return conventional;
            found.add(conventional);
        }
        for (int page = 1; ; page++) {
            JSONArray repos = (JSONArray) request(work, "https://api.github.com/users/" + login + "/repos?type=owner&per_page=100&page=" + page, "GET", token, null);
            for (int i = 0; i < repos.length(); i++) {
                JSONObject candidate = repos.getJSONObject(i);
                String name = candidate.optString("full_name");
                if (candidate.optBoolean("fork") && !name.equalsIgnoreCase(conventional) && checkedRepo(work, token, name, login) != null) {
                    found.add(name);
                    if (found.size() > 1) throw new IllegalStateException("发现多个 Bridge 仓库：" + String.join("、", found) + "。先核对 Worker 实际来源或询问用户，再用 github-inspect/repository 指定目标；未猜测或创建仓库");
                }
            }
            if (repos.length() < 100) return found.isEmpty() ? "" : found.get(0);
        }
    }
    private JSObject file(Work work, String token, String name, String branch, String path) throws Exception {
        String revision = api(work, token, "/repos/" + name + "/commits/" + java.net.URLEncoder.encode(branch, "UTF-8"), "GET", null).getString("sha");
        if (!GitHubAssistantPolicy.sha(revision)) throw new IllegalStateException("GitHub 分支身份无效");
        String actualPath = path.isEmpty() ? "wrangler.jsonc" : path;
        Object raw = request(work, "https://api.github.com/repos/" + name + "/contents/" + actualPath + "?ref=" + revision, "GET", token, null);
        if (raw == null && path.isEmpty()) {
            actualPath = "wrangler.json";
            raw = request(work, "https://api.github.com/repos/" + name + "/contents/" + actualPath + "?ref=" + revision, "GET", token, null);
        }
        JSObject result = new JSObject().put("repository", name).put("branch", branch).put("file", actualPath)
            .put("repositoryKind", GitHubAssistantPolicy.UPSTREAM.equalsIgnoreCase(name) ? "owned-source" : "fork").put("revision", revision);
        if (raw == null) return result.put("configurationAvailable", false);
        JSONObject content = object(raw);
        if (!"file".equals(content.optString("type")) || !"base64".equals(content.optString("encoding"))) throw new IllegalStateException("目标分支配置无法完整读取；仓库已保留，不重复Fork");
        String source = new String(Base64.decode(content.getString("content"), Base64.DEFAULT), StandardCharsets.UTF_8);
        return result.put("source", source).put("sha", content.getString("sha")).put("configurationAvailable", true);
    }
    @PluginMethod public void execute(PluginCall call) {
        perform(call, work -> {
            JSONObject credentials = credential(work);
            String token = credentials.getString("access_token"), login = credentials.getString("login");
            String operation = call.getString("operation", ""), requested = call.getString("repository", "");
            if (!operation.matches("inspect|fork|sync|read|save")) throw new IllegalStateException("GitHub 操作无效");
            String name = findRepo(work, token, login, requested);
            if (name.isEmpty() && "fork".equals(operation)) {
                JSONObject created = api(work, token, "/repos/" + GitHubAssistantPolicy.UPSTREAM + "/forks", "POST", new JSONObject().put("default_branch_only", true));
                name = created.getString("full_name");
                if (checkedRepo(work, token, name, login) == null) throw new IllegalStateException("Fork 已请求创建，尚未确认就绪，请稍后检查，不重复创建");
            }
            if (name.isEmpty()) return new JSObject().put("connected", true).put("login", login).put("forkFound", false);
            JSONObject repository = checkedRepo(work, token, name, login);
            if (repository == null) throw new IllegalStateException("目标仓库已变化，未继续写入");
            String branch = call.getString("branch", repository.optString("default_branch", "main"));
            String path = call.getString("file", "");
            if (!GitHubAssistantPolicy.branch(branch) || !path.isEmpty() && !path.matches("wrangler\\.jsonc?")) throw new IllegalStateException("目标分支或配置文件无效，未执行");
            boolean ownedSource = GitHubAssistantPolicy.UPSTREAM.equalsIgnoreCase(name);
            if ("save".equals(operation)) {
                String source = call.getString("content", ""), sha = call.getString("sha", "");
                if (!GitHubAssistantPolicy.sha(sha) || source.length() > 100000 || source.contains("DISCORD_BOT_TOKEN") || source.contains("gho_") || source.contains("ghp_")) throw new IllegalStateException("配置或文件身份无效，未提交秘密或覆盖其它文件");
                new JSONObject(source);
                JSObject previous = file(work, token, name, branch, path);
                if (!sha.equals(previous.getString("sha"))) throw new IllegalStateException("Wrangler 已被其它修改更新，未覆盖；请重新检查当前内容");
                if (!source.equals(previous.getString("source"))) api(work, token, "/repos/" + name + "/contents/" + previous.getString("file"), "PUT", new JSONObject()
                    .put("message", "Configure Discord Bridge with SRL").put("branch", branch).put("sha", sha)
                    .put("content", Base64.encodeToString(source.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP)));
                JSObject saved = file(work, token, name, branch, path);
                if (!source.equals(saved.getString("source"))) throw new IllegalStateException("提交后配置读回不同，未标记保存成功");
                return saved.put("saved", true).put("connected", true).put("login", login).put("forkFound", true);
            }
            if ("sync".equals(operation) && !ownedSource) {
                JSObject previous = file(work, token, name, branch, path);
                api(work, token, "/repos/" + name + "/merge-upstream", "POST", new JSONObject().put("branch", branch));
                JSObject after = file(work, token, name, branch, path);
                if (!java.util.Objects.equals(previous.getString("source"), after.getString("source"))) throw new IllegalStateException("上游同步已改变 Wrangler 内容，请核对参数；未自动覆盖或继续部署");
            }
            JSObject result = file(work, token, name, branch, path);
            if (ownedSource) return result.put("connected", true).put("login", login).put("forkFound", true).put("behindBy", 0).put("syncNotApplicable", true);
            String upstreamBranch = api(work, token, "/repos/" + GitHubAssistantPolicy.UPSTREAM, "GET", null).optString("default_branch", "main");
            JSONObject comparison = api(work, token, "/repos/" + name + "/compare/jixiangruyi117:" + java.net.URLEncoder.encode(upstreamBranch, "UTF-8") + "..." + java.net.URLEncoder.encode(branch, "UTF-8"), "GET", null);
            return result.put("connected", true).put("login", login).put("forkFound", true).put("behindBy", comparison.getInt("behind_by"));
        });
    }
    @Override protected void handleOnDestroy() {
        for (Work work : active.values()) { work.cancel(); dismiss(work); }
        io.shutdownNow(); super.handleOnDestroy();
    }
}
