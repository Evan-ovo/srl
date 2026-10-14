package buzz.jixiangruyi1207.srl;
import org.junit.Test;
import static org.junit.Assert.*;
import java.io.*;
public class NativeBrowserFileStreamTest {
    @Test public void copiesUsingBoundedBlocksAndReportsActualBytes() throws Exception {
        byte[] data = new byte[1024 * 1024 + 31]; new java.util.Random(7).nextBytes(data);
        ByteArrayOutputStream output = new ByteArrayOutputStream(); java.util.ArrayList<Long> progress = new java.util.ArrayList<>();
        assertEquals(data.length, NativeFileExportPlugin.copyBrowserBody(new ByteArrayInputStream(data), output, data.length, () -> true, progress::add));
        assertArrayEquals(data, output.toByteArray()); assertEquals(Long.valueOf(data.length), progress.get(progress.size()-1));
        assertEquals(9, progress.size());
    }
    @Test public void cancelsBeforeWritingTheNextBlock() throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        try { NativeFileExportPlugin.copyBrowserBody(new ByteArrayInputStream(new byte[400000]), output, -1, () -> output.size() < 128*1024, bytes -> {}); fail(); }
        catch (IOException expected) { assertEquals(128*1024, output.size()); }
    }
    @Test public void rejectsTruncatedOrOversizedBodies() throws Exception {
        for (long size : new long[] {2, 4}) {
            try { NativeFileExportPlugin.copyBrowserBody(new ByteArrayInputStream(new byte[3]), new ByteArrayOutputStream(), size, () -> true, bytes -> {}); fail(); }
            catch (IOException expected) { assertTrue(expected.getMessage().contains("下载文件")); }
        }
    }
}
