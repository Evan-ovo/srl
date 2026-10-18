package buzz.jixiangruyi1207.srl;

import java.net.URI;

/** Restrict the first download to its release owner and every redirect to GitHub's asset hosts. */
final class ApkUpdateUrlPolicy {
    private static URI https(String value) {
        try {
            URI uri = new URI(value);
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null ||
                uri.getUserInfo() != null || (uri.getPort() != -1 && uri.getPort() != 443) ||
                uri.getFragment() != null || !uri.normalize().equals(uri)) return null;
            return uri;
        } catch (Exception ignored) { return null; }
    }

    static boolean initial(String value, String repository, String officialHost) {
        URI uri = https(value);
        if (uri == null) return false;
        if (repository.isEmpty()) return !officialHost.isEmpty() && officialHost.equalsIgnoreCase(uri.getHost());
        if (!repository.matches("[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")) return false;
        return "github.com".equalsIgnoreCase(uri.getHost()) && uri.getRawQuery() == null &&
            uri.getRawPath().startsWith("/" + repository + "/releases/download/") &&
            uri.getRawPath().matches("/" + java.util.regex.Pattern.quote(repository) +
                "/releases/download/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\\.apk");
    }

    static boolean redirect(String value, String repository) {
        if (repository.isEmpty()) return false;
        if (initial(value, repository, "")) return true;
        URI uri = https(value);
        return uri != null && ("release-assets.githubusercontent.com".equalsIgnoreCase(uri.getHost()) ||
            "objects.githubusercontent.com".equalsIgnoreCase(uri.getHost())) &&
            uri.getRawPath().startsWith("/github-production-release-asset-");
    }
}
