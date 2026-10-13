package buzz.jixiangruyi1207.srl;

import java.net.URI;
import java.util.Set;

/** Shared public-web policy and Discord-specific task policy; external pages receive no host bridge. */
final class AssistantBrowserPolicy {
    static String maskSecrets(String text) {
        return text.replaceAll("(?i)([?&](?:code|token|access_token|refresh_token|id_token|password|secret|client_secret|api_key)=)[^&#\\s]+", "$1[已遮蔽]")
            .replaceAll("[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{20,}|(?:sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{20,}", "[已遮蔽]");
    }
    private static final Set<String> HOSTS = new java.util.HashSet<>(java.util.Arrays.asList("github.com", "dash.cloudflare.com", "discord.com"));
    static boolean browseAllowed(String value) {
        try {
            URI uri = URI.create(value);
            String host = uri.getHost();
            return "https".equals(uri.getScheme()) && host != null && host.contains(".")
                && !host.matches("[0-9.]+") && !host.contains(":") && !host.startsWith("[")
                && !host.matches("(?i).*(?:\\.localhost|\\.local|\\.internal|\\.intranet|\\.home|\\.home\\.arpa|\\.test|\\.invalid|\\.example)$")
                && uri.getRawUserInfo() == null && (uri.getPort() == -1 || uri.getPort() == 443);
        } catch (RuntimeException error) { return false; }
    }
    static boolean generalNavigationAllowed(String current, String destination) {
        return browseAllowed(current) && browseAllowed(destination);
    }
    static boolean generalAgentNavigationAllowed(String run, boolean paused, boolean loading, boolean failed, String current, String destination) {
        return run != null && !run.isEmpty() && !loading && generalNavigationAllowed(current, destination)
            && (failed ? !URI.create(current).equals(URI.create(destination)) : !paused);
    }
    static boolean generalUserOnly(String value) {
        if (!browseAllowed(value) || authentication(value)) return true;
        try {
            URI uri = URI.create(value);
            return uri.getPath().matches("(?i).*/(?:account/(?:security|credentials)|(?:api[-_]?keys?|tokens|credentials|secrets|billing|payment-methods?))(?:/.*)?");
        } catch (RuntimeException error) { return true; }
    }
    static String generalPageAccess(String value) {
        return !browseAllowed(value) ? "external" : authentication(value) ? "authentication" : generalUserOnly(value) ? "protected" : "public";
    }
    static String generalPublicUrl(String value) {
        try { URI uri = URI.create(value); return new URI("https", null, uri.getHost(), -1, uri.getPath(), null, null).toString(); }
        catch (Exception error) { return ""; }
    }
    static boolean allowed(String value) {
        try {
            URI uri = URI.create(value);
            String host = uri.getHost();
            return "https".equals(uri.getScheme()) && host != null
                && (HOSTS.contains(host) || host.endsWith(".workers.dev"))
                && uri.getRawUserInfo() == null && (uri.getPort() == -1 || uri.getPort() == 443);
        } catch (RuntimeException error) { return false; }
    }
    static boolean authentication(String value) {
        try {
            return !repositoryAuthorization(value) && !connectionConsent(value) && URI.create(value).getPath().matches("(?i).*/(login|signin|sign-in|sessions|oauth|authorize|register)(/.*)?");
        } catch (RuntimeException error) { return true; }
    }
    static boolean connectionConsent(String value) {
        try { URI uri = URI.create(value); return allowed(value) && "github.com".equals(uri.getHost()) && uri.getPath().matches("/login/oauth/authorize/?"); }
        catch (RuntimeException error) { return false; }
    }
    static boolean repositoryAuthorization(String value) {
        try {
            URI uri = URI.create(value);
            return allowed(value) && "github.com".equals(uri.getHost()) && uri.getPath().matches("/(apps/[^/]+/installations|settings/installations|organizations/[^/]+/settings/installations)(/.*)?");
        } catch (RuntimeException error) { return false; }
    }
    static boolean navigationAllowed(String current, String destination) {
        try { return allowed(current) && allowed(destination); }
        catch (RuntimeException error) { return false; }
    }
    static boolean agentNavigationAllowed(String mode, String run, boolean paused, boolean loading, boolean failed, String step, String current, String destination) {
        return "agent".equals(mode) && run != null && !run.isEmpty() && !loading
            && navigationAllowed(current, destination) && !userOnly(step, current)
            && (failed ? !URI.create(current).equals(URI.create(destination)) : !paused);
    }
    static String openingUrl(String requested, String current, boolean resumeCurrent, boolean sameStep, String root) {
        // Hiding/closing the window does not discard its WebView or partially completed forms.
        if (resumeCurrent && sameStep && browseAllowed(current)) return null;
        if (requested == null) {
            try { if (browseAllowed(current) && URI.create(root).getHost().equals(URI.create(current).getHost())) return null; }
            catch (RuntimeException error) { /* A missing or invalid previous page opens the site's root. */ }
            return root;
        }
        return requested;
    }
    static boolean botSecretLocation(String url, String applicationId) {
        return applicationId != null && applicationId.matches("[0-9]{17,20}")
            && ("https://discord.com/developers/applications/" + applicationId + "/bot").equals(url);
    }
    static boolean blocksUserInput(String mode, String run, boolean paused, boolean loading, boolean failed, String step, String url) {
        return "agent".equals(mode) && run != null && !run.isEmpty() && !failed
            && !userOnly(step, url) && (loading || !paused);
    }
    static boolean statusWaitAllowed(String mode, String run, boolean paused, boolean loading, boolean failed, String step, String url) {
        return !loading && blocksUserInput(mode, run, paused, loading, failed, step, url);
    }
    static boolean installLink(String value, String applicationId) {
        if (applicationId == null || !applicationId.matches("[0-9]{17,20}") || !allowed(value)) return false;
        try {
            URI uri = URI.create(value);
            if (!"discord.com".equals(uri.getHost()) || !("/oauth2/authorize".equals(uri.getPath()) || "/api/oauth2/authorize".equals(uri.getPath())) || uri.getRawFragment() != null || uri.getRawQuery() == null) return false;
            java.util.Map<String, String> query = new java.util.HashMap<>();
            Set<String> keys = new java.util.HashSet<>(java.util.Arrays.asList("client_id", "scope", "permissions", "integration_type", "guild_id", "disable_guild_select"));
            for (String pair : uri.getRawQuery().split("&")) {
                String[] parts = pair.split("=", 2);
                String key = java.net.URLDecoder.decode(parts[0], "UTF-8");
                String content = parts.length == 2 ? java.net.URLDecoder.decode(parts[1], "UTF-8") : "";
                if (!keys.contains(key) || query.containsKey(key)) return false;
                query.put(key, content);
            }
            for (String scope : query.getOrDefault("scope", "").split("\\s+")) if (!scope.isEmpty() && !"applications.commands".equals(scope) && !"bot".equals(scope)) return false;
            return applicationId.equals(query.get("client_id"));
        } catch (Exception error) { return false; }
    }
    static boolean installationResultPage(String value, String applicationId, boolean started) {
        if (!allowed(value) || applicationId == null || !applicationId.matches("[0-9]{17,20}")) return false;
        try {
            URI uri = URI.create(value);
            if (!"discord.com".equals(uri.getHost()) || !uri.getPath().matches("/(api/)?oauth2/(authorize|authorized)/?")) return false;
            String client = null;
            if (uri.getRawQuery() != null) for (String pair : uri.getRawQuery().split("&")) {
                String[] parts = pair.split("=", 2);
                if (!"client_id".equals(java.net.URLDecoder.decode(parts[0], "UTF-8"))) continue;
                if (client != null) return false;
                client = parts.length == 2 ? java.net.URLDecoder.decode(parts[1], "UTF-8") : "";
            }
            return client == null ? started : applicationId.equals(client);
        } catch (Exception error) { return false; }
    }
    static String publicUrl(String value) {
        try {
            URI uri = URI.create(value);
            return new URI("https", null, uri.getHost(), -1, allowed(value) ? uri.getPath() : "/", null, null).toString();
        } catch (Exception error) { return ""; }
    }
    static boolean userOnly(String step, String url) {
        if (authentication(url) || !allowed(url)) return true;
        URI uri = URI.create(url);
        return ("discord.com".equals(uri.getHost()) && uri.getPath().matches("/developers/applications/[^/]+/bot(?:/.*)?"))
            || ("dash.cloudflare.com".equals(uri.getHost()) && (uri.getPath().matches(".*/(api-tokens|tokens|security)(/.*)?")
                || uri.getPath().matches(".*/settings(/.*)?") && !uri.getPath().contains("/d1/")
                    && !uri.getPath().matches("/[^/]+/workers/services/view/[^/]+/(production/)?settings(?:/.*)?")));
    }
    static String pageAccess(String step, String url) {
        if (authentication(url)) return "authentication";
        if (!allowed(url)) return "external";
        return userOnly(step, url) ? "protected" : "public";
    }
    static String handoffReason(String step, String url) {
        switch (pageAccess(step, url)) {
            case "authentication": return "当前网页需要登录或验证，完成后再点我继续";
            case "protected": return "当前页面涉及秘密操作，完成后再点我继续";
            case "external": return "当前外部网页未开放代理操作，请返回配置页面继续";
            default: return "网页协助已暂停，请点我继续";
        }
    }
    static String botSecretCaptureError(String reason) {
        switch (reason) {
            case "wrong-app": return "请先打开本次 App 的 Bot 页面，再保存新 Token";
            case "verification-required": return "网站仍在要求密码验证；完成验证并显示新 Token 后再保存";
            case "ambiguous-token": return "当前 Token 区域同时显示多个不同有效值，未覆盖原密钥；请只保留本次重置的新 Token";
            default: return "未识别到 Token 区域中显示的完整新值，未覆盖原密钥；可将新 Token 手动保存到原部署密钥卡后继续";
        }
    }
    static String secretScope(String url) {
        if (!allowed(url) || authentication(url)) return null;
        URI uri = URI.create(url);
        if (!"dash.cloudflare.com".equals(uri.getHost()) || !uri.getPath().matches("/[^/]+/workers/services/view/[^/]+(?:/(?:production|settings)(?:/.*)?)?")) return null;
        String[] segments = uri.getPath().split("/");
        return "/" + segments[1] + "/workers/services/view/" + segments[5];
    }
    static boolean secretOperationAllowed(String operation, String mode, String step, String url, String stage) {
        if (!"agent".equals(mode) || !"cf-secret".equals(step) || secretScope(url) == null) return false;
        return "prepare-secret".equals(operation) ? ("prepare".equals(stage) || "submit".equals(stage))
            : "submit-secret".equals(operation) && ("submit".equals(stage) || "saved".equals(stage));
    }
    static boolean secretPublicControlsAllowed(String mode, String run, String step, String url, String scope, String stage) {
        return secretMetadataAllowed(mode, run, step, url, scope, stage) && stage.matches("prepare|submit|saved");
    }
    static boolean secretMetadataAllowed(String mode, String run, String step, String url, String scope, String stage) {
        return "agent".equals(mode) && run != null && !run.isEmpty() && "cf-secret".equals(step)
            && scope != null && scope.equals(secretScope(url)) && stage != null && stage.matches("prepare|input|submit|saved|submitted");
    }
    static boolean retainSecretStageOnNavigation(String scope, String url, String stage) {
        return scope != null && scope.equals(secretScope(url)) && stage != null && stage.matches("prepare|submit|saved|submitted");
    }
    static boolean userHandoffRequired(String operation, boolean waiting, String run) {
        return waiting && !("fill-endpoint".equals(operation) && run != null && !run.isEmpty());
    }
    static boolean requiresConfirmation(String operation, String label) {
        return "template".equals(operation) || ("click".equals(operation)
            && label.matches("(?is).*(create|deploy|commit|save|update branch|sync fork|add|创建|部署|提交|保存|更新|添加).*"));
    }
    /** Human evidence, never inferred from a dispatched click or a generic success label. */
    static String successChecklist(String step) {
        switch (step) {
            case "github-sync": return "1. 当前是自己的 Fork，分支为 main。\n2. Sync fork 已显示与上游同步（up to date），没有待更新提交。\n3. 没有冲突或错误，自己的 Wrangler 配置仍保留。";
            case "github-save": return "1. 已提交到自己 Fork 的 main，已返回 wrangler.jsonc 文件页。\n2. 最新提交包含本次修改，三个占位值已替换，文件内容与刚才检查的配置一致。\n3. 没有提交失败或未保存提示。";
            case "cf-deploy": return "1. 当前是本次配置的 Worker。\n2. 页面显示当前生产部署成功，没有失败或仍在排队；只有 Build successful 不算部署成功。\n3. 不要求仓库名称、分支和提交号一致；Secret 与连接健康在后续步骤检查。";
            case "cf-secret": return "1. 当前是本次配置的 Worker。\n2. DISCORD_BOT_TOKEN 类型为 Secret，已保存并重新部署。\n3. 最新生产部署已生效，没有失败提示。不要在这里输入或展示 Token。";
            case "discord-endpoint": return "1. 当前是同一个 Discord App。\n2. Interactions Endpoint URL 为本次 Worker 根链接加 /interactions。\n3. 已保存，Discord 端点验证通过，没有签名、地址或保存错误。";
            case "discord-install": return "1. 已打开本次 App 的 Install Link，完成个人账号安装或重新授权。\n2. Discord 明确显示授权成功，没有取消或报错，安装目标账号正确。\n3. 已回到这个 App 的配置页。安装成功不等于指令注册成功，后续仍需注册和检查命令。";
            default: return null;
        }
    }
    static boolean successLocation(String step, String url) {
        if (!allowed(url) || authentication(url)) return false;
        URI uri = URI.create(url);
        String path = uri.getPath();
        if (step.startsWith("github-")) return "github.com".equals(uri.getHost());
        if (step.startsWith("cf-")) return "dash.cloudflare.com".equals(uri.getHost()) && path.matches(".*/workers/services/view/[^/]+(?:/.*)?");
        if (step.startsWith("discord-")) return !userOnly(step, url) && "discord.com".equals(uri.getHost()) && path.matches("/developers/applications/[0-9]{17,20}/[^/]+(?:/.*)?");
        return false;
    }
}
