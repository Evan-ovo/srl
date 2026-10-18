package buzz.jixiangruyi1207.srl;

import static org.junit.Assert.*;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;

public class NativePreviewConcurrencyTest {
    @Test public void boundedDefaultEnhancedAndRestoredQueuesRunActualTasks() throws Exception {
        assertBatch(false, 3);
        assertBatch(true, 6);
        assertBatch(false, 3);
    }

    private void assertBatch(boolean enhanced, int limit) throws Exception {
        NativeExecutors.configurePreviewNetwork(enhanced);
        ThreadPoolExecutor executor = (ThreadPoolExecutor) NativeExecutors.previewNetwork();
        awaitIdlePreviewPool(executor, limit);
        AtomicInteger active = new AtomicInteger(), maximum = new AtomicInteger();
        CountDownLatch started = new CountDownLatch(limit), release = new CountDownLatch(1);
        NativePreviewAssetRequests<String> requests = new NativePreviewAssetRequests<>(
            executor, (url, control) -> {
                maximum.accumulateAndGet(active.incrementAndGet(), Math::max);
                started.countDown();
                try { assertTrue(release.await(5, TimeUnit.SECONDS)); return url; }
                finally { active.decrementAndGet(); }
            });
        List<CompletableFuture<String>> futures = new ArrayList<>();
        try {
            for (int index = 0; index < 12; index++)
                futures.add(requests.acquire("asset-" + index, Collections.singleton("batch"), 1));
            assertTrue(started.await(5, TimeUnit.SECONDS));
            assertEquals(limit, active.get());
            assertEquals(limit, maximum.get());
        } finally { release.countDown(); }
        try {
            for (CompletableFuture<String> future : futures) future.get(5, TimeUnit.SECONDS);
            assertEquals(limit, maximum.get());
        } finally { requests.close(); NativeExecutors.configurePreviewNetwork(false); }
    }

    private void awaitIdlePreviewPool(ThreadPoolExecutor executor, int limit) throws Exception {
        // Request futures complete before excess workers necessarily retire after 6 -> 3.
        // Measure the next independent batch only after the previous pool has settled.
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (executor.getActiveCount() != 0 || !executor.getQueue().isEmpty()
                || executor.getPoolSize() > limit) {
            assertTrue("previous preview batch did not settle", System.nanoTime() < deadline);
            Thread.sleep(1);
        }
    }

    @Test public void decreasingLimitDoesNotInterruptActiveDownloadsOrReplaceQueue() throws Exception {
        ThreadPoolExecutor executor = (ThreadPoolExecutor) NativeExecutors.previewNetwork();
        NativeExecutors.configurePreviewNetwork(true);
        CountDownLatch started = new CountDownLatch(6), release = new CountDownLatch(1);
        AtomicInteger interrupted = new AtomicInteger();
        NativePreviewAssetRequests<String> requests = new NativePreviewAssetRequests<>(executor,
            (url, control) -> {
                started.countDown();
                try { release.await(5, TimeUnit.SECONDS); }
                catch (InterruptedException error) { interrupted.incrementAndGet(); throw error; }
                return url;
            });
        List<CompletableFuture<String>> futures = new ArrayList<>();
        try {
            for (int index = 0; index < 6; index++)
                futures.add(requests.acquire("running-" + index, Collections.singleton("session"), 1));
            assertTrue(started.await(5, TimeUnit.SECONDS));
            NativeExecutors.configurePreviewNetwork(false);
            assertSame(executor, NativeExecutors.previewNetwork());
            assertEquals(3, executor.getCorePoolSize());
            assertEquals(3, executor.getMaximumPoolSize());
            assertEquals(6, executor.getActiveCount());
        } finally { release.countDown(); }
        try {
            for (CompletableFuture<String> future : futures) future.get(5, TimeUnit.SECONDS);
            assertEquals(0, interrupted.get());
        } finally { requests.close(); NativeExecutors.configurePreviewNetwork(false); }
    }
}
