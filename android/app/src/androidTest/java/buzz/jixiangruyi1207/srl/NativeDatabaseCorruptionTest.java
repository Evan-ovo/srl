package buzz.jixiangruyi1207.srl;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.RandomAccessFile;
import java.nio.file.Files;
import java.util.UUID;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public final class NativeDatabaseCorruptionTest {
    private final Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();

    private File corrupt(String name) throws Exception {
        try (NativeAppDatabase helper = new NativeAppDatabase(context, name)) {
            helper.getWritableDatabase().execSQL("INSERT INTO app_state VALUES ('keep', '完整恢复线索')");
        }
        File file = context.getDatabasePath(name);
        try (RandomAccessFile bytes = new RandomAccessFile(file, "rw")) {
            bytes.write(new byte[100]);
            bytes.getFD().sync();
        }
        return file;
    }

    @Test public void corruptWritableOpenNeverDeletesOrRecreatesTheDatabase() throws Exception {
        String name = "srl-corruption-open-" + UUID.randomUUID();
        File file = corrupt(name);
        byte[] damaged = Files.readAllBytes(file.toPath());
        try {
            // New helper instances model reopening after a failed startup, without using app data.
            for (int attempt = 0; attempt < 2; attempt++) {
                try (NativeAppDatabase helper = new NativeAppDatabase(context, name)) {
                    Exception error = assertThrows(Exception.class, helper::getWritableDatabase);
                    assertTrue(error.getMessage(), error.getMessage().contains("SRL-DATABASE-CORRUPT"));
                }
                assertArrayEquals(damaged, Files.readAllBytes(file.toPath()));
            }
        } finally { context.deleteDatabase(name); }
    }

    @Test public void corruptReadOnlyAccountingNeverDeletesTheDatabase() throws Exception {
        String name = "srl-corruption-accounting-" + UUID.randomUUID();
        File file = corrupt(name);
        byte[] damaged = Files.readAllBytes(file.toPath());
        try {
            for (int attempt = 0; attempt < 2; attempt++) {
                Exception error = assertThrows(Exception.class, () -> NativeAppDatabase.storageUsage(file));
                assertArrayEquals(damaged, Files.readAllBytes(file.toPath()));
                assertTrue(error.getMessage(), error.getMessage().contains("SRL-DATABASE-CORRUPT"));
            }
        } finally { context.deleteDatabase(name); }
    }

    @Test public void corruptionHandlerLeavesDatabaseAndRecoverySidecarsInPlace() throws Exception {
        String name = "srl-corruption-sidecars-" + UUID.randomUUID();
        File file = context.getDatabasePath(name);
        String[] suffixes = {"", "-wal", "-shm", "-journal"};
        try (NativeAppDatabase helper = new NativeAppDatabase(context, name)) {
            android.database.sqlite.SQLiteDatabase database = helper.getWritableDatabase();
            byte[][] before = new byte[suffixes.length][];
            for (int index = 0; index < suffixes.length; index++) {
                File member = new File(file.getPath() + suffixes[index]);
                if (index > 0) Files.write(member.toPath(), ("recovery" + index).getBytes(java.nio.charset.StandardCharsets.UTF_8));
                before[index] = Files.readAllBytes(member.toPath());
            }
            assertThrows(Exception.class, () -> NativeAppDatabase.PRESERVE_CORRUPT_DATABASE.onCorruption(database));
            for (int index = 0; index < suffixes.length; index++)
                assertArrayEquals(before[index], Files.readAllBytes(new File(file.getPath() + suffixes[index]).toPath()));
        } finally { context.deleteDatabase(name); }
    }

    @Test public void healthyDatabaseStillCommitsAndReopens() throws Exception {
        String name = "srl-corruption-healthy-" + UUID.randomUUID();
        try {
            try (NativeAppDatabase helper = new NativeAppDatabase(context, name)) {
                helper.putState("keep", "正常数据仍可保存");
            }
            try (NativeAppDatabase helper = new NativeAppDatabase(context, name)) {
                assertEquals("正常数据仍可保存", helper.getState("keep"));
                assertTrue(NativeAppDatabase.storageUsage(context.getDatabasePath(name)).has("stores"));
            }
        } finally { context.deleteDatabase(name); }
    }
}
