package buzz.jixiangruyi1207.srl;

import static org.junit.Assert.*;
import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.FileOutputStream;
import java.util.UUID;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public final class NativeLibraryObjectImportTest {
    @Test public void verifiesCopiesReusesAndRepairsWithoutChangingTheArchiveSource() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File root = new File(context.getCacheDir(), "object-import-" + UUID.randomUUID());
        assertTrue(root.mkdir());
        File source = new File(root, "source"), target = new File(root, "target");
        byte[] bytes = new byte[2 * 1024 * 1024 + 19]; new java.util.Random(73).nextBytes(bytes);
        try {
            try (FileOutputStream output = new FileOutputStream(source)) { output.write(bytes); }
            String hash = NativeFileAccess.hash(source);
            NativeLibraryObjectImport.copy(source, target, bytes.length, hash);
            assertEquals(hash, NativeFileAccess.hash(target));
            assertEquals(hash, NativeFileAccess.hash(source));
            long modified = target.lastModified();
            NativeLibraryObjectImport.copy(source, target, bytes.length, hash);
            assertEquals(modified, target.lastModified());
            try (FileOutputStream output = new FileOutputStream(target)) { output.write(new byte[bytes.length]); }
            NativeLibraryObjectImport.copy(source, target, bytes.length, hash);
            assertEquals(hash, NativeFileAccess.hash(target));
            assertThrows(java.io.IOException.class, () -> NativeLibraryObjectImport.copy(source, target, bytes.length + 1L, hash));
            File bad = new File(root, "bad");
            assertThrows(java.io.IOException.class, () -> NativeLibraryObjectImport.copy(source, bad, bytes.length, "a".repeat(64)));
            assertFalse(bad.exists());
            assertEquals(2, root.listFiles().length);
        } finally { source.delete(); target.delete(); root.delete(); }
    }
}
