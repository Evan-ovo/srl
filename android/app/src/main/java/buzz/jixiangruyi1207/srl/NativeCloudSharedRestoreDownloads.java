package buzz.jixiangruyi1207.srl;

import static buzz.jixiangruyi1207.srl.NativeCloudRestoreTransport.*;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Supplier;

/** Shared transport chunks belong only to one existing restore job, never to the library CAS. */
final class NativeCloudSharedRestoreDownloads {
    private static final class Entry { boolean verified; Exception failure; }
    private final File root;
    private final Supplier<ObjectDownloader> factory;
    private final Map<String, Entry> shared = new HashMap<>();
    private final Set<ObjectDownloader> active = new HashSet<>();
    private volatile boolean cancelled;
    final AtomicInteger downloaded = new AtomicInteger();

    NativeCloudSharedRestoreDownloads(File pending, List<RestoreResource> resources,
                                      Supplier<ObjectDownloader> factory) {
        this.root = new File(pending, "shared-chunks"); this.factory = factory;
        Map<String, Integer> uses = new HashMap<>();
        for (RestoreResource resource : resources) {
            Set<String> hashes = new HashSet<>();
            for (RestoreSegment segment : resource.segments) hashes.add(segment.hash);
            for (String hash : hashes) uses.put(hash, uses.getOrDefault(hash, 0) + 1);
        }
        for (Map.Entry<String, Integer> use : uses.entrySet())
            if (use.getValue() > 1) shared.put(use.getKey(), new Entry());
    }

    ObjectDownloader forResource() {
        final ObjectDownloader individual = factory.get();
        return new VerifiedDownloader() {
            @Override public void download(RestoreObject object, File target) throws Exception {
                Entry entry = shared.get(object.hash);
                if (entry == null) {
                    individual.download(object, target);
                    if (individual instanceof VerifiedDownloader
                        ? !target.isFile() || target.length() != object.size : !verifyFile(target, object.hash, object.size))
                        throw new IntegrityException("恢复分块校验失败");
                    downloaded.incrementAndGet();
                    return;
                }
                File source = new File(root, object.hash + ".chunk.part");
                synchronized (entry) {
                    checkRunning();
                    if (entry.failure != null) throw entry.failure;
                    if (!entry.verified) {
                        if (!root.isDirectory() && !root.mkdirs()) throw new IOException("无法创建恢复分块暂存目录");
                        if (!verifyFile(source, object.hash, object.size)) {
                            ObjectDownloader transfer = factory.get();
                            synchronized (active) { checkRunning(); active.add(transfer); }
                            try {
                                transfer.download(object, source);
                                if (transfer instanceof VerifiedDownloader
                                    ? !source.isFile() || source.length() != object.size : !verifyFile(source, object.hash, object.size))
                                    throw new IntegrityException("共享恢复分块校验失败");
                                downloaded.incrementAndGet();
                            } catch (Exception error) {
                                if (!Thread.currentThread().isInterrupted()) entry.failure = error;
                                throw error;
                            } finally { synchronized (active) { active.remove(transfer); } }
                        }
                        entry.verified = true;
                    }
                }
                checkRunning();
                try (FileInputStream input = new FileInputStream(source);
                     FileOutputStream output = new FileOutputStream(target)) {
                    byte[] buffer = new byte[RESTORE_BUFFER_BYTES]; int count;
                    while ((count = input.read(buffer)) != -1) {
                        checkRunning(); output.write(buffer, 0, count);
                    }
                    output.getFD().sync();
                }
            }
            @Override public void cancel() {
                if (individual instanceof CancellableDownloader) ((CancellableDownloader) individual).cancel();
            }
        };
    }

    private void checkRunning() throws InterruptedException {
        if (cancelled || Thread.currentThread().isInterrupted()) throw new InterruptedException("云恢复已取消");
    }

    void cancel() {
        synchronized (active) {
            cancelled = true;
            for (ObjectDownloader downloader : active)
                if (downloader instanceof CancellableDownloader) ((CancellableDownloader) downloader).cancel();
        }
    }

    void finish(boolean successful) {
        // Interrupted/failed jobs keep ordinary resumable files; next invocation re-verifies their SHA.
        if (!successful) return;
        for (String hash : shared.keySet()) new File(root, hash + ".chunk.part").delete();
        deleteEmptyDirectory(root);
    }
}
