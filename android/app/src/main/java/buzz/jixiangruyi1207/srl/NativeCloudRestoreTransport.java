package buzz.jixiangruyi1207.srl;

import android.util.Base64;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorCompletionService;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.UUID;


final class NativeCloudRestoreTransport {
    static final int RESTORE_BUFFER_BYTES = 256 * 1024;
    static final int RESTORE_PREFETCH_CONCURRENCY = 3;
    // Planned stored bytes in the unconsumed window, not a heap or total-checkpoint disk cap.
    static final long RESTORE_PREFETCH_BYTES = 64L * 1024 * 1024;
    static final class IntegrityException extends IOException {
        IntegrityException(String message) { super(message); }
    }
    interface ObjectLocator { File locate(String hash) throws Exception; }
    /** Called concurrently for distinct hashes; implementations must honor interruption. */
    interface ObjectDownloader { void download(RestoreObject object, File temporary) throws Exception; }
    interface CancellableDownloader extends ObjectDownloader { void cancel(); }
    /** Invocation-local proof; persisted chunks still require full verification on reopen. */
    interface VerifiedDownloader extends CancellableDownloader {}
    interface RestoreProgress { void update(int completed, int total) throws Exception; }

    static final class RestoreObject {
        final String hash;
        final long size;
        final String url;
        RestoreObject(String hash, long size, String url) {
            this.hash = hash; this.size = size; this.url = url;
        }
    }

    static final class RestoreSegment {
        final String hash;
        final long offset;
        final long size;
        RestoreSegment(String hash, long offset, long size) {
            this.hash = hash; this.offset = offset; this.size = size;
        }
    }

    static final class RestoreResource {
        final String hash;
        final long size;
        final List<RestoreSegment> segments;
        RestoreResource(String hash, long size, List<RestoreSegment> segments) {
            this.hash = hash; this.size = size; this.segments = segments;
        }
    }

    static final class RestoreCounts {
        int downloaded;
        int reused;
        int assembled;
        final Map<String, String> failures = new java.util.LinkedHashMap<>();
    }

    interface ResourceCompletion { void complete(String hash, String error) throws Exception; }
    private static final java.util.concurrent.Semaphore DOWNLOAD_SLOTS = new java.util.concurrent.Semaphore(3, true);

    /** Independent files finish fairly; each file still uses the existing verified/resumable assembler. */
    static RestoreCounts restoreIncrementally(File root, List<RestoreObject> objects, List<RestoreResource> resources,
        ObjectLocator locator, java.util.function.Supplier<ObjectDownloader> downloader, RestoreProgress progress,
        ResourceCompletion completion) throws Exception {
        Map<String, RestoreObject> objectIndex = validatePlan(objects, resources);
        Map<String, RestoreResource> unique = new java.util.LinkedHashMap<>();
        for (RestoreResource resource : resources) unique.putIfAbsent(resource.hash, resource);
        ExecutorService executor = Executors.newFixedThreadPool(3);
        ExecutorCompletionService<RestoreCounts> ready = new ExecutorCompletionService<>(executor);
        Map<Future<RestoreCounts>, RestoreResource> pending = new HashMap<>();
        java.util.Iterator<RestoreResource> queue = unique.values().iterator();
        RestoreCounts total = new RestoreCounts();
        NativeCloudSharedRestoreDownloads shared = new NativeCloudSharedRestoreDownloads(root,
            new java.util.ArrayList<>(unique.values()), downloader);
        boolean successful = false;
        int processed = 0;
        try {
            while (queue.hasNext() || !pending.isEmpty()) {
                if (Thread.currentThread().isInterrupted()) throw new InterruptedException("云恢复已取消");
                while (queue.hasNext() && pending.size() < 3) {
                    RestoreResource resource = queue.next();
                    pending.put(ready.submit(() -> {
                        Map<String, RestoreObject> needed = new java.util.LinkedHashMap<>();
                        for (RestoreSegment segment : resource.segments) needed.put(segment.hash, objectIndex.get(segment.hash));
                        return restoreFiles(new File(root, resource.hash), new java.util.ArrayList<>(needed.values()),
                            java.util.Collections.singletonList(resource), locator, shared.forResource(), true, (done, count) -> {});
                    }), resource);
                }
                Future<RestoreCounts> future = ready.take();
                RestoreResource resource = pending.remove(future);
                String failure = null;
                try {
                    RestoreCounts result = future.get();
                    total.downloaded += result.downloaded; total.reused += result.reused; total.assembled += result.assembled;
                } catch (ExecutionException error) {
                    Throwable cause = error.getCause();
                    if (cause instanceof InterruptedException || cause instanceof java.io.InterruptedIOException) {
                        // Socket timeouts are a file failure; explicit owner interruption stops the queue.
                        if (Thread.currentThread().isInterrupted() || cause instanceof InterruptedException) throw new InterruptedException("云恢复已取消");
                    }
                    failure = cause.getMessage() == null ? "原件恢复失败" : cause.getMessage();
                    total.failures.put(resource.hash, failure);
                }
                completion.complete(resource.hash, failure);
                progress.update(++processed, unique.size());
            }
            total.downloaded = shared.downloaded.get();
            successful = total.failures.isEmpty();
            return total;
        } finally {
            shared.cancel();
            for (Future<RestoreCounts> future : pending.keySet()) future.cancel(true);
            executor.shutdownNow();
            boolean interrupted = false;
            while (!executor.isTerminated()) {
                try { executor.awaitTermination(1, TimeUnit.DAYS); }
                catch (InterruptedException stopped) { interrupted = true; }
            }
            if (interrupted) Thread.currentThread().interrupt();
            shared.finish(successful);
        }
    }

