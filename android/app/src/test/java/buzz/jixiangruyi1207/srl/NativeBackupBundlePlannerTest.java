package buzz.jixiangruyi1207.srl;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InterruptedIOException;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.concurrent.atomic.AtomicLong;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import static org.junit.Assert.*;

public final class NativeBackupBundlePlannerTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();
    private static final String EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    @Test public void matchesTypescriptGearGoldenAcrossWindowAndContentBoundaries() throws Exception {
        File file = temporary.newFile();
        int seed = 1, remaining = 40 * 1024 * 1024 + 19;
        try (FileOutputStream output = new FileOutputStream(file)) {
            byte[] buffer = new byte[1024 * 1024];
            while (remaining > 0) {
                int count = Math.min(buffer.length, remaining);
                for (int index = 0; index < count; index++) {
                    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
                    buffer[index] = (byte) seed;
                }
                output.write(buffer, 0, count); remaining -= count;
            }
        }
        String hash = "03f74406a74a971a116a573014b150d46a695ca8a8f792b75aa5397c72630a1d";
        JSONObject result = NativeBackupBundlePlanner.plan(file, file.length(), hash, null, processed -> {});
        assertEquals(hash, result.getString("totalSha256"));
        JSONArray parts = result.getJSONArray("parts");
        long[] sizes = {18545424, 8523086, 11877972, 2996577};
        String[] hashes = {
            "71bb2710d35fc674900877189d025d4ed0ddca325318862c25623e09918da66c",
            "96c09924ac77434abd81696a399feadc7bf7c84eb1a34e11c68836dffc0dd184",
            "74ba0f6e149f3265515fe8959e8daf013194fdef94f77e1f1c65a679baa94b1c",
            "c1c9c35ff9a369a95b81635662db0eeb9d7f9e0894fb836da992b0dd83680a07"
        };
        assertEquals(sizes.length, parts.length());
        for (int index = 0; index < sizes.length; index++) {
            assertEquals(sizes[index], parts.getJSONObject(index).getLong("size"));
            assertEquals(hashes[index], parts.getJSONObject(index).getString("sha256"));
        }
    }

    @Test public void fixedSinglePartAndEmptyObjectsShareTheirWholeSha() throws Exception {
        for (int size : new int[] {0, 1, 1024 * 1024 + 19, 4 * 1024 * 1024}) {
            File file = temporary.newFile();
            byte[] bytes = new byte[size]; Arrays.fill(bytes, (byte) 0x53);
            Files.write(file.toPath(), bytes);
            String hash = sha(bytes);
            JSONObject plan = NativeBackupBundlePlanner.plan(file, size, hash, 4L * 1024 * 1024, processed -> {});
            assertEquals(1, plan.getJSONArray("parts").length());
            assertEquals(hash, plan.getJSONArray("parts").getJSONObject(0).getString("sha256"));
            assertEquals(size, plan.getJSONArray("parts").getJSONObject(0).getLong("size"));
        }
    }

    @Test public void rejectsChangedSizeAndSameSizeCorruption() throws Exception {
        File file = temporary.newFile(); Files.write(file.toPath(), new byte[] {1, 2, 3});
        assertThrows(Exception.class, () -> NativeBackupBundlePlanner.plan(file, 4, sha(new byte[] {1, 2, 3}), null, p -> {}));
        assertThrows(Exception.class, () -> NativeBackupBundlePlanner.plan(file, 3, sha(new byte[] {3, 2, 1}), null, p -> {}));
    }

    @Test public void cancellationStopsAtTheNextReadWindow() throws Exception {
        File file = temporary.newFile(); Files.write(file.toPath(), new byte[3 * 1024 * 1024]);
        AtomicLong processed = new AtomicLong();
        assertThrows(InterruptedIOException.class, () -> NativeBackupBundlePlanner.plan(file, file.length(), EMPTY_SHA, null, count -> {
            processed.set(count);
            if (count >= NativeBackupBundlePlanner.READ_BYTES) throw new InterruptedIOException("cancelled");
        }));
        assertEquals(NativeBackupBundlePlanner.READ_BYTES, processed.get());
    }

    @Test public void readsExactBoundedRangesAndRejectsOversizeOrTruncatedFiles() throws Exception {
        File file = temporary.newFile(); Files.write(file.toPath(), new byte[] {1, 2, 3, 4, 5});
        assertArrayEquals(new byte[] {3, 4}, NativeBackupBundlePlanner.readRange(file, 5, 2, 2));
        assertThrows(Exception.class, () -> NativeBackupBundlePlanner.readRange(file, 5, 3, 3));
        assertThrows(Exception.class, () -> NativeBackupBundlePlanner.readRange(file, 5, -1, 1));
        assertThrows(Exception.class, () -> NativeBackupBundlePlanner.readRange(file, 5, 0, 1024 * 1024 + 1));
        assertThrows(Exception.class, () -> NativeBackupBundlePlanner.readRange(file, 6, 0, 1));
    }

    private static String sha(byte[] bytes) throws Exception {
        StringBuilder output = new StringBuilder();
        for (byte item : MessageDigest.getInstance("SHA-256").digest(bytes)) output.append(String.format("%02x", item));
        return output.toString();
    }
}
