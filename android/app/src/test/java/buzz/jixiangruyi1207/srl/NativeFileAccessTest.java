package buzz.jixiangruyi1207.srl;

import static org.junit.Assert.*;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class NativeFileAccessTest {
    private static File scratchRoot() {
        File workspace = new File(System.getProperty("user.dir")).getAbsoluteFile();
        while (workspace != null && !new File(workspace, "src/storage/InstalledOfficialAppStorage.ts").isFile())
            workspace = workspace.getParentFile();
        if (workspace == null) throw new IllegalStateException("缺少测试工作区");
        File root = new File(workspace, ".codex-tmp/apk-app-ready-20261004/java-files");
        if (!root.isDirectory() && !root.mkdirs()) throw new IllegalStateException("无法创建测试目录");
        return root;
    }
    @Rule public TemporaryFolder temporary = new TemporaryFolder(scratchRoot());

    @Test public void checksExistingFilesAndSeesDeletionOrSizeChanges() throws Exception {
        File data = temporary.newFolder("files");
        File assets = new File(data, "official-apps/assets");
        assertTrue(assets.mkdirs());
        File file = new File(assets, "compiler.wasm");
        Files.write(file.toPath(), new byte[] { 1, 2, 3 });
        assertTrue(NativeFileAccess.hasOfficialAppFiles(data, new String[] { "/assets/compiler.wasm" }, new long[] { 3 }));
        assertFalse(NativeFileAccess.hasOfficialAppFiles(data, new String[] { "/assets/compiler.wasm" }, new long[] { 4 }));
        Files.delete(file.toPath());
        assertFalse(NativeFileAccess.hasOfficialAppFiles(data, new String[] { "/assets/compiler.wasm" }, new long[] { 3 }));
    }
    @Test public void rejectsTraversalAndPrivatePaths() throws Exception {
        File data = temporary.newFolder("files");
        for (String path : new String[] { "/assets/../private.js", "/private.js", "/assets/folder/app.js", "/assets/app..js", "/assets\\app.js" }) {
            assertThrows(IOException.class, () -> NativeFileAccess.hasOfficialAppFiles(data, new String[] { path }, new long[] { 1 }));
        }
    }
    @Test public void rejectsMalformedOrUnboundedLists() throws Exception {
        File data = temporary.newFolder("files");
        assertThrows(IOException.class, () -> NativeFileAccess.hasOfficialAppFiles(data, null, new long[0]));
        assertThrows(IOException.class, () -> NativeFileAccess.hasOfficialAppFiles(data, new String[] { "/assets/app.js" }, new long[0]));
        assertThrows(IOException.class, () -> NativeFileAccess.hasOfficialAppFiles(data, new String[101], new long[101]));
        assertThrows(IOException.class, () -> NativeFileAccess.hasOfficialAppFiles(data, new String[] { "/assets/app.js" }, new long[] { -1 }));
    }
    @Test public void acceptsAnEmptyListWithoutCreatingAssetDirectories() throws Exception {
        File data = temporary.newFolder("files");
        assertTrue(NativeFileAccess.hasOfficialAppFiles(data, new String[0], new long[0]));
        assertFalse(new File(data, "official-apps").exists());
    }

    @Test public void acceptsNativeDatabaseAlbumAndAttachmentObjectsForBackup() throws Exception {
        File data = temporary.newFolder("files"), cache = temporary.newFolder("cache"), library = temporary.newFolder("library");
        String hash = "ab".repeat(32);
        File source = new File(data, "srl-app-data/blobs/ab/" + hash + ".bin");
        assertTrue(source.getParentFile().mkdirs());
        Files.write(source.toPath(), new byte[] {1, 2, 3});
        assertEquals(source.getCanonicalFile(), NativeFileAccess.resolve(data, cache, library, source));
    }

    @Test public void rejectsMalformedDatabaseObjectsAndOtherPrivateFiles() throws Exception {
        File data = temporary.newFolder("files"), cache = temporary.newFolder("cache"), library = temporary.newFolder("library");
        String hash = "ab".repeat(32);
        for (String relative : new String[] {
            "srl-app-data/blobs/ab/secret.bin", "srl-app-data/blobs/cd/" + hash + ".bin",
            "srl-app-data/blobs/ab/" + hash + ".tmp", "srl-app-data/blobs-evil/ab/" + hash + ".bin",
            "srl-app-data/blobs/ab/nested/" + hash + ".bin", "srl-app-data/srl-app-data.db", "preferences/session.xml",
            "srl-app-data/blobs/ab/../../../preferences/session.xml"
        }) {
            File source = new File(data, relative);
            assertTrue(source.getParentFile().isDirectory() || source.getParentFile().mkdirs());
            Files.write(source.toPath(), new byte[] {1});
            assertThrows(IOException.class, () -> NativeFileAccess.resolve(data, cache, library, source));
        }
        File missing = new File(data, "srl-app-data/blobs/ab/" + hash + ".bin");
        assertThrows(IOException.class, () -> NativeFileAccess.resolve(data, cache, library, missing));
        assertTrue(missing.mkdir());
        assertThrows(IOException.class, () -> NativeFileAccess.resolve(data, cache, library, missing));
    }

    @Test public void stillAcceptsOwnedOriginalsAndImportFiles() throws Exception {
        File data = temporary.newFolder("files"), cache = temporary.newFolder("cache"), library = temporary.newFolder("library");
        for (File source : new File[] {
            new File(library, "objects/ab/original.bin"), new File(data, "srl-shared-intake/import.bin"),
            new File(data, "srl-archive-jobs/job/input.bin"), new File(cache, "picked-images/image.png"),
            new File(data, "srl-archive-tasks/12345678-1234-1234-1234-123456789abc.source")
        }) {
            assertTrue(source.getParentFile().isDirectory() || source.getParentFile().mkdirs());
            Files.write(source.toPath(), new byte[] {1});
            assertEquals(source.getCanonicalFile(), NativeFileAccess.resolve(data, cache, library, source));
        }
    }

    @Test public void hashesAndStagesTheCommittedDatabaseFileWithoutChangingItsBytes() throws Exception {
        File data = temporary.newFolder("files"), cache = temporary.newFolder("cache"), library = temporary.newFolder("library");
        byte[] original = new byte[] {1, 2, 3, 4};
        File seed = temporary.newFile("seed.bin");
        Files.write(seed.toPath(), original);
        String hash = NativeFileAccess.hash(seed);
        File source = new File(data, "srl-app-data/blobs/" + hash.substring(0, 2) + "/" + hash + ".bin");
        assertTrue(source.getParentFile().mkdirs());
        Files.move(seed.toPath(), source.toPath());
        File resolved = NativeFileAccess.resolve(data, cache, library, source);
        assertEquals(hash, NativeFileAccess.hash(resolved));
        File expected = temporary.newFile("expected.bin"), staged = new File(temporary.getRoot(), "staged.part");
        Files.write(expected.toPath(), new byte[] {2, 3});
        NativeCloudTransferPlugin.copyVerifiedFileRange(resolved, staged, 1, 2, NativeFileAccess.hash(expected));
        assertArrayEquals(new byte[] {2, 3}, Files.readAllBytes(staged.toPath()));
        assertArrayEquals(original, Files.readAllBytes(source.toPath()));
    }
}