    /** Transport chunks belong to this invocation, never to the formal resource object store.
     * The caller supplies the existing NativeLibrary content-addressed locator (no second index).
     * Existing originals and legacy chunks are verified only when needed, not by a full-disk scan.
     */
    static RestoreCounts restoreFiles(
        File pendingRoot, List<RestoreObject> objects, List<RestoreResource> resources,
        ObjectLocator locator, ObjectDownloader downloader
    ) throws Exception {
        return restoreFiles(pendingRoot, objects, resources, locator, downloader, false, (completed, total) -> {});
    }

    static RestoreCounts restoreFiles(
        File pendingRoot, List<RestoreObject> objects, List<RestoreResource> resources,
        ObjectLocator locator, ObjectDownloader downloader, boolean resumable, RestoreProgress progress
    ) throws Exception {
        return restoreFiles(pendingRoot, objects, resources, locator, downloader, resumable, progress,
            RESTORE_PREFETCH_CONCURRENCY, RESTORE_PREFETCH_BYTES);
    }

    static RestoreCounts restoreFiles(
        File pendingRoot, List<RestoreObject> objects, List<RestoreResource> resources,
        ObjectLocator locator, ObjectDownloader downloader, boolean resumable, RestoreProgress progress,
        int concurrency, long prefetchBytes
    ) throws Exception {
        if (concurrency < 1 || concurrency > RESTORE_PREFETCH_CONCURRENCY || prefetchBytes < 1) {
            throw new IllegalArgumentException("原生恢复预读预算无效");
        }
        Map<String, RestoreObject> byHash = validatePlan(objects, resources);
        Map<String, Integer> remainingUses = new HashMap<>();
        for (RestoreResource resource : resources) for (RestoreSegment segment : resource.segments) {
            remainingUses.put(segment.hash, remainingUses.getOrDefault(segment.hash, 0) + 1);
        }
        File taskRoot = resumable ? pendingRoot : new File(pendingRoot, UUID.randomUUID().toString());
        if (!taskRoot.isDirectory() && !taskRoot.mkdirs()) throw new IOException("无法创建原生恢复任务暂存目录");
        if (resumable) {
            File[] abandoned = taskRoot.listFiles(file -> file.isFile() && file.getName().matches("[a-f0-9-]{36}\\.resource\\.part"));
            if (abandoned != null) for (File file : abandoned) {
                if (!file.delete()) throw new IllegalStateException("无法清理已中断的原件拼装文件");
            }
        }
        Set<File> ownedFiles = new HashSet<>();
        if (resumable) for (RestoreObject object : objects) ownedFiles.add(new File(taskRoot, object.hash + ".chunk.part"));
        Map<String, File> verified = new HashMap<>();
        RestoreCounts counts = new RestoreCounts();
        boolean successful = false;
        int completed = 0;
        // Close/drain the workers before deleting any file they may still be writing.
        try (ChunkPrefetch prefetch = new ChunkPrefetch(taskRoot, byHash, locator, downloader,
                verified, ownedFiles, concurrency, prefetchBytes, resources)) {
            for (RestoreResource resource : resources) {
                prefetch.checkRunning();
                progress.update(completed, resources.size());
                File destination = locator.locate(resource.hash);
                if (prefetch.isInstalled(resource)) {
                    counts.reused++;
                    releaseCompletedChunks(resource, remainingUses, verified, ownedFiles);
                    progress.update(++completed, resources.size());
                    continue;
                }
                File temporary = new File(taskRoot, UUID.randomUUID() + ".resource.part");
                ownedFiles.add(temporary);
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                long written = 0;
                try (FileOutputStream output = new FileOutputStream(temporary)) {
                    byte[] buffer = new byte[RESTORE_BUFFER_BYTES];
                    for (RestoreSegment segment : resource.segments) {
                        prefetch.fill();
                        File source = verified.get(segment.hash);
                        if (source == null) {
                            PreparedChunk chunk = prefetch.take(segment.hash);
                            source = chunk.file;
                            if (chunk.downloaded) counts.downloaded++; else counts.reused++;
                            verified.put(segment.hash, source);
                        }
                        written += copyRange(source, segment.offset, segment.size, output, digest, buffer, prefetch);
                        prefetch.consumed(segment.hash);
                    }
                    output.getFD().sync();
                }
                prefetch.checkRunning();
                if (written != resource.size || !resource.hash.equals(hex(digest.digest()))) {
                    throw new IntegrityException("原生恢复资源大小或 SHA-256 校验失败");
                }
                installRestoredObject(temporary, destination, resource.size);
                prefetch.installed.put(resource.hash, true);
                counts.assembled++;
                // Keep all chunks of an unfinished resource for resume. Only release task-owned
                // chunks after the original is installed and no later resource needs them.
                releaseCompletedChunks(resource, remainingUses, verified, ownedFiles);
                progress.update(++completed, resources.size());
            }
            successful = true;
            return counts;
        } finally {
            for (File file : ownedFiles) {
                if (file.isFile() && (!resumable || successful || !file.getName().endsWith(".chunk.part"))) file.delete();
            }
            deleteEmptyDirectory(taskRoot);
            deleteEmptyDirectory(pendingRoot);
        }
    }

