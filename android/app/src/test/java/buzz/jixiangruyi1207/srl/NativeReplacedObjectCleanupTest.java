package buzz.jixiangruyi1207.srl;

import static org.junit.Assert.*;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class NativeReplacedObjectCleanupTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();
    private final String oldHash = "a".repeat(64);
    private final String newHash = "b".repeat(64);

    private void write(File file, String text) throws Exception {
        file.getParentFile().mkdirs();
        Files.write(file.toPath(), text.getBytes(StandardCharsets.UTF_8));
    }
    private File object(File library, String hash) throws Exception {
        File file = new File(library, "objects/" + hash.substring(0, 2) + "/" + hash + ".bin");
        write(file, "data");
        return file;
    }
    private File metadata(File library, String entry, String hash) throws Exception {
        File file = new File(library, entry + "/resource.json");
        write(file, new JSONObject().put("id", file.getParentFile().getName()).put("contentHash", hash).put("size", 4).toString());
        return file;
    }
    private long release(File library, File jobs, File metadata, String hash, long size,
                         Set<String> candidates) throws Exception {
        return NativeReplacedObjectCleanup.release(library, jobs, new JSONArray().put(new JSONObject()
            .put("scope", metadata.getParentFile().getParentFile().getName())
            .put("id", metadata.getParentFile().getName()).put("contentHash", hash)
            .put("size", size).put("replacedHashes", new JSONArray(candidates))));
    }
    @Test public void replacesOnlyKnownUnreferencedFilesAndKeepsHistoryAndUnrelatedRecovery() throws Exception {
        File library = temporary.newFolder("library"), jobs = temporary.newFolder("jobs");
        File old = object(library, oldHash), current = object(library, newHash);
        File unknown = object(library, "c".repeat(64));
        File meta = metadata(library, "current/persona", newHash);
        File history = metadata(library, "versions/old", oldHash);
        assertEquals(0, release(library, jobs, meta, newHash, 4, Set.of(oldHash)));
        assertTrue(old.exists());
        assertTrue(history.delete());
        assertTrue(history.getParentFile().delete());
        assertEquals(4, release(library, jobs, meta, newHash, 4, Set.of(oldHash)));
        assertFalse(old.exists());
        assertTrue(current.exists());
        assertTrue(unknown.exists());
        assertEquals(0, release(library, jobs, meta, newHash, 4, Set.of(oldHash)));
    }
    @Test public void protectsOtherResourceReferencesAndUnreadableMetadata() throws Exception {
        File library = temporary.newFolder("library"), jobs = temporary.newFolder("jobs");
        File old = object(library, oldHash);
        object(library, newHash);
        File meta = metadata(library, "current/persona", newHash);
        File shared = metadata(library, "current/shared", oldHash);
        assertEquals(0, release(library, jobs, meta, newHash, 4, Set.of(oldHash)));
        write(shared, "broken");
        assertThrows(Exception.class, () -> release(library, jobs, meta, newHash, 4, Set.of(oldHash)));
        assertTrue(old.exists());
        assertEquals(0, release(library, jobs, meta, oldHash, 4, Set.of(oldHash)));
    }
    @Test public void keepsSourceObjectsForIncompleteOrRetryableCloudJobs() throws Exception {
        File library = temporary.newFolder("library"), jobs = temporary.newFolder("jobs");
        File old = object(library, oldHash);
        object(library, newHash);
        File meta = metadata(library, "current/persona", newHash);
        File header = new File(jobs, "upload/job.json");
        JSONObject job = new JSONObject().put("status", "staging");
        write(header, job.toString());
        assertEquals(0, release(library, jobs, meta, newHash, 4, Set.of(oldHash)));
        job.put("status", "failed").put("objects", new JSONArray().put(new JSONObject().put("source",
            new JSONObject().put("segments", new JSONArray().put(new JSONObject().put("sourceHash", oldHash))))));
        write(header, job.toString());
        assertEquals(0, release(library, jobs, meta, newHash, 4, Set.of(oldHash)));
        assertTrue(old.exists());
        write(header, job.put("status", "completed").toString());
        assertEquals(4, release(library, jobs, meta, newHash, 4, Set.of(oldHash)));
    }

    @Test public void batchReplacementReclaimsExactOldBytesWithoutSweepingUnknownObjects() throws Exception {
        File library = temporary.newFolder("library"), jobs = temporary.newFolder("jobs");
        JSONArray records = new JSONArray();
        for (int i = 0; i < 1000; i++) {
            String old = String.format("%064x", i + 1), next = String.format("%064x", i + 1001);
            object(library, old);
            object(library, next);
            metadata(library, "current/item-" + i, next);
            records.put(new JSONObject().put("scope", "current").put("id", "item-" + i)
                .put("contentHash", next).put("size", 4).put("replacedHashes", new JSONArray().put(old)));
        }
        File unknown = object(library, "f".repeat(64));
        assertEquals(4000, NativeReplacedObjectCleanup.release(library, jobs, records));
        assertTrue(unknown.exists());
        assertEquals(0, NativeReplacedObjectCleanup.release(library, jobs, records));
    }

    @Test public void usesTheNativeEncodedEntryAndRequiresTheCommittedResourceIdentity() throws Exception {
        File library = temporary.newFolder("library"), jobs = temporary.newFolder("jobs");
        File old = object(library, oldHash);
        object(library, newHash);
        File meta = metadata(library, "current/encoded-id", newHash);
        write(meta, new JSONObject().put("id", "用户-id").put("contentHash", newHash).put("size", 4).toString());
        JSONObject record = new JSONObject().put("scope", "current").put("id", "other-id")
            .put("entry", "encoded-id").put("contentHash", newHash).put("size", 4)
            .put("replacedHashes", new JSONArray().put(oldHash));
        assertEquals(0, NativeReplacedObjectCleanup.release(library, jobs, new JSONArray().put(record)));
        assertTrue(old.exists());
        record.put("id", "用户-id");
        assertEquals(4, NativeReplacedObjectCleanup.release(library, jobs, new JSONArray().put(record)));
    }

    @Test public void avoidsAnEmptyAliasScanAndProtectsPreparedObjects() throws Exception {
        File library = temporary.newFolder("library"), jobs = temporary.newFolder("jobs");
        File old = object(library, oldHash);
        File broken = new File(library, "current/broken/resource.json");
        write(broken, "broken");
        assertEquals(0, NativeReplacedObjectCleanup.releaseUnreferenced(library, jobs, Set.of(oldHash), Set.of(oldHash)));
        assertTrue(old.exists());
        assertTrue(old.delete());
        assertEquals(0, NativeReplacedObjectCleanup.releaseUnreferenced(library, jobs, Set.of(oldHash)));
        // Neither an in-flight object nor an already reclaimed alias needs a directory scan.
        assertTrue(broken.exists());
    }
}
