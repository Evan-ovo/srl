package buzz.jixiangruyi1207.srl;

/** Public GitHub identity and Device Flow semantics; credentials stay in NativeSecretStore. */
final class GitHubAssistantPolicy {
    static final String CLIENT_ID = "Ov23licxCo6hFTw8cRwS";
    static final String UPSTREAM = "jixiangruyi117/SRL-Discord-Bridge";
    static boolean repository(String name, String login) {
        return login != null && login.matches("[A-Za-z0-9-]{1,39}") && name != null
            && name.matches("[A-Za-z0-9-]+/[A-Za-z0-9_.-]+")
            && name.regionMatches(true, 0, login + "/", 0, login.length() + 1);
    }
    static boolean branch(String value) {
        return value != null && !value.isEmpty() && value.length() <= 200
            && value.chars().noneMatch(character -> character <= 32 || character == 127 || "~^:?*[\\".indexOf(character) >= 0)
            && !value.contains("..") && !value.contains("@{") && !value.contains("//") && !value.startsWith("/") && !value.endsWith("/") && !value.endsWith(".")
            && java.util.Arrays.stream(value.split("/")).noneMatch(part -> part.startsWith(".") || part.endsWith(".lock"));
    }
    static boolean sha(String value) { return value != null && value.matches("[a-fA-F0-9]{40}"); }
    static int pollInterval(String error, int current, int supplied) {
        if ("authorization_pending".equals(error)) return Math.max(current, supplied);
        if ("slow_down".equals(error)) return Math.max(current + 5, supplied);
        return -1;
    }
    static String authError(String code) {
        switch (code) {
            case "access_denied": return "你取消了 GitHub 授权；任务和网页已保留";
            case "expired_token": return "GitHub 授权码已过期，请重新连接";
            case "device_flow_disabled": return "GitHub 应用尚未启用 Device Flow";
            case "incorrect_client_credentials": return "GitHub 应用注册信息无效";
            case "bad_refresh_token": return "GitHub 授权已失效，请重新连接";
            default: return "GitHub 授权未成功，请检查网站结果后重新连接";
        }
    }
}
