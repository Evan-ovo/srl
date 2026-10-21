package buzz.jixiangruyi1207.srl;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.security.MessageDigest;
import org.json.JSONArray;
import org.json.JSONObject;

/** Native adapter for GitHubBackupBundle's existing Gear/SHA format; never retains file bodies. */
final class NativeBackupBundlePlanner {
    static final int READ_BYTES = 1024 * 1024;
    private static final int MIN_PART_BYTES = 8 * 1024 * 1024;
    private static final int MAX_PART_BYTES = 32 * 1024 * 1024;
    private static final int BOUNDARY_MASK = 16 * 1024 * 1024 - 1;
    private static final int[] GEAR = new int[256];
    static {
        int state = 0x9e3779b9;
        for (int index = 0; index < GEAR.length; index++) {
            state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
            GEAR[index] = state;
        }
    }
    interface Progress { void update(long processed) throws Exception; }

    static byte[] readRange(File file, long size, long offset, int length) throws Exception {
        if (size < 0 || offset < 0 || offset > size || length < 0 || length > READ_BYTES
                || (length == 0 && size != 0) || length > size - offset)
            throw new IOException("原生对象读取范围无效");
        if (!file.isFile() || file.length() != size) throw new IOException("原生对象不存在或大小变化");
        byte[] bytes = new byte[length];
        try (RandomAccessFile input = new RandomAccessFile(file, "r")) {
            input.seek(offset); input.readFully(bytes);
        }
        if (file.length() != size) throw new IOException("原生对象读取期间大小变化");
        return bytes;
    }

    static JSONObject plan(File file, long size, String expectedHash, Long fixedPartSize, Progress progress) throws Exception {
        if (!file.isFile() || file.length() != size) throw new IOException("原生备份原件不存在或大小变化");
        if (fixedPartSize != null && fixedPartSize <= 0) throw new IOException("原生备份分块大小无效");
        MessageDigest total = MessageDigest.getInstance("SHA-256");
        boolean single = fixedPartSize != null && size <= fixedPartSize;
        MessageDigest part = single ? total : MessageDigest.getInstance("SHA-256");
        JSONArray parts = new JSONArray();
        byte[] buffer = new byte[READ_BYTES];
        long offset = 0, start = 0;
        int rolling = 0;
        progress.update(0);
        try (FileInputStream input = new FileInputStream(file)) {
            int count;
            while ((count = input.read(buffer)) != -1) {
                progress.update(offset);
                if (count > size - offset) throw new IOException("原生备份原件在读取中变大");
                total.update(buffer, 0, count);
                if (single) offset += count;
                else {
                    int segmentStart = 0;
                    for (int index = 0; index < count; index++) {
                        rolling = (rolling << 1) + GEAR[buffer[index] & 0xff];
                        offset++;
                        long partSize = offset - start;
                        if (fixedPartSize != null ? partSize >= fixedPartSize
                                : partSize >= MIN_PART_BYTES && ((rolling & BOUNDARY_MASK) == 0 || partSize >= MAX_PART_BYTES)) {
                            part.update(buffer, segmentStart, index + 1 - segmentStart);
                            parts.put(new JSONObject().put("size", partSize).put("sha256", hex(part.digest())));
                            start = offset; rolling = 0;
                            part = MessageDigest.getInstance("SHA-256");
                            segmentStart = index + 1;
                        }
                    }
                    part.update(buffer, segmentStart, count - segmentStart);
                }
                progress.update(offset);
            }
        }
        if (offset != size || file.length() != size) throw new IOException("原生备份原件读取不完整或大小变化");
        String totalHash;
        if (single) {
            totalHash = hex(total.digest());
            parts.put(new JSONObject().put("size", size).put("sha256", totalHash));
        } else {
            if (start < offset || parts.length() == 0)
                parts.put(new JSONObject().put("size", offset - start).put("sha256", hex(part.digest())));
            totalHash = hex(total.digest());
        }
        if (!totalHash.equals(expectedHash)) throw new IOException("原生备份原文件摘要与索引不一致");
        progress.update(offset);
        return new JSONObject().put("totalSize", size).put("totalSha256", totalHash).put("parts", parts);
    }

    private static String hex(byte[] bytes) {
        char[] digits = "0123456789abcdef".toCharArray(), output = new char[bytes.length * 2];
        for (int index = 0; index < bytes.length; index++) {
            output[index * 2] = digits[(bytes[index] & 0xff) >>> 4];
            output[index * 2 + 1] = digits[bytes[index] & 15];
        }
        return new String(output);
    }
}
