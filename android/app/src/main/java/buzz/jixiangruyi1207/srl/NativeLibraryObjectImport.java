package buzz.jixiangruyi1207.srl;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.security.MessageDigest;
import java.util.UUID;

/** Imports verified archive originals into the existing CAS, without publishing resource links. */
final class NativeLibraryObjectImport {
    static void copy(File source, File destination, long size, String sha256) throws Exception {
        if (!sha256.matches("[a-f0-9]{64}") || size < 0 || !source.isFile() || source.length() != size)
            throw new IOException("原生恢复原件大小或摘要无效");
        if (destination.isFile() && destination.length() == size && NativeFileAccess.hash(destination).equals(sha256)) return;
        File parent = destination.getParentFile();
        if (parent == null || (!parent.isDirectory() && !parent.mkdirs())) throw new IOException("无法创建原生原件目录");
        File temporary = new File(parent, ".restore-" + UUID.randomUUID() + ".tmp");
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            long copied = 0;
            try (FileInputStream input = new FileInputStream(source);
                 FileOutputStream output = new FileOutputStream(temporary)) {
                byte[] buffer = new byte[1024 * 1024]; int count;
                while ((count = input.read(buffer)) != -1) {
                    copied += count;
                    if (copied > size) throw new IOException("原生恢复原件大小已变化");
                    output.write(buffer, 0, count); digest.update(buffer, 0, count);
                }
                output.getFD().sync();
            }
            if (copied != size || !NativeCloudRestoreTransport.hex(digest.digest()).equals(sha256))
                throw new IOException("原生恢复原件校验失败");
            NativeCloudRestoreTransport.installRestoredObject(temporary, destination, size);
        } finally { if (temporary.exists()) temporary.delete(); }
    }
}