    private static void releaseCompletedChunks(RestoreResource resource, Map<String, Integer> remainingUses,
        Map<String, File> verified, Set<File> ownedFiles) {
        for (RestoreSegment segment : resource.segments) {
            int remaining = remainingUses.get(segment.hash) - 1;
            remainingUses.put(segment.hash, remaining);
            if (remaining != 0) continue;
            File file = verified.remove(segment.hash);
            if (file != null && ownedFiles.contains(file)) file.delete();
        }
    }

    private static final class PreparedChunk {
        final File file;
        final boolean downloaded;
        PreparedChunk(File file, boolean downloaded) { this.file = file; this.downloaded = downloaded; }
    }

    /** Missing originals share a bounded look-ahead window; existing originals never trigger
     * speculative downloads. Results are consumed in descriptor order, regardless of completion order.
     * Each stream hashes/copies with a fixed buffer. An oversized legacy chunk is admitted alone.
     */
    private static final class ChunkPrefetch implements AutoCloseable {
        final File root;
        final Map<String, RestoreObject> objects;
        final ObjectLocator locator;
        final ObjectDownloader downloader;
        final Map<String, File> verified;
        final Set<File> owned;
        final int concurrency;
        final long budget;
        final ExecutorService executor;
        final ExecutorCompletionService<PreparedChunk> completions;
        final Map<String, Future<PreparedChunk>> pending = new HashMap<>();
        final AtomicReference<Throwable> failure = new AtomicReference<>();
        final List<RestoreResource> resources;
        final Map<String, Boolean> installed = new HashMap<>();
        int nextResource;
        int next;
        long reserved;

