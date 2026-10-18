package buzz.jixiangruyi1207.srl;

import static org.junit.Assert.*;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.Arrays;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

public class NativeCloudFileStageTest {
    private File scratch;
    @Before public void createScratch() throws Exception {
        File workspace = new File(System.getProperty("user.dir")).getAbsoluteFile();
        while (workspace != null && !new File(workspace, "src/services/NativeCloudTransfer.ts").isFile()) workspace = workspace.getParentFile();
        if (workspace == null) throw new IllegalStateException("缺少测试工作区");
        File root = new File(workspace, ".codex-tmp");
        if (!root.isDirectory() && !root.mkdirs()) throw new IOException("无法创建测试目录");
        scratch = Files.createTempDirectory(root.toPath(), LocalDate.now().format(DateTimeFormatter.BASIC_ISO_DATE) + "-cloud-native-range-").toFile();
    }
    @After public void cleanup() throws Exception {
        if (scratch != null) {
            File[] files = scratch.listFiles();
            if (files != null) for (File file : files) Files.delete(file.toPath());
            Files.delete(scratch.toPath());
        }
    }
    private static String sha(byte[] bytes) throws Exception {
        StringBuilder hash = new StringBuilder();
        for (byte value : MessageDigest.getInstance("SHA-256").digest(bytes)) hash.append(String.format("%02x", value & 255));
        return hash.toString();
    }
    @Test public void copiesOnlyTheVerifiedRangeWithMultipleBufferReads() throws Exception {
        byte[] bytes = new byte[1024 * 1024 + 19];
        for (int i = 0; i < bytes.length; i++) bytes[i] = (byte) (i * 31);
        File original = new File(scratch, "source.bin"), staged = new File(scratch, "stage.part");
        Files.write(original.toPath(), bytes);
        byte[] selected = Arrays.copyOfRange(bytes, 13, bytes.length - 3);
        NativeCloudTransferPlugin.copyVerifiedFileRange(original, staged, 13, selected.length, sha(selected));
        assertArrayEquals(selected, Files.readAllBytes(staged.toPath()));
        assertArrayEquals(bytes, Files.readAllBytes(original.toPath()));
    }
    @Test public void deletesOnlyTheFailedStageWhenBytesDoNotMatch() throws Exception {
        File original = new File(scratch, "source.bin"), staged = new File(scratch, "stage.part");
        Files.write(original.toPath(), new byte[] {1, 2, 3});
        assertThrows(IllegalStateException.class, () -> NativeCloudTransferPlugin.copyVerifiedFileRange(original, staged, 0, 3, sha(new byte[] {3, 2, 1})));
        assertFalse(staged.exists()); assertTrue(original.isFile());
    }
    @Test public void rejectsTruncationAndInvalidRangesWithoutCreatingAnOutput() throws Exception {
        File original = new File(scratch, "source.bin"), staged = new File(scratch, "stage.part");
        Files.write(original.toPath(), new byte[] {1, 2, 3});
        for (long[] range : new long[][] {{0, 4}, {4, 0}, {-1, 2}, {0, -1}, {Long.MAX_VALUE, 1}})
            assertThrows(IOException.class, () -> NativeCloudTransferPlugin.copyVerifiedFileRange(original, staged, range[0], range[1], "bad"));
        assertFalse(staged.exists());
    }
}
