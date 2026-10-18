package buzz.jixiangruyi1207.srl;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

public final class NativeCloudUploadWorkerTest {
    @Test
    public void rejectsSameSizeStarterAndUnknownStateBeforeCountingUploadAsComplete() throws Exception {
        JSONObject asset = new JSONObject().put("size", 14864903L);
        assertFalse(NativeCloudUploadWorker.isCompletedGitHubAsset(asset, 14864903L));
        asset.put("state", "starter");
        assertFalse(NativeCloudUploadWorker.isCompletedGitHubAsset(asset, 14864903L));
        asset.put("state", "uploading");
        assertFalse(NativeCloudUploadWorker.isCompletedGitHubAsset(asset, 14864903L));
    }

    @Test
    public void requiresCompletedStateAndExactSize() throws Exception {
        JSONObject asset = new JSONObject().put("size", 14864903L).put("state", "uploaded");
        assertTrue(NativeCloudUploadWorker.isCompletedGitHubAsset(asset, 14864903L));
        assertFalse(NativeCloudUploadWorker.isCompletedGitHubAsset(asset, 14864904L));
        asset.remove("size");
        assertFalse(NativeCloudUploadWorker.isCompletedGitHubAsset(asset, 14864903L));
    }
}
