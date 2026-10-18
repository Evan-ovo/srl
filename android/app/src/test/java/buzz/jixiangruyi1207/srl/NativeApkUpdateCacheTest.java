package buzz.jixiangruyi1207.srl;

import static org.junit.Assert.*;
import java.io.File;
import java.nio.file.Files;
import java.util.HashSet;
import java.util.Set;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class NativeApkUpdateCacheTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();
    private File file(String name, long time) throws Exception {
        File file = new File(temporary.getRoot(), name);
        Files.write(file.toPath(), new byte[] {1, 2, 3});
        assertTrue(file.setLastModified(time));
        return file;
    }
    @Test public void boundsFinishedUpdatesAndKeepsDownloadsAndInstallerFiles() throws Exception {
        File legacy = file("srl-update.apk", 1000);
        File previous = file("srl-update-previous.apk", 2000);
        File newest = file("srl-update-newest.apk", 3000);
        File installer = file("srl-update-installer.apk", 500);
        File active = file("srl-update-active.apk.part", 4000);
        File interrupted = file("srl-update-interrupted.apk.part", 4500);
        File unrelated = file("user-file.apk", 100);
        Set<String> inUse = new HashSet<>(Set.of(installer.getName(), active.getName()));
        NativeApkUpdateCache.cleanup(temporary.getRoot(), inUse::contains);
        assertFalse(legacy.exists()); assertFalse(previous.exists()); assertFalse(interrupted.exists());
        assertTrue(newest.exists()); assertTrue(installer.exists()); assertTrue(active.exists()); assertTrue(unrelated.exists());
        inUse.clear();
        NativeApkUpdateCache.cleanup(temporary.getRoot(), inUse::contains);
        assertFalse(installer.exists()); assertFalse(active.exists()); assertTrue(newest.exists()); assertTrue(unrelated.exists());
    }
}