        ChunkPrefetch(File root, Map<String, RestoreObject> objects, ObjectLocator locator,
            ObjectDownloader downloader, Map<String, File> verified, Set<File> owned,
            int concurrency, long budget, List<RestoreResource> resources) {
            this.root = root; this.objects = objects; this.locator = locator; this.downloader = downloader;
            this.verified = verified; this.owned = owned; this.concurrency = concurrency; this.budget = budget;
            this.resources = resources;
            executor = Executors.newFixedThreadPool(concurrency);
            completions = new ExecutorCompletionService<>(executor);
        }

        boolean isInstalled(RestoreResource resource) throws Exception {
            Boolean ready = installed.get(resource.hash);
            if (ready == null) {
                ready = verifyFile(locator.locate(resource.hash), resource.hash, resource.size);
                installed.put(resource.hash, ready);
            }
            return ready;
        }

        void checkRunning() throws Exception {
            Throwable error = failure.get();
            if (error instanceof Exception) throw (Exception) error;
            if (error instanceof Error) throw (Error) error;
            if (Thread.currentThread().isInterrupted()) throw new InterruptedException("云恢复已暂停");
        }

        void fill() throws Exception {
            checkRunning();
            while (nextResource < resources.size()) {
                // One bounded window spans selected files, including one-chunk small files.
                if (pending.size() >= concurrency || (!pending.isEmpty() && reserved >= budget)) break;
                RestoreResource resource = resources.get(nextResource);
                if (next == 0 && isInstalled(resource)) { nextResource++; continue; }
                List<RestoreSegment> segments = resource.segments;
                if (next >= segments.size()) { nextResource++; next = 0; continue; }
                RestoreObject object = objects.get(segments.get(next).hash);
                if (verified.containsKey(object.hash) || pending.containsKey(object.hash)) { next++; continue; }
                if (pending.size() >= concurrency || (!pending.isEmpty() && object.size > budget - reserved)) break;
                // Resolve paths and register ownership on the caller thread, before starting IO.
                File legacy = locator.locate(object.hash);
                File target = new File(root, object.hash + ".chunk.part");
                owned.add(target);
                checkRunning();
                Future<PreparedChunk> future;
                try {
                    future = completions.submit(() -> {
                        try {
                            if (Thread.currentThread().isInterrupted()) throw new InterruptedException("云恢复已暂停");
                            if (verifyFile(legacy, object.hash, object.size)) return new PreparedChunk(legacy, false);
                            if (verifyFile(target, object.hash, object.size)) return new PreparedChunk(target, false);
                            downloader.download(object, target);
                            if (Thread.currentThread().isInterrupted()) throw new InterruptedException("云恢复已暂停");
                            // The native downloader validates the full network/prefix stream itself.
                            // Assembly still hashes persisted source bytes before any installation.
                            // Arbitrary downloaders have no such proof and retain the full file check.
                            boolean valid = downloader instanceof VerifiedDownloader
                                ? isReusableCasObject(target, object.size) : verifyFile(target, object.hash, object.size);
                            if (!valid) {
                                target.delete();
                                throw new IntegrityException("原生恢复对象大小或 SHA-256 校验失败");
                            }
                            return new PreparedChunk(target, true);
                        } catch (Exception | Error error) {
                            failure.compareAndSet(null, error);
                            cancelDownloads();
                            executor.shutdownNow();
                            throw error;
                        }
                    });
                } catch (RejectedExecutionException rejected) { checkRunning(); throw rejected; }
                pending.put(object.hash, future);
                reserved += object.size;
                next++;
                checkRunning();
            }
        }

