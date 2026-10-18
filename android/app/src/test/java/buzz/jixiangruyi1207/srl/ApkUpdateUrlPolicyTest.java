package buzz.jixiangruyi1207.srl;

import static org.junit.Assert.*;
import org.junit.Test;

public class ApkUpdateUrlPolicyTest {
    private final String repository = "owner/project";
    private final String release = "https://github.com/owner/project/releases/download/public-abc/SRL_Pubilc.apk";
    @Test public void restrictsInitialDownloadToTheCompiledRepository() {
        assertTrue(ApkUpdateUrlPolicy.initial(release, repository, ""));
        for (String value : new String[] {
            release.replace("owner/project", "other/project"), release.replace("https:", "http:"),
            release.replace("github.com", "github.com.evil.invalid"), release + "?redirect=1",
            release.replace("github.com", "user@github.com"), release + "#fragment",
            release.replace("/SRL_Pubilc.apk", "/../bad.apk"), release.replace("/SRL_Pubilc.apk", "/%2e%2e/bad.apk")
        }) assertFalse(value, ApkUpdateUrlPolicy.initial(value, repository, ""));
    }
    @Test public void acceptsGithubAssetRedirectsWithoutAllowingArbitraryHttpsHosts() {
        assertTrue(ApkUpdateUrlPolicy.redirect("https://release-assets.githubusercontent.com/github-production-release-asset-123/file?signature=abc", repository));
        assertTrue(ApkUpdateUrlPolicy.redirect("https://objects.githubusercontent.com/github-production-release-asset-123/file", repository));
        assertFalse(ApkUpdateUrlPolicy.redirect("https://example.invalid/file.apk", repository));
        assertFalse(ApkUpdateUrlPolicy.redirect("https://release-assets.githubusercontent.com/unrelated/file", repository));
        assertFalse(ApkUpdateUrlPolicy.redirect(release, "other/project"));
    }
    @Test public void acceptsCurrentGithubAssetPathsWithTheSameHttpsHostBoundary() {
        String path = "/github-production-release-asset/123/abc-def?signature=example";
        assertTrue(ApkUpdateUrlPolicy.redirect("https://release-assets.githubusercontent.com" + path, repository));
        assertTrue(ApkUpdateUrlPolicy.redirect("https://objects.githubusercontent.com" + path, repository));
        for (String value : new String[] {
            "http://release-assets.githubusercontent.com" + path,
            "https://release-assets.githubusercontent.com.evil.invalid" + path,
            "https://user@release-assets.githubusercontent.com" + path,
            "https://release-assets.githubusercontent.com:444" + path,
            "https://release-assets.githubusercontent.com/github-production-release-assets/123/file",
            "https://release-assets.githubusercontent.com/github-production-release-asset/../unrelated/file",
            "https://release-assets.githubusercontent.com" + path + "#fragment"
        }) assertFalse(value, ApkUpdateUrlPolicy.redirect(value, repository));
        assertFalse(ApkUpdateUrlPolicy.redirect("https://release-assets.githubusercontent.com" + path, ""));
    }
    @Test public void preservesOfficialDirectDownloadWithoutRedirects() {
        assertTrue(ApkUpdateUrlPolicy.initial("https://updates.example.invalid/file.apk", "", "updates.example.invalid"));
        assertFalse(ApkUpdateUrlPolicy.initial(release, "", "updates.example.invalid"));
        assertFalse(ApkUpdateUrlPolicy.redirect(release, ""));
    }
}
