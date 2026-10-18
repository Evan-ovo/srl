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
    @Test public void preservesOfficialDirectDownloadWithoutRedirects() {
        assertTrue(ApkUpdateUrlPolicy.initial("https://updates.example.invalid/file.apk", "", "updates.example.invalid"));
        assertFalse(ApkUpdateUrlPolicy.initial(release, "", "updates.example.invalid"));
        assertFalse(ApkUpdateUrlPolicy.redirect(release, ""));
    }
}
