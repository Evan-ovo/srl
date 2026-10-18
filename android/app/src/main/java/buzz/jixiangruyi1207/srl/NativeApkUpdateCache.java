package buzz.jixiangruyi1207.srl;

import java.io.File;
import java.util.Arrays;
import java.util.Comparator;
import java.util.function.Predicate;

/** Keep one completed update plus files still owned by downloads or the installer. */
final class NativeApkUpdateCache {
    static void cleanup(File directory, Predicate<String> inUse) throws Exception {
        File[] files = directory.getCanonicalFile().listFiles();
        if (files == null) return;
        Arrays.sort(files, Comparator.comparingLong(File::lastModified).reversed().thenComparing(File::getName));
        boolean retained = false;
        for (File file : files) {
            String name = file.getName();
            if (!name.matches("srl-update(?:-[a-zA-Z0-9-]{1,64})?\\.apk(?:\\.part)?")
                || !file.isFile() || !file.getCanonicalFile().equals(file.getAbsoluteFile()) || inUse.test(name)) continue;
            if (name.endsWith(".apk") && !retained) {
                retained = true;
                continue;
            }
            if (!inUse.test(name)) file.delete();
        }
    }
}