        PreparedChunk take(String hash) throws Exception {
            try {
                Future<PreparedChunk> requested = pending.get(hash);
                checkRunning();
                // A later chunk failure must wake the owner even while an earlier chunk is blocked.
                while (!requested.isDone()) {
                    completions.take();
                    checkRunning();
                }
                PreparedChunk result = requested.get();
                while (completions.poll() != null) {} // Never accumulate one receipt per snapshot chunk.
                checkRunning();
                return result;
            } catch (ExecutionException error) {
                checkRunning();
                throw new IOException("原生恢复对象预读失败", error.getCause());
            }
        }

        void consumed(String hash) {
            if (pending.remove(hash) != null) reserved -= objects.get(hash).size;
        }

        void cancelDownloads() {
            if (downloader instanceof CancellableDownloader) ((CancellableDownloader) downloader).cancel();
        }

        @Override public void close() {
            cancelDownloads();
            for (Future<PreparedChunk> future : pending.values()) future.cancel(true);
            executor.shutdownNow();
            boolean interrupted = false;
            while (!executor.isTerminated()) {
                try { executor.awaitTermination(1, TimeUnit.DAYS); }
                catch (InterruptedException stop) { interrupted = true; }
            }
            if (interrupted) Thread.currentThread().interrupt();
        }
    }

    static ObjectDownloader nativeDownloader(String provider, String secret, String username,
        java.util.function.Consumer<okhttp3.Call> onCall) {
        return new NativeObjectDownloader(provider, secret, username, onCall);
    }

    /** Invocation-scoped cancellation and verification proof, never a persisted trust flag. */
    private static final class NativeObjectDownloader implements VerifiedDownloader {
        final String provider, secret, username;
        final java.util.function.Consumer<okhttp3.Call> onCall;
        final Set<okhttp3.Call> calls = new HashSet<>();
        boolean cancelled;
        NativeObjectDownloader(String provider, String secret, String username,
            java.util.function.Consumer<okhttp3.Call> onCall) {
            this.provider = provider; this.secret = secret; this.username = username; this.onCall = onCall;
        }
        @Override public void download(RestoreObject object, File target) throws Exception {
            AtomicReference<okhttp3.Call> active = new AtomicReference<>();
            DOWNLOAD_SLOTS.acquire();
            try {
                downloadRestoreObject(provider, object.url, secret, username, object.hash, object.size, target, call -> {
                    active.set(call);
                    synchronized (this) {
                        if (cancelled) call.cancel(); else calls.add(call);
                    }
                    onCall.accept(call);
                });
            } finally {
                DOWNLOAD_SLOTS.release();
                synchronized (this) { calls.remove(active.get()); }
            }
        }
        public synchronized void cancel() {
            cancelled = true;
            for (okhttp3.Call call : calls) call.cancel();
        }
    }

    static Map<String, RestoreObject> validatePlan(List<RestoreObject> objects, List<RestoreResource> resources) {
        Map<String, RestoreObject> byHash = new HashMap<>();
        for (RestoreObject object : objects) {
            if (object.size < 0) throw new IllegalArgumentException("原生恢复对象大小无效");
            RestoreObject previous = byHash.put(object.hash, object);
            if (previous != null && previous.size != object.size) {
                throw new IllegalArgumentException("原生恢复对象的重复声明不一致");
            }
        }
        // Validate all ranges before any download or installation, including already-local resources.
        for (RestoreResource resource : resources) {
            long total = 0;
            for (RestoreSegment segment : resource.segments) {
                RestoreObject object = byHash.get(segment.hash);
                if (object == null || segment.offset < 0 || segment.size < 0
                    || segment.offset > object.size || segment.size > object.size - segment.offset
                    || segment.size > resource.size - total) {
                    throw new IllegalArgumentException("原生恢复资源分段范围无效");
                }
                total += segment.size;
            }
            if (total != resource.size) throw new IllegalArgumentException("原生恢复资源分段总量不一致");
        }
        return byHash;
    }

