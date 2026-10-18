package buzz.jixiangruyi1207.srl;
import static org.junit.Assert.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;

public class NativeLocalDataResetTest {
    @Test public void neverCallsOsWithMissingOrIncompleteConfirmation() {
        AtomicInteger calls = new AtomicInteger();
        for (String value : new String[] { null, "", "我已了解" })
            assertThrows(IllegalArgumentException.class, () -> NativeLocalDataReset.clear(value, () -> { calls.incrementAndGet(); return true; }));
        assertEquals(0, calls.get());
    }
    @Test public void invokesOsOnceAndReportsRejectedOsRequest() {
        AtomicInteger calls = new AtomicInteger();
        NativeLocalDataReset.clear(NativeLocalDataReset.CONFIRMATION, () -> { calls.incrementAndGet(); return true; });
        assertEquals(1, calls.get());
        assertThrows(IllegalStateException.class, () -> NativeLocalDataReset.clear(NativeLocalDataReset.CONFIRMATION, () -> false));
    }
}
