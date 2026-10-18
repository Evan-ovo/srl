package buzz.jixiangruyi1207.srl;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class NativeCloudRetryPolicyTest {
    @Test
    public void retriesOnlyTwiceAfterTheInitialWorkerRun() {
        assertTrue(NativeCloudRetryPolicy.shouldRetry(0));
        assertTrue(NativeCloudRetryPolicy.shouldRetry(1));
        assertFalse(NativeCloudRetryPolicy.shouldRetry(2));
        assertFalse(NativeCloudRetryPolicy.shouldRetry(-1));
    }
}
