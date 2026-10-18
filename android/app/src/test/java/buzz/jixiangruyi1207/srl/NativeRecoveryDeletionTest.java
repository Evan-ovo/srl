package buzz.jixiangruyi1207.srl;

import static org.junit.Assert.*;
import java.io.File;
import java.nio.file.Files;
import java.nio.charset.StandardCharsets;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class NativeRecoveryDeletionTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();
    private final String hash = "a".repeat(64);
    private void write(File file, String value) throws Exception { file.getParentFile().mkdirs(); Files.write(file.toPath(), value.getBytes(StandardCharsets.UTF_8)); }
    private File object(File root) throws Exception {
        File file = new File(root, "objects/aa/" + hash + ".bin"); file.getParentFile().mkdirs(); Files.write(file.toPath(), new byte[4]); return file;
    }
    private JSONObject item(File file) throws Exception { return new JSONObject().put("contentHash", hash).put("size", file.length()).put("modifiedAt", file.lastModified()); }
    private File index(File root, String scope, String id) throws Exception {
        File file = new File(root, scope + "/" + id + "/resource.json");file.getParentFile().mkdirs();
        write(file,new JSONObject().put("id",id).put("contentHash",hash).put("size",4).toString());return file;
    }
    @Test public void deletesOnlyTheSelectedUnreferencedObject() throws Exception {
        File root=temporary.newFolder(),jobs=temporary.newFolder(),file=object(root);
        File unknown=new File(root,"objects/aa/"+"b".repeat(64)+".bin");Files.write(unknown.toPath(),new byte[3]);
        JSONObject result=NativeRecoveryDeletion.delete(root,jobs,new JSONArray().put(item(file)),Set.of());
        assertFalse(file.exists());assertTrue(unknown.exists());assertEquals(4,result.getLong("clearedBytes"));assertEquals(1,result.getJSONArray("deletedHashes").length());
    }
    @Test public void removesVerifiedStaleIndexButProtectsSharedHistoryAndPendingWrites() throws Exception {
        File root=temporary.newFolder(),jobs=temporary.newFolder(),file=object(root),current=index(root,"current","stale-id"),history=index(root,"versions","saved");
        JSONObject candidate=item(file).put("nativeId","stale-id").put("entry","stale-id");
        NativeRecoveryDeletion.delete(root,jobs,new JSONArray().put(candidate),Set.of());assertTrue(file.exists());assertTrue(current.exists());
        assertTrue(history.delete());assertTrue(history.getParentFile().delete());
        NativeRecoveryDeletion.delete(root,jobs,new JSONArray().put(candidate),Set.of(hash));assertTrue(file.exists());assertTrue(current.exists());
        NativeRecoveryDeletion.delete(root,jobs,new JSONArray().put(candidate),Set.of());assertFalse(file.exists());assertFalse(current.exists());
    }
    @Test public void retainsChangedFilesAndUnreadableReferences() throws Exception {
        File root=temporary.newFolder(),jobs=temporary.newFolder(),file=object(root);
        JSONObject stale=item(file).put("modifiedAt",file.lastModified()+1);
        assertThrows(Exception.class,()->NativeRecoveryDeletion.delete(root,jobs,new JSONArray().put(stale),Set.of()));assertTrue(file.exists());
        File index=index(root,"current","broken");write(index,"broken");
        assertThrows(Exception.class,()->NativeRecoveryDeletion.delete(root,jobs,new JSONArray().put(item(file)),Set.of()));assertTrue(file.exists());
    }
    @Test public void rejectsChangedStaleIndex() throws Exception {
        File root=temporary.newFolder(),jobs=temporary.newFolder(),file=object(root);JSONObject candidate=item(file).put("nativeId","different").put("entry","current");
        index(root,"current","current");
        assertThrows(Exception.class,()->NativeRecoveryDeletion.delete(root,jobs,new JSONArray().put(candidate),Set.of()));assertTrue(file.exists());
    }
    @Test public void keepsCompletedCloudRestoreFilesAwaitingMetadataImport() throws Exception {
        File root=temporary.newFolder(),jobs=temporary.newFolder(),file=object(root);
        File job=new File(jobs,"restore/job.json");write(job,new JSONObject().put("kind","restore").put("status","completed").toString());
        File plan=new File(job.getParentFile(),"restore-plan/job.json");write(plan,new JSONObject().put("resources",new JSONArray().put(new JSONObject().put("hash",hash))).toString());
        JSONObject result=NativeRecoveryDeletion.delete(root,jobs,new JSONArray().put(item(file)),Set.of());
        assertTrue(file.exists());assertEquals(0,result.getLong("clearedBytes"));
    }
}
