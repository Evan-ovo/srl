package buzz.jixiangruyi1207.srl;

import org.junit.Test;
// SRL-PUBLIC-SYNC: BEGIN PUBLIC-ONLY id=public-origin-test-imports
import java.net.URL;
import java.io.IOException;
// SRL-PUBLIC-SYNC: END PUBLIC-ONLY id=public-origin-test-imports
import static org.junit.Assert.*;

public class OfficialAppWebViewClientTest {
    @Test public void allowsOnlyProgramFilesAndImmutableManifests() {
        assertTrue(OfficialAppWebViewClient.isHostedDownloadPath("/official-apps/srl-0.0.240-v340/draw-0123456789abcdef.json"));
        assertTrue(OfficialAppWebViewClient.isHostedDownloadPath("/official-apps/srl-0.0.239-v339/draw-0123456789abcdef.srlapp"));
        assertTrue(OfficialAppWebViewClient.isHostedDownloadPath("/assets/DrawApp-abcd1234.js"));
        assertFalse(OfficialAppWebViewClient.isHostedDownloadPath("/assets/../secret.js"));
        assertFalse(OfficialAppWebViewClient.isHostedDownloadPath("/official-apps/api-2/catalog.json"));
        assertFalse(OfficialAppWebViewClient.isHostedDownloadPath("/api/auth/login"));
        assertFalse(OfficialAppWebViewClient.isHostedDownloadPath("/assets/file.html"));
        assertFalse(OfficialAppWebViewClient.isHostedDownloadPath(null));
    }
    // SRL-PUBLIC-SYNC: BEGIN PUBLIC-ONLY id=public-asset-origin-tests
    @Test
    public void hostedPackageUrlKeepsPathAndUsesConfiguredOrigin() throws Exception {
        URL localUrl = new URL("https://localhost/official-apps/srl-public-0.0.128-v4/chatReader-abcd.srlapp");

        URL hostedUrl = OfficialAppWebViewClient.buildHostedAssetUrl(
            localUrl,
            "https://downloads.example.workers.dev"
        );

        assertEquals(
            "https://downloads.example.workers.dev/official-apps/srl-public-0.0.128-v4/chatReader-abcd.srlapp",
            hostedUrl.toString()
        );
    }

    @Test
    public void hostedPackageUrlRejectsUnsafeOriginsAndPaths() throws Exception {
        URL localUrl = new URL("https://localhost/official-apps/srl-public-0.0.128-v4/chatReader-abcd.srlapp");
        URL traversalUrl = new URL("https://localhost/official-apps/../secret.srlapp");

        assertThrows(
            IOException.class,
            () -> OfficialAppWebViewClient.buildHostedAssetUrl(localUrl, "http://downloads.example.workers.dev")
        );
        assertThrows(
            IOException.class,
            () -> OfficialAppWebViewClient.buildHostedAssetUrl(localUrl, "https://downloads.example.workers.dev/path")
        );
        assertThrows(
            IOException.class,
            () -> OfficialAppWebViewClient.buildHostedAssetUrl(traversalUrl, "https://downloads.example.workers.dev")
        );
    }
    // SRL-PUBLIC-SYNC: END PUBLIC-ONLY id=public-asset-origin-tests
}
