package buzz.jixiangruyi1207.srl;

import static org.junit.Assert.*;
import static buzz.jixiangruyi1207.srl.NativeCloudRestoreTransport.*;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.HashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.ExecutionException;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class NativeCloudRestoreTransportTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();

    @Test public void cancellingIncrementalSharedDownloadDrainsWaitersWithoutInstallingLateOriginals() throws Exception {
        File root = temporary.newFolder(); byte[] common=bytes("cancel-shared");
        RestoreObject shared=object(common),a=object(bytes("a")),b=object(bytes("b"));
        List<RestoreResource> resources=Arrays.asList(
            resource(bytes("cancel-shareda"),new RestoreSegment(shared.hash,0,common.length),new RestoreSegment(a.hash,0,1)),
            resource(bytes("cancel-sharedb"),new RestoreSegment(shared.hash,0,common.length),new RestoreSegment(b.hash,0,1)));
        CountDownLatch started=new CountDownLatch(1),release=new CountDownLatch(1);
        AtomicInteger cancellations=new AtomicInteger();ExecutorService owner=Executors.newSingleThreadExecutor();
        Future<RestoreCounts> operation=owner.submit(()->restoreIncrementally(new File(root,"pending"),Arrays.asList(shared,a,b),resources,h->file(root,h),
            ()->new CancellableDownloader(){
                public void download(RestoreObject part,File target)throws Exception{
                    if(part.hash.equals(shared.hash)){started.countDown();release.await();throw new java.io.InterruptedIOException("cancelled");}
                    Files.write(target.toPath(),part.hash.equals(a.hash)?bytes("a"):bytes("b"));
                }
                public void cancel(){cancellations.incrementAndGet();release.countDown();}
            },(done,total)->{},(hash,error)->{}));
        try{
            assertTrue(started.await(5,TimeUnit.SECONDS));long start=System.nanoTime();operation.cancel(true);owner.shutdownNow();
            assertTrue("all shared waiters must drain",owner.awaitTermination(3,TimeUnit.SECONDS));
            assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-start)<3000);assertTrue(cancellations.get()>0);
            for(RestoreResource resource:resources)assertFalse(file(root,resource.hash).exists());
        }finally{release.countDown();owner.shutdownNow();}
    }

    @Test public void incrementalResourcesDownloadSharedChunksOnceAndReleaseTheirJobCache() throws Exception {
        File root = temporary.newFolder();
        byte[] common = new byte[2 * 1024 * 1024 + 7]; new java.util.Random(61).nextBytes(common);
        RestoreObject shared = object(common);
        List<RestoreObject> objects = new java.util.ArrayList<>(); objects.add(shared);
        List<RestoreResource> resources = new java.util.ArrayList<>();
        Map<String, byte[]> bodies = new HashMap<>(); bodies.put(shared.hash, common);
        for (int index = 0; index < 8; index++) {
            byte[] tail = bytes("tail-" + index); RestoreObject part = object(tail);
            objects.add(part); bodies.put(part.hash, tail);
            byte[] original = new byte[common.length + tail.length];
            System.arraycopy(common, 0, original, 0, common.length);
            System.arraycopy(tail, 0, original, common.length, tail.length);
            resources.add(resource(original, new RestoreSegment(shared.hash, 0, common.length), new RestoreSegment(part.hash, 0, tail.length)));
        }
        AtomicInteger reads = new AtomicInteger(), sharedReads = new AtomicInteger();
        RestoreCounts result = restoreIncrementally(new File(root, "pending"), objects, resources, h -> file(root, h),
            () -> (part, target) -> { reads.incrementAndGet(); if (part.hash.equals(shared.hash)) sharedReads.incrementAndGet(); Files.write(target.toPath(), bodies.get(part.hash)); },
            (done, total) -> {}, (hash, error) -> {});
        assertEquals(1, sharedReads.get()); assertEquals(9, reads.get());
        assertEquals(9, result.downloaded); assertEquals(8, result.assembled); assertTrue(result.failures.isEmpty());
        for (RestoreResource resource : resources) assertTrue(verifyFile(file(root, resource.hash), resource.hash, resource.size));
        assertFalse(new File(root, "pending/shared-chunks").exists());
    }

    @Test public void incrementalSharedCacheIsReverifiedOnExplicitRetryAndDoesNotHideOtherFailures() throws Exception {
        File root = temporary.newFolder(); byte[] common = bytes("shared-prefix");
        RestoreObject shared = object(common), good = object(bytes("good")), bad = object(bytes("bad"));
        List<RestoreObject> objects = Arrays.asList(shared, good, bad);
        RestoreResource a = resource(bytes("shared-prefixgood"), new RestoreSegment(shared.hash,0,common.length),new RestoreSegment(good.hash,0,4));
        RestoreResource b = resource(bytes("shared-prefixbad"), new RestoreSegment(shared.hash,0,common.length),new RestoreSegment(bad.hash,0,3));
        AtomicInteger sharedReads = new AtomicInteger();
        RestoreCounts first = restoreIncrementally(new File(root,"pending"), objects, Arrays.asList(a,b), h->file(root,h),
            () -> (part,target) -> { if(part.hash.equals(bad.hash))throw new IOException("missing tail");if(part.hash.equals(shared.hash))sharedReads.incrementAndGet();Files.write(target.toPath(),part.hash.equals(shared.hash)?common:bytes("good")); },
            (done,total)->{},(hash,error)->{});
        assertEquals(1,first.assembled);assertEquals(1,first.failures.size());assertTrue(verifyFile(file(root,a.hash),a.hash,a.size));
        File cached = new File(root,"pending/shared-chunks/"+shared.hash+".chunk.part");
        assertTrue(cached.isFile());Files.write(cached.toPath(),new byte[common.length]);
        File local = new File(root,"pending/"+b.hash+"/"+shared.hash+".chunk.part");
        local.getParentFile().mkdirs();Files.write(local.toPath(),new byte[common.length]);
        RestoreCounts second = restoreIncrementally(new File(root,"pending"),objects,Arrays.asList(a,b),h->file(root,h),
            ()->(part,target)->{if(part.hash.equals(shared.hash))sharedReads.incrementAndGet();Files.write(target.toPath(),part.hash.equals(shared.hash)?common:part.hash.equals(bad.hash)?bytes("bad"):bytes("good"));},
            (done,total)->{},(hash,error)->{});
        assertTrue(second.failures.isEmpty());assertTrue(verifyFile(file(root,b.hash),b.hash,b.size));
        assertEquals(2,sharedReads.get());assertFalse(cached.exists());
    }
    private byte[] bytes(String text) { return text.getBytes(StandardCharsets.UTF_8); }
    private String hash(byte[] data) throws Exception { return hex(MessageDigest.getInstance("SHA-256").digest(data)); }
    private RestoreObject object(byte[] data) throws Exception { return new RestoreObject(hash(data), data.length, "https://example.invalid/object"); }
    private RestoreResource resource(byte[] data, RestoreSegment... segments) throws Exception {
        return new RestoreResource(hash(data), data.length, Arrays.asList(segments));
    }
    private File file(File root, String hash) { return new File(root, hash + ".bin"); }

    @Test public void completeLocalOriginalSkipsAllRemoteChunksEvenWhenTheirCopiesAreMissing() throws Exception {
        File root = temporary.newFolder();
        byte[] first = bytes("first"), second = bytes("second"), full = bytes("firstsecond");
        RestoreObject a = object(first), b = object(second);
        Files.write(file(root, hash(full)).toPath(), full);
        AtomicInteger downloads = new AtomicInteger();
        RestoreCounts result = restoreFiles(new File(root, "pending"), Arrays.asList(a, b),
            Collections.singletonList(resource(full, new RestoreSegment(a.hash, 0, a.size), new RestoreSegment(b.hash, 0, b.size))),
            h -> file(root, h), (o, target) -> { downloads.incrementAndGet(); throw new IOException("offline"); });
        assertEquals(0, downloads.get()); assertEquals(1, result.reused); assertEquals(0, result.assembled);
        assertEquals(1, root.listFiles().length);
        assertArrayEquals(full, Files.readAllBytes(file(root, hash(full)).toPath()));
    }

    @Test public void sameSizeCorruptLocalOriginalIsDownloadedAndReverified() throws Exception {
        File root = temporary.newFolder();
        byte[] expected = bytes("good"), corrupt = bytes("evil");
        RestoreObject object = object(expected);
        Files.write(file(root, object.hash).toPath(), corrupt);
        AtomicInteger downloads = new AtomicInteger();

        RestoreCounts result = restoreFiles(new File(root, "pending"), Collections.singletonList(object),
            Collections.singletonList(resource(expected, new RestoreSegment(object.hash, 0, object.size))),
            h -> file(root, h), (o, target) -> { downloads.incrementAndGet(); Files.write(target.toPath(), expected); });

        assertEquals(1, downloads.get()); assertEquals(1, result.downloaded); assertEquals(1, result.assembled);
        assertArrayEquals(expected, Files.readAllBytes(file(root, object.hash).toPath()));
    }

    @Test public void missingResourceDownloadsOnlyItsSegmentsAndNeverInstallsTransportChunks() throws Exception {
        File root = temporary.newFolder();
        byte[] aData = bytes("part-a"), bData = bytes("part-b"), full = bytes("part-apart-b");
        RestoreObject a = object(aData), b = object(bData), unused = object(bytes("unused"));
        RestoreResource plan = resource(full, new RestoreSegment(a.hash, 0, a.size), new RestoreSegment(b.hash, 0, b.size));
        AtomicInteger downloads = new AtomicInteger();
        ObjectDownloader transport = (o, target) -> {
            downloads.incrementAndGet();
            if (o.hash.equals(unused.hash)) throw new AssertionError("unneeded download");
            Files.write(target.toPath(), o.hash.equals(a.hash) ? aData : bData);
        };
        RestoreCounts result = restoreFiles(new File(root, "pending"), Arrays.asList(a, b, unused),
            Collections.singletonList(plan), h -> file(root, h), transport);
        assertEquals(2, result.downloaded); assertEquals(1, result.assembled);
        assertEquals(1, root.listFiles().length);
        assertFalse(file(root, a.hash).exists()); assertFalse(file(root, b.hash).exists());
        assertArrayEquals(full, Files.readAllBytes(file(root, hash(full)).toPath()));
        restoreFiles(new File(root, "pending"), Arrays.asList(a, b, unused), Collections.singletonList(plan), h -> file(root, h), transport);
        assertEquals(2, downloads.get()); assertEquals(1, root.listFiles().length);
    }

    @Test public void sharedPackIsDownloadedOnceAndLegacyChunkCopiesAreNeverDeleted() throws Exception {
        File root = temporary.newFolder();
        byte[] pack = bytes("aaabbb"); RestoreObject object = object(pack);
        List<RestoreResource> plans = Arrays.asList(resource(bytes("aaa"), new RestoreSegment(object.hash, 0, 3)),
            resource(bytes("bbb"), new RestoreSegment(object.hash, 3, 3)));
        Files.write(file(root, object.hash).toPath(), pack);
        restoreFiles(new File(root, "pending"), Collections.singletonList(object), plans, h -> file(root, h),
            (o, target) -> { throw new AssertionError("legacy verified copy exists"); });
        assertArrayEquals(pack, Files.readAllBytes(file(root, object.hash).toPath()));
        assertEquals(3, root.listFiles().length);
    }

    @Test public void failedDownloadCleansOnlyThisTasksPartials() throws Exception {
        File root = temporary.newFolder(); File pending = new File(root, "pending"); pending.mkdir();
        File otherTask = new File(pending, "other-task.part"); Files.write(otherTask.toPath(), bytes("keep"));
        RestoreObject object = object(bytes("original"));
        try {
            restoreFiles(pending, Collections.singletonList(object), Collections.singletonList(resource(bytes("original"),
                new RestoreSegment(object.hash, 0, object.size))), h -> file(root, h),
                (o, target) -> { Files.write(target.toPath(), bytes("partial")); throw new IOException("interrupted"); });
            fail("must surface download failure");
        } catch (IOException expected) { assertEquals("interrupted", expected.getMessage()); }
        assertArrayEquals(bytes("keep"), Files.readAllBytes(otherTask.toPath()));
        assertEquals(1, pending.listFiles().length); assertFalse(file(root, object.hash).exists());
    }

    @Test public void wrongHashCannotBecomeAResourceEvenWhenSizeMatches() throws Exception {
        File root = temporary.newFolder(); RestoreObject object = object(bytes("good"));
        try {
            restoreFiles(new File(root, "pending"), Collections.singletonList(object),
                Collections.singletonList(resource(bytes("good"), new RestoreSegment(object.hash, 0, 4))),
                h -> file(root, h), (o, target) -> Files.write(target.toPath(), bytes("evil")));
            fail("must verify SHA");
        } catch (IOException expected) { assertTrue(expected.getMessage().contains("SHA-256")); }
        assertEquals(0, root.listFiles().length);
    }

    @Test public void invalidRangeFailsBeforeAnyDownloadOrMutation() throws Exception {
        File root = temporary.newFolder(); RestoreObject object = object(bytes("x"));
        try {
            restoreFiles(new File(root, "pending"), Collections.singletonList(object),
                Collections.singletonList(resource(bytes("x"), new RestoreSegment(object.hash, Long.MAX_VALUE, 1))),
                h -> file(root, h), (o, target) -> { throw new AssertionError("must validate plan first"); });
            fail("invalid range");
        } catch (IllegalArgumentException expected) { assertTrue(expected.getMessage().contains("范围")); }
        assertEquals(0, root.listFiles().length);
    }

    @Test public void failedAssemblyPreservesExistingOriginalAndLegacyFiles() throws Exception {
        File root = temporary.newFolder(); byte[] old = bytes("retained"), pack = bytes("xxx");
        Files.write(file(root, hash(old)).toPath(), old);
        RestoreObject object = object(pack); Files.write(file(root, object.hash).toPath(), pack);
        try {
            restoreFiles(new File(root, "pending"), Collections.singletonList(object),
                Collections.singletonList(resource(bytes("bad"), new RestoreSegment(object.hash, 0, 3))),
                h -> file(root, h), (o, target) -> { throw new AssertionError("should reuse"); });
            fail("wrong assembled content hash");
        } catch (IOException expected) { assertTrue(expected.getMessage().contains("SHA-256")); }
        assertEquals(2, root.listFiles().length);
        assertArrayEquals(old, Files.readAllBytes(file(root, hash(old)).toPath()));
    }

    @Test public void durableRetryKeepsVerifiedChunksAndDownloadsOnlyTheInterruptedChunk() throws Exception {
        File root = temporary.newFolder(); File pending = new File(root, "pending");
        byte[] aBytes = bytes("aaa"), bBytes = bytes("bbb"), full = bytes("aaabbb");
        RestoreObject a = object(aBytes), b = object(bBytes);
        List<RestoreResource> plans = Collections.singletonList(resource(full,
            new RestoreSegment(a.hash, 0, 3), new RestoreSegment(b.hash, 0, 3)));
        AtomicInteger firstDownloads = new AtomicInteger();
        CountDownLatch firstWritten = new CountDownLatch(1);
        try {
            restoreFiles(pending, Arrays.asList(a, b), plans, h -> file(root, h), (o, target) -> {
                firstDownloads.incrementAndGet();
                if (o.hash.equals(b.hash)) assertTrue(firstWritten.await(5, TimeUnit.SECONDS));
                Files.write(target.toPath(), o.hash.equals(a.hash) ? aBytes : bytes("b"));
                if (o.hash.equals(a.hash)) firstWritten.countDown();
                if (o.hash.equals(b.hash)) throw new IOException("offline");
            }, true, (completed, total) -> {});
            fail("network must interrupt the first invocation");
        } catch (IOException expected) { assertEquals("offline", expected.getMessage()); }
        assertEquals(2, firstDownloads.get());
        AtomicInteger resumedDownloads = new AtomicInteger();
        restoreFiles(pending, Arrays.asList(a, b), plans, h -> file(root, h), (o, target) -> {
            resumedDownloads.incrementAndGet();
            assertEquals(b.hash, o.hash);
            assertArrayEquals(bytes("b"), Files.readAllBytes(target.toPath()));
            Files.write(target.toPath(), bBytes);
        }, true, (completed, total) -> {});
        assertEquals(1, resumedDownloads.get());
        assertArrayEquals(full, Files.readAllBytes(file(root, hash(full)).toPath()));
        assertFalse(pending.exists());
    }

    @Test public void byteResumeAcceptsOnlyAnExactRangeAndRestartsSafelyWhenTheServerIgnoresRange() {
        assertEquals(4, restoreResponseOffset(206, "bytes 4-9/10", 4, 10));
        assertEquals(0, restoreResponseOffset(200, null, 4, 10));
        for (String range : Arrays.asList("bytes 0-9/10", "bytes 4-8/10", "bytes 4-9/11", "bytes 4-9/*", null)) {
            try { restoreResponseOffset(206, range, 4, 10); fail("must reject mismatched suffix"); }
            catch (IllegalStateException expected) {}
        }
    }

    @Test public void boundedPrefetchOverlapsThreeChunksAndAssemblesInDescriptorOrder() throws Exception {
        File root = temporary.newFolder();
        byte[][] contents = { bytes("aaa"), bytes("bbb"), bytes("ccc"), bytes("ddd") };
        List<RestoreObject> objects = Arrays.asList(object(contents[0]), object(contents[1]), object(contents[2]), object(contents[3]));
        RestoreResource plan = resource(bytes("aaabbbcccddd"), objects.stream()
            .map(o -> new RestoreSegment(o.hash, 0, o.size)).toArray(RestoreSegment[]::new));
        CountDownLatch windowStarted = new CountDownLatch(3), releaseFirst = new CountDownLatch(1), firstStarted = new CountDownLatch(1);
        AtomicInteger started = new AtomicInteger(), active = new AtomicInteger(), peak = new AtomicInteger();
        ExecutorService owner = Executors.newSingleThreadExecutor();
        try {
            Future<RestoreCounts> result = owner.submit(() -> restoreFiles(new File(root, "pending"), objects,
                Collections.singletonList(plan), h -> file(root, h), (o, target) -> {
                    int count = active.incrementAndGet(); peak.accumulateAndGet(count, Math::max);
                    int index = objects.indexOf(o);
                    started.incrementAndGet(); windowStarted.countDown();
                    try {
                        if (index == 0) { firstStarted.countDown(); assertTrue(releaseFirst.await(5, TimeUnit.SECONDS)); }
                        else assertTrue(firstStarted.await(5, TimeUnit.SECONDS));
                        Files.write(target.toPath(), contents[index]);
                    } finally { active.decrementAndGet(); }
                }));
            assertTrue(windowStarted.await(5, TimeUnit.SECONDS));
            assertEquals("completed later chunks must keep their window reservations", 3, started.get());
            releaseFirst.countDown();
            assertEquals(4, result.get(5, TimeUnit.SECONDS).downloaded);
            assertTrue(peak.get() > 1); assertTrue(peak.get() <= 3);
            assertEquals(0, active.get());
            assertArrayEquals(bytes("aaabbbcccddd"), Files.readAllBytes(file(root, plan.hash).toPath()));
            assertFalse(new File(root, "pending").exists());
        } finally { releaseFirst.countDown(); owner.shutdownNow(); assertTrue(owner.awaitTermination(5, TimeUnit.SECONDS)); }
    }

    @Test public void prefetchSpansSmallFilesButSkipsVerifiedLocalOriginals() throws Exception {
        File root = temporary.newFolder();
        byte[][] contents = { bytes("one"), bytes("local"), bytes("two"), bytes("three"), bytes("four") };
        List<RestoreObject> objects = new java.util.ArrayList<>();
        List<RestoreResource> plans = new java.util.ArrayList<>();
        for (byte[] data : contents) {
            RestoreObject object = object(data); objects.add(object);
            plans.add(resource(data, new RestoreSegment(object.hash, 0, object.size)));
        }
        Files.write(file(root, plans.get(1).hash).toPath(), contents[1]);
        CountDownLatch window = new CountDownLatch(3), release = new CountDownLatch(1);
        AtomicInteger downloads = new AtomicInteger();
        ExecutorService owner = Executors.newSingleThreadExecutor();
        try {
            Future<RestoreCounts> result = owner.submit(() -> restoreFiles(new File(root, "pending"), objects, plans,
                h -> file(root, h), (o, target) -> {
                    assertNotEquals(objects.get(1).hash, o.hash);
                    downloads.incrementAndGet(); window.countDown();
                    assertTrue(release.await(5, TimeUnit.SECONDS));
                    Files.write(target.toPath(), contents[objects.indexOf(o)]);
                }));
            assertTrue("small files must fill the existing three-slot window", window.await(5, TimeUnit.SECONDS));
            assertEquals(3, downloads.get());
            release.countDown();
            RestoreCounts counts = result.get(5, TimeUnit.SECONDS);
            assertEquals(4, counts.downloaded); assertEquals(1, counts.reused);
            for (int index = 0; index < contents.length; index++)
                assertArrayEquals(contents[index], Files.readAllBytes(file(root, plans.get(index).hash).toPath()));
        } finally { release.countDown(); owner.shutdownNow(); assertTrue(owner.awaitTermination(5, TimeUnit.SECONDS)); }
    }

    @Test public void thousandFileDefaultAndSerialWindowsPreserveAllBytesAndRequestCounts() throws Exception {
        final int count = 1000, size = 64 * 1024;
        List<RestoreObject> objects = new java.util.ArrayList<>();
        List<RestoreResource> plans = new java.util.ArrayList<>();
        for (int index = 0; index < count; index++) {
            byte[] data = new byte[size]; java.nio.ByteBuffer.wrap(data).putInt(index);
            RestoreObject object = object(data); objects.add(object);
            plans.add(resource(data, new RestoreSegment(object.hash, 0, size)));
        }
        for (int concurrency : new int[] { 1, RESTORE_PREFETCH_CONCURRENCY, 0 }) {
            File root = temporary.newFolder();
            AtomicInteger requests = new AtomicInteger(), active = new AtomicInteger(), peak = new AtomicInteger();
            java.util.concurrent.atomic.AtomicLong heap = new java.util.concurrent.atomic.AtomicLong();
            Map<String, Integer> indexes = new java.util.HashMap<>();
            for (int index = 0; index < count; index++) indexes.put(objects.get(index).hash, index);
            long start = System.nanoTime();
            ObjectDownloader download = (o, target) -> {
                requests.incrementAndGet(); peak.accumulateAndGet(active.incrementAndGet(), Math::max);
                try {
                    // Controlled network-latency fixture; this is not a real provider speed claim.
                    Thread.sleep(2);
                    byte[] data = new byte[size]; java.nio.ByteBuffer.wrap(data).putInt(indexes.get(o.hash));
                    Files.write(target.toPath(), data);
                    Runtime runtime = Runtime.getRuntime(); heap.accumulateAndGet(runtime.totalMemory() - runtime.freeMemory(), Math::max);
                } finally { active.decrementAndGet(); }
            };
            RestoreCounts result = concurrency == 0
                ? restoreIncrementally(new File(root, "pending"), objects, plans, h -> file(root, h), () -> download,
                    (completed, total) -> {}, (hash, error) -> {})
                : restoreFiles(new File(root, "pending"), objects, plans, h -> file(root, h), download,
                    false, (completed, total) -> {}, concurrency, RESTORE_PREFETCH_BYTES);
            long elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);
            assertEquals(count, requests.get()); assertEquals(count, result.downloaded); assertEquals(count, result.assembled);
            assertTrue(peak.get() <= (concurrency == 0 ? 3 : concurrency)); assertEquals(0, active.get());
            for (RestoreResource resource : plans) assertTrue(verifyFile(file(root, resource.hash), resource.hash, resource.size));
            RestoreCounts reused = restoreFiles(new File(root, "pending"), objects, plans, h -> file(root, h), (o, target) -> { throw new AssertionError("repeated download"); });
            assertEquals(count, reused.reused);
            System.out.println("SRL synthetic native restore: files=" + count + " bytes=" + ((long)count * size)
                + " concurrency=" + (concurrency == 0 ? "incremental-3" : concurrency) + " requests=" + requests.get() + " elapsedMs=" + elapsedMs
                + " peakActive=" + peak.get() + " sampledJvmHeapBytes=" + heap.get());
        }
    }

    @Test public void incrementalFailuresDoNotBlockLaterFilesAndExplicitRetryReusesInstalledOriginals() throws Exception {
        File root = temporary.newFolder();
        List<RestoreObject> objects = new java.util.ArrayList<>();
        List<RestoreResource> plans = new java.util.ArrayList<>();
        Map<String, byte[]> bodies = new HashMap<>();
        for (int index = 0; index < 6; index++) {
            byte[] body = bytes("incremental-" + index); RestoreObject object = object(body);
            objects.add(object); bodies.put(object.hash, body);
            plans.add(resource(body, new RestoreSegment(object.hash, 0, body.length)));
        }
        CountDownLatch release = new CountDownLatch(1), later = new CountDownLatch(4);
        ExecutorService owner = Executors.newSingleThreadExecutor();
        try {
            Future<RestoreCounts> operation = owner.submit(() -> restoreIncrementally(new File(root, "pending"), objects, plans,
                h -> file(root, h), () -> (object, target) -> {
                    if (object.hash.equals(objects.get(0).hash)) assertTrue(release.await(5, TimeUnit.SECONDS));
                    if (object.hash.equals(objects.get(1).hash)) throw new IOException("missing original");
                    Files.write(target.toPath(), bodies.get(object.hash));
                }, (done, total) -> {}, (hash, error) -> {
                    if (!hash.equals(objects.get(0).hash) && error == null) later.countDown();
                }));
            assertTrue("later files must finish while head is blocked", later.await(5, TimeUnit.SECONDS));
            assertFalse(operation.isDone()); release.countDown();
            RestoreCounts result = operation.get(5, TimeUnit.SECONDS);
            assertEquals(5, result.assembled); assertEquals(1, result.failures.size());
            AtomicInteger reads = new AtomicInteger();
            RestoreCounts retry = restoreIncrementally(new File(root, "pending"), objects, plans, h -> file(root, h),
                () -> (object, target) -> { reads.incrementAndGet(); Files.write(target.toPath(), bodies.get(object.hash)); },
                (done, total) -> {}, (hash, error) -> {});
            assertEquals(1, reads.get()); assertEquals(1, retry.assembled); assertTrue(retry.failures.isEmpty());
        } finally { release.countDown(); owner.shutdownNow(); }
    }

    @Test public void cancellingIncrementalQueueDrainsActiveDownloadsAndDoesNotClaimQueuedFiles() throws Exception {
        File root = temporary.newFolder();
        List<RestoreObject> objects = new java.util.ArrayList<>(); List<RestoreResource> plans = new java.util.ArrayList<>();
        for (int index = 0; index < 6; index++) {
            byte[] body = bytes("cancel-incremental-" + index); RestoreObject object = object(body); objects.add(object);
            plans.add(resource(body, new RestoreSegment(object.hash, 0, body.length)));
        }
        CountDownLatch started = new CountDownLatch(3), drained = new CountDownLatch(1);
        AtomicInteger active = new AtomicInteger(), reads = new AtomicInteger(), delivered = new AtomicInteger();
        ExecutorService owner = Executors.newSingleThreadExecutor();
        try {
            Future<?> operation = owner.submit(() -> {
                try { restoreIncrementally(new File(root, "pending"), objects, plans, h -> file(root, h), () -> (object, target) -> {
                    reads.incrementAndGet(); active.incrementAndGet(); started.countDown();
                    try { new CountDownLatch(1).await(); } finally { active.decrementAndGet(); }
                }, (done, total) -> {}, (hash, error) -> delivered.incrementAndGet()); }
                catch (Exception expected) { assertTrue(expected instanceof InterruptedException); }
                finally { drained.countDown(); }
            });
            assertTrue(started.await(5, TimeUnit.SECONDS)); operation.cancel(true);
            assertTrue(drained.await(5, TimeUnit.SECONDS)); assertEquals(0, active.get());
            assertEquals(3, reads.get()); assertEquals(0, delivered.get());
        } finally { owner.shutdownNow(); }
    }

    @Test public void byteBudgetBoundsPendingChunksAndOversizedLegacyChunkRunsAlone() throws Exception {
        for (boolean oversized : new boolean[] { false, true }) {
            File root = temporary.newFolder();
            byte[] first = bytes(oversized ? "1234567" : "1234"), second = bytes("5678"), full = bytes(oversized ? "12345675678" : "12345678");
            RestoreObject a = object(first), b = object(second);
            CountDownLatch firstStarted = new CountDownLatch(1), releaseFirst = new CountDownLatch(1), secondStarted = new CountDownLatch(1);
            ExecutorService owner = Executors.newSingleThreadExecutor();
            try {
                Future<RestoreCounts> result = owner.submit(() -> restoreFiles(new File(root, "pending"), Arrays.asList(a, b),
                    Collections.singletonList(resource(full, new RestoreSegment(a.hash, 0, a.size), new RestoreSegment(b.hash, 0, b.size))),
                    h -> file(root, h), (o, target) -> {
                        if (o == a) { firstStarted.countDown(); assertTrue(releaseFirst.await(5, TimeUnit.SECONDS)); }
                        else { secondStarted.countDown(); assertEquals(0L, releaseFirst.getCount()); }
                        Files.write(target.toPath(), o == a ? first : second);
                    }, false, (completed, total) -> {}, 3, 6));
                assertTrue(firstStarted.await(5, TimeUnit.SECONDS));
                assertFalse("next chunk exceeds the remaining byte budget", secondStarted.await(100, TimeUnit.MILLISECONDS));
                releaseFirst.countDown();
                assertEquals(2, result.get(5, TimeUnit.SECONDS).downloaded);
                assertArrayEquals(full, Files.readAllBytes(file(root, hash(full)).toPath()));
            } finally { releaseFirst.countDown(); owner.shutdownNow(); assertTrue(owner.awaitTermination(5, TimeUnit.SECONDS)); }
        }
    }

    @Test public void laterChunkFailureCancelsAndDrainsEarlierBlockedDownloadBeforeCleanup() throws Exception {
        File root = temporary.newFolder(), pending = new File(root, "pending");
        RestoreObject a = object(bytes("aaa")), b = object(bytes("bbb")), c = object(bytes("ccc"));
        CountDownLatch firstStarted = new CountDownLatch(1), firstFinished = new CountDownLatch(1);
        ExecutorService owner = Executors.newSingleThreadExecutor();
        try {
            Future<RestoreCounts> result = owner.submit(() -> restoreFiles(pending, Arrays.asList(a, b, c),
                Collections.singletonList(resource(bytes("aaabbbccc"), new RestoreSegment(a.hash, 0, 3),
                    new RestoreSegment(b.hash, 0, 3), new RestoreSegment(c.hash, 0, 3))),
                h -> file(root, h), (o, target) -> {
                    if (o == a) {
                        firstStarted.countDown();
                        try { new CountDownLatch(1).await(); }
                        finally { Files.write(target.toPath(), bytes("late")); firstFinished.countDown(); }
                    } else if (o == b) {
                        assertTrue(firstStarted.await(5, TimeUnit.SECONDS));
                        throw new IOException("second chunk failed");
                    } else Files.write(target.toPath(), bytes("ccc"));
                }));
            try { result.get(5, TimeUnit.SECONDS); fail("must reject"); }
            catch (ExecutionException expected) { assertEquals("second chunk failed", expected.getCause().getMessage()); }
            assertEquals(0L, firstFinished.getCount());
            assertEquals("cleanup must happen after the late writer exits", 0, root.listFiles().length);
        } finally { owner.shutdownNow(); assertTrue(owner.awaitTermination(5, TimeUnit.SECONDS)); }
    }

    @Test public void ownerCancellationStopsAllPrefetchAndPreservesOnlyResumableCheckpoints() throws Exception {
        for (boolean resumable : new boolean[] { false, true }) {
            File root = temporary.newFolder(), pending = new File(root, "pending"); pending.mkdir();
            File unknown = new File(pending, "unknown.part"); Files.write(unknown.toPath(), bytes("keep"));
            List<RestoreObject> objects = Arrays.asList(object(bytes("aaa")), object(bytes("bbb")), object(bytes("ccc")), object(bytes("ddd")));
            RestoreResource plan = resource(bytes("aaabbbcccddd"), objects.stream()
                .map(o -> new RestoreSegment(o.hash, 0, o.size)).toArray(RestoreSegment[]::new));
            CountDownLatch started = new CountDownLatch(3), finished = new CountDownLatch(1);
            AtomicReference<Thread> ownerThread = new AtomicReference<>();
            AtomicInteger active = new AtomicInteger(), downloads = new AtomicInteger();
            ExecutorService owner = Executors.newSingleThreadExecutor();
            try {
                Future<RestoreCounts> result = owner.submit(() -> {
                    ownerThread.set(Thread.currentThread());
                    try {
                        return restoreFiles(pending, objects, Collections.singletonList(plan), h -> file(root, h), (o, target) -> {
                            active.incrementAndGet(); downloads.incrementAndGet(); started.countDown();
                            try { new CountDownLatch(1).await(); }
                            finally { Files.write(target.toPath(), bytes("x")); active.decrementAndGet(); }
                        }, resumable, (completed, total) -> {});
                    } finally { finished.countDown(); }
                });
                assertTrue(started.await(5, TimeUnit.SECONDS));
                ownerThread.get().interrupt();
                assertTrue(finished.await(5, TimeUnit.SECONDS));
                try { result.get(5, TimeUnit.SECONDS); fail("must cancel"); }
                catch (ExecutionException expected) { assertTrue(expected.getCause() instanceof InterruptedException); }
                assertEquals(3, downloads.get()); assertEquals(0, active.get());
                assertFalse(file(root, plan.hash).exists());
                assertEquals(resumable ? 4 : 1, pending.listFiles().length);
                assertArrayEquals(bytes("keep"), Files.readAllBytes(unknown.toPath()));
            } finally { owner.shutdownNow(); assertTrue(owner.awaitTermination(5, TimeUnit.SECONDS)); }
        }
    }

    @Test public void corruptCachedCheckpointIsRevalidatedAndSharedPackLivesUntilLastInstalledResource() throws Exception {
        File root = temporary.newFolder(), pending = new File(root, "pending"); pending.mkdir();
        byte[] pack = bytes("aaabbb"); RestoreObject object = object(pack);
        File checkpoint = new File(pending, object.hash + ".chunk.part");
        Files.write(checkpoint.toPath(), bytes("xxxxxx"));
        AtomicInteger downloads = new AtomicInteger();
        RestoreCounts result = restoreFiles(pending, Collections.singletonList(object), Arrays.asList(
            resource(bytes("aaa"), new RestoreSegment(object.hash, 0, 3)),
            resource(bytes("bbb"), new RestoreSegment(object.hash, 3, 3))), h -> file(root, h), (o, target) -> {
                downloads.incrementAndGet(); Files.write(target.toPath(), pack);
            }, true, (completed, total) -> {
                if (completed == 1) assertTrue(checkpoint.isFile());
                if (completed == 2) assertFalse(checkpoint.exists());
            });
        assertEquals(1, downloads.get()); assertEquals(1, result.downloaded); assertEquals(2, result.assembled);
        assertArrayEquals(bytes("aaa"), Files.readAllBytes(file(root, hash(bytes("aaa"))).toPath()));
        assertArrayEquals(bytes("bbb"), Files.readAllBytes(file(root, hash(bytes("bbb"))).toPath()));
        assertFalse(pending.exists());
    }

    @Test public void serialPrefetchFallbackKeepsTheSameVerifiedOutput() throws Exception {
        File root = temporary.newFolder(); byte[] first = bytes("first"), second = bytes("second"), full = bytes("firstsecond");
        RestoreObject a = object(first), b = object(second);
        AtomicInteger ordinal = new AtomicInteger();
        RestoreCounts result = restoreFiles(new File(root, "pending"), Arrays.asList(a, b),
            Collections.singletonList(resource(full, new RestoreSegment(a.hash, 0, a.size), new RestoreSegment(b.hash, 0, b.size))),
            h -> file(root, h), (o, target) -> {
                assertSame(ordinal.getAndIncrement() == 0 ? a : b, o);
                Files.write(target.toPath(), o == a ? first : second);
            }, false, (completed, total) -> {}, 1, 1);
        assertEquals(2, result.downloaded);
        assertArrayEquals(full, Files.readAllBytes(file(root, hash(full)).toPath()));
    }

    private static final class HttpFixture implements AutoCloseable {
        final java.net.ServerSocket server = new java.net.ServerSocket(0, 1, java.net.InetAddress.getLoopbackAddress());
        final java.util.concurrent.CompletableFuture<Void> response;
        volatile String range;
        HttpFixture(int status, String contentRange, byte[] body) throws Exception {
            response = java.util.concurrent.CompletableFuture.runAsync(() -> {
                try (java.net.Socket client = server.accept()) {
                    java.io.BufferedReader input = new java.io.BufferedReader(new java.io.InputStreamReader(client.getInputStream(), StandardCharsets.UTF_8));
                    String line;
                    while ((line = input.readLine()) != null && !line.isEmpty()) {
                        if (line.startsWith("Range: ")) range = line.substring(7);
                    }
                    String headers = "HTTP/1.1 " + status + " OK\r\nContent-Length: " + body.length + "\r\nConnection: close\r\n"
                        + (contentRange == null ? "" : "Content-Range: " + contentRange + "\r\n") + "\r\n";
                    client.getOutputStream().write(headers.getBytes(StandardCharsets.UTF_8));
                    client.getOutputStream().write(body);
                    client.getOutputStream().flush();
                } catch (IOException error) { throw new java.util.concurrent.CompletionException(error); }
            });
        }
        String url() { return "http://127.0.0.1:" + server.getLocalPort() + "/object"; }
        @Override public void close() throws Exception {
            try { response.get(5, java.util.concurrent.TimeUnit.SECONDS); } finally { server.close(); }
        }
    }

    @Test public void realHttpResumeAppendsOnlyTheMissingSuffixAndVerifiesTheWholeFile() throws Exception {
        byte[] full = bytes("firstsecond"); File target = temporary.newFile();
        Files.write(target.toPath(), bytes("first"));
        try (HttpFixture server = new HttpFixture(206, "bytes 5-10/11", bytes("second"))) {
            downloadRestoreObject("github", server.url(), "test-token", "", hash(full), full.length, target);
            assertEquals("bytes=5-", server.range);
            assertArrayEquals(full, Files.readAllBytes(target.toPath()));
        }
    }

    @Test public void realHttpIgnoredRangeReplacesThePrefixWithoutDuplicatingBytes() throws Exception {
        byte[] full = bytes("firstsecond"); File target = temporary.newFile();
        Files.write(target.toPath(), bytes("first"));
        try (HttpFixture server = new HttpFixture(200, null, full)) {
            downloadRestoreObject("github", server.url(), "test-token", "", hash(full), full.length, target);
            assertArrayEquals(full, Files.readAllBytes(target.toPath()));
        }
    }
    @Test public void nativeVerifiedDownloaderStillRejectsCorruptNetworkBytesBeforeInstall() throws Exception {
        File root = temporary.newFolder(); byte[] full = bytes("good");
        try (HttpFixture server = new HttpFixture(200, null, bytes("evil"))) {
            RestoreObject object = new RestoreObject(hash(full), full.length, server.url());
            try {
                restoreFiles(new File(root, "pending"), Collections.singletonList(object),
                    Collections.singletonList(resource(full, new RestoreSegment(object.hash, 0, object.size))),
                    h -> file(root, h), nativeDownloader("github", "test-token", "", call -> {}));
                fail("native download must check SHA before returning a verified result");
            } catch (IllegalStateException expected) { assertTrue(expected.getMessage().contains("SHA-256")); }
            assertEquals(0, root.listFiles().length);
        }
    }

    @Test public void missingNativeHttpObjectPreservesItsStatusAndInstallsNothing() throws Exception {
        File root = temporary.newFolder(); byte[] full = bytes("good");
        try (HttpFixture server = new HttpFixture(404, null, bytes("missing"))) {
            RestoreObject object = new RestoreObject(hash(full), full.length, server.url());
            try {
                restoreFiles(new File(root, "pending"), Collections.singletonList(object),
                    Collections.singletonList(resource(full, new RestoreSegment(object.hash, 0, object.size))),
                    h -> file(root, h), nativeDownloader("github", "test-token", "", call -> {}));
                fail("missing object must fail closed");
            } catch (CloudHttpStatusException expected) { assertEquals(404, expected.status); }
            assertEquals(0, root.listFiles().length);
        }
    }

    @Test public void nativeVerifiedDownloaderResumesThenAssemblesThePersistedRange() throws Exception {
        File root = temporary.newFolder(), pending = new File(root, "pending"); pending.mkdir();
        byte[] full = bytes("firstsecond");
        File checkpoint = new File(pending, hash(full) + ".chunk.part");
        Files.write(checkpoint.toPath(), bytes("first"));
        try (HttpFixture server = new HttpFixture(206, "bytes 5-10/11", bytes("second"))) {
            RestoreObject object = new RestoreObject(hash(full), full.length, server.url());
            RestoreCounts result = restoreFiles(pending, Collections.singletonList(object),
                Collections.singletonList(resource(bytes("second"), new RestoreSegment(object.hash, 5, 6))),
                h -> file(root, h), nativeDownloader("github", "test-token", "", call -> {}), true, (completed, total) -> {});
            assertEquals(1, result.downloaded); assertEquals("bytes=5-", server.range);
            assertArrayEquals(bytes("second"), Files.readAllBytes(file(root, hash(bytes("second"))).toPath()));
            assertFalse(pending.exists());
        }
    }

    private static final class BlockingHttpFixture implements AutoCloseable {
        final java.net.ServerSocket server = new java.net.ServerSocket(0, 3, java.net.InetAddress.getLoopbackAddress());
        final CountDownLatch started = new CountDownLatch(3), disconnected = new CountDownLatch(3);
        final ExecutorService handlers = Executors.newFixedThreadPool(4);
        final java.util.List<java.net.Socket> sockets = Collections.synchronizedList(new java.util.ArrayList<>());
        final Future<?> accepting;
        BlockingHttpFixture() throws Exception {
            accepting = handlers.submit(() -> {
                try {
                    for (int index = 0; index < 3; index++) {
                        java.net.Socket client = server.accept(); sockets.add(client);
                        handlers.submit(() -> {
                            try (java.net.Socket connection = client) {
                                java.io.BufferedReader input = new java.io.BufferedReader(new java.io.InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8));
                                String line;
                                while ((line = input.readLine()) != null && !line.isEmpty()) {}
                                connection.getOutputStream().write(("HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nx").getBytes(StandardCharsets.UTF_8));
                                connection.getOutputStream().flush();
                                started.countDown();
                                while (input.read() != -1) {}
                                disconnected.countDown();
                            } catch (IOException error) { throw new java.io.UncheckedIOException(error); }
                        });
                    }
                } catch (IOException error) { throw new java.io.UncheckedIOException(error); }
            });
        }
        String url() { return "http://127.0.0.1:" + server.getLocalPort() + "/object"; }
        @Override public void close() throws Exception {
            server.close();
            synchronized (sockets) { for (java.net.Socket socket : sockets) socket.close(); }
            handlers.shutdownNow();
            assertTrue(handlers.awaitTermination(5, TimeUnit.SECONDS));
        }
    }

    @Test public void cancellingNativePrefetchClosesEveryBlockedHttpCall() throws Exception {
        File root = temporary.newFolder(), pending = new File(root, "pending");
        ExecutorService owner = Executors.newSingleThreadExecutor();
        AtomicReference<Thread> ownerThread = new AtomicReference<>();
        try (BlockingHttpFixture server = new BlockingHttpFixture()) {
            RestoreObject a = new RestoreObject(hash(bytes("aaa")), 3, server.url());
            RestoreObject b = new RestoreObject(hash(bytes("bbb")), 3, server.url());
            RestoreObject c = new RestoreObject(hash(bytes("ccc")), 3, server.url());
            Future<RestoreCounts> result = owner.submit(() -> {
                ownerThread.set(Thread.currentThread());
                return restoreFiles(pending, Arrays.asList(a, b, c),
                    Collections.singletonList(resource(bytes("aaabbbccc"), new RestoreSegment(a.hash, 0, 3),
                        new RestoreSegment(b.hash, 0, 3), new RestoreSegment(c.hash, 0, 3))),
                    h -> file(root, h), nativeDownloader("github", "test-token", "", call -> {}), true, (completed, total) -> {});
            });
            assertTrue(server.started.await(5, TimeUnit.SECONDS));
            ownerThread.get().interrupt();
            try { result.get(5, TimeUnit.SECONDS); fail("must interrupt"); }
            catch (ExecutionException expected) { assertTrue(expected.getCause() instanceof InterruptedException); }
            assertTrue("all three sockets must close, not just the last active call", server.disconnected.await(5, TimeUnit.SECONDS));
            File[] remaining = pending.listFiles();
            // Cancellation may win before the client opens any checkpoint. If bytes reached
            // disk, only resumable chunks may remain; the generic cancellation test forces
            // late checkpoint writes and verifies those files are always retained.
            if (remaining != null) for (File checkpoint : remaining) {
                assertTrue(checkpoint.getName().endsWith(".chunk.part"));
                assertTrue(checkpoint.length() < 3);
            }
            assertFalse(file(root, hash(bytes("aaabbbccc"))).exists());
        } finally { owner.shutdownNow(); assertTrue(owner.awaitTermination(5, TimeUnit.SECONDS)); }
    }

}