    static void validateRestoreUri(String provider, URI uri, String webDavHost) {
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null) {
            throw new IllegalArgumentException("原生恢复对象只允许 HTTPS 地址");
        }
        if ("github".equals(provider) && !"api.github.com".equalsIgnoreCase(uri.getHost())) {
            throw new IllegalArgumentException("GitHub 原生恢复对象地址无效");
        }
        if ("webdav".equals(provider) && !webDavHost.equalsIgnoreCase(uri.getHost())) {
            throw new IllegalArgumentException("WebDAV 原生恢复对象地址与配置不一致");
        }
    }

    static void downloadRestoreObject(
        String provider,
        String url,
        String secret,
        String webDavUsername,
        String expectedHash,
        long expectedSize,
        File temporary
    ) throws Exception {
        downloadRestoreObject(provider, url, secret, webDavUsername, expectedHash, expectedSize, temporary, call -> {});
    }

    static void downloadRestoreObject(
        String provider, String url, String secret, String webDavUsername, String expectedHash,
        long expectedSize, File temporary, java.util.function.Consumer<okhttp3.Call> onCall
    ) throws Exception {
        if (temporary.isFile() && temporary.length() >= expectedSize) {
            if (verifyFile(temporary, expectedHash, expectedSize)) return;
            if (!temporary.delete()) throw new IllegalStateException("无法清理损坏的恢复断点");
        }
        long offset = temporary.isFile() ? temporary.length() : 0;
        Request.Builder request = new Request.Builder().url(url).get();
        request.header("Accept-Encoding", "identity");
        if (offset > 0) request.header("Range", "bytes=" + offset + "-");
        if ("github".equals(provider)) {
            request.header("Accept", "application/octet-stream");
            request.header("Authorization", "Bearer " + secret);
            request.header("X-GitHub-Api-Version", "2022-11-28");
        } else {
            String credentials = webDavUsername + ":" + secret;
            request.header(
                "Authorization",
                "Basic " + Base64.encodeToString(credentials.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP)
            );
        }
        okhttp3.Call call = NativeHttpClients.CLOUD.newCall(request.build());
        onCall.accept(call);
        try (Response response = call.execute()) {
            if (!response.isSuccessful()) {
                throw new CloudHttpStatusException(response.code(), "原生恢复对象下载失败（" + response.code() + "）");
            }
            ResponseBody body = response.body();
            if (body == null) throw new IOException("原生恢复对象响应为空");
            offset = restoreResponseOffset(response.code(), response.header("Content-Range"), offset, expectedSize);
            long declaredSize = body.contentLength();
            if (declaredSize >= 0 && declaredSize != expectedSize - offset) {
                throw new IllegalStateException("原生恢复对象远端大小不一致");
            }
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            if (offset > 0) try (FileInputStream prefix = new FileInputStream(temporary)) {
                byte[] buffer = new byte[RESTORE_BUFFER_BYTES];
                int count;
                while ((count = prefix.read(buffer)) >= 0) {
                    if (Thread.currentThread().isInterrupted()) throw new java.io.InterruptedIOException("云恢复已暂停");
                    digest.update(buffer, 0, count);
                }
            }
            long written = offset;
            try (InputStream input = body.byteStream(); FileOutputStream output = new FileOutputStream(temporary, offset > 0)) {
              try {
                byte[] buffer = new byte[RESTORE_BUFFER_BYTES];
                int count;
                while ((count = input.read(buffer)) >= 0) {
                    if (Thread.currentThread().isInterrupted()) throw new java.io.InterruptedIOException("云恢复已暂停");
                    if (written > expectedSize - count) {
                        temporary.delete();
                        throw new IllegalStateException("原生恢复对象超过声明大小");
                    }
                    output.write(buffer, 0, count);
                    digest.update(buffer, 0, count);
                    written += count;
                }
              } finally { output.getFD().sync(); }
            }
            if (written != expectedSize) throw new IOException("原生恢复对象下载中断；已保留断点");
            if (!expectedHash.equals(hex(digest.digest()))) {
                temporary.delete();
                throw new IllegalStateException("原生恢复对象大小或 SHA-256 校验失败");
            }
        }
    }

    /** A server may ignore Range with 200; only an exact suffix 206 can append bytes. */
    static long restoreResponseOffset(int status, String range, long offset, long size) {
        if (status == 200) return 0;
        if (status != 206 || range == null || offset < 0 || offset >= size) throw new IllegalStateException("原生恢复断点响应无效");
        java.util.regex.Matcher match = java.util.regex.Pattern.compile("bytes (\\d+)-(\\d+)/(\\d+)").matcher(range);
        try {
            if (!match.matches() || Long.parseLong(match.group(1)) != offset
                || Long.parseLong(match.group(2)) != size - 1 || Long.parseLong(match.group(3)) != size) {
                throw new IllegalStateException("原生恢复断点范围不一致");
            }
        } catch (NumberFormatException invalid) { throw new IllegalStateException("原生恢复断点范围无效", invalid); }
        return offset;
    }

    static boolean isReusableCasObject(File file, long expectedSize) {
        return file.isFile() && file.length() == expectedSize;
    }

    static boolean verifyFile(File file, String expectedHash, long expectedSize) throws Exception {
        if (!isReusableCasObject(file, expectedSize)) return false;
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (FileInputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[RESTORE_BUFFER_BYTES];
            int count;
            while ((count = input.read(buffer)) >= 0) {
                if (Thread.currentThread().isInterrupted()) throw new java.io.InterruptedIOException("云恢复已暂停");
                digest.update(buffer, 0, count);
            }
        }
        return expectedHash.equals(hex(digest.digest()));
    }

    static long copyRange(
        File source,
        long offset,
        long size,
        FileOutputStream output,
        MessageDigest digest,
        byte[] buffer
    ) throws Exception {
        return copyRange(source, offset, size, output, digest, buffer, null);
    }

    private static long copyRange(File source, long offset, long size, FileOutputStream output,
        MessageDigest digest, byte[] buffer, ChunkPrefetch prefetch) throws Exception {
        try (RandomAccessFile input = new RandomAccessFile(source, "r")) {
            input.seek(offset);
            long remaining = size;
            while (remaining > 0) {
                if (prefetch != null) prefetch.checkRunning();
                if (Thread.currentThread().isInterrupted()) throw new java.io.InterruptedIOException("云恢复已暂停");
                int count = input.read(buffer, 0, (int) Math.min(buffer.length, remaining));
                if (count < 0) throw new IOException("原生恢复资源分段被截断");
                output.write(buffer, 0, count);
                digest.update(buffer, 0, count);
                remaining -= count;
            }
        }
        return size;
    }

    static void installRestoredObject(File source, File destination, long expectedSize) throws Exception {
        File parent = destination.getParentFile();
        if (!parent.exists() && !parent.mkdirs()) throw new IOException("无法创建原生对象目录");
        if (destination.exists() && !destination.delete()) throw new IOException("无法替换异常原生对象");
        if (!source.renameTo(destination)) {
            try (FileInputStream input = new FileInputStream(source);
                 FileOutputStream output = new FileOutputStream(destination)) {
                byte[] buffer = new byte[RESTORE_BUFFER_BYTES];
                int count;
                while ((count = input.read(buffer)) >= 0) output.write(buffer, 0, count);
                output.getFD().sync();
            } catch (Exception error) {
                destination.delete();
                throw error;
            }
            source.delete();
        }
        if (!destination.isFile() || destination.length() != expectedSize) {
            destination.delete();
            throw new IOException("无法提交原生恢复对象");
        }
    }

    static void deleteEmptyDirectory(File directory) {
        File[] children = directory.listFiles();
        if (children != null && children.length == 0) directory.delete();
    }

    static String hex(byte[] bytes) { StringBuilder value = new StringBuilder(); for (byte item : bytes) value.append(String.format(Locale.ROOT, "%02x", item)); return value.toString(); }
    static final class CloudHttpStatusException extends IOException {
        final int status;
        CloudHttpStatusException(int status, String message) { super(message); this.status = status; }
    }
}
