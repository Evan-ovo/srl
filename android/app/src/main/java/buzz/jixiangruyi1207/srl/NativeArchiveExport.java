package buzz.jixiangruyi1207.srl;

import android.content.Context;
import android.net.Uri;
import android.util.AtomicFile;
import androidx.documentfile.provider.DocumentFile;
import com.getcapacitor.JSObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import org.apache.commons.compress.archivers.zip.*;

/** One verified compressed entry per checkpoint. Final assembly never recompresses entries. */
final class NativeArchiveExport {
    static File root(Context context) throws IOException {
        File root = new File(context.getFilesDir(), "srl-export-jobs");
        if (!root.isDirectory() && !root.mkdirs()) throw new IOException("无法创建导出暂存目录");
        return root;
    }
    private static File job(Context context, String id) throws Exception {
        if (id == null || !id.matches("[0-9a-f]{8}-[0-9a-f-]{27}-[0-9a-f]{16}")) throw new IOException("导出任务标识无效");
        File dir = new File(root(context), id);
        if (!dir.isDirectory()) throw new IOException("导出任务不存在");
        return dir;
    }
    private static String key(String path) throws Exception {
        if (path == null || path.isEmpty() || path.startsWith("/") || path.contains("\\") || path.contains("\0") || Arrays.asList(path.split("/")).contains("..")) throw new IOException("导出条目路径无效");
        StringBuilder value = new StringBuilder();
        for (byte b : MessageDigest.getInstance("SHA-256").digest(path.getBytes(StandardCharsets.UTF_8))) value.append(String.format(Locale.ROOT,"%02x",b));
        return value.toString();
    }
    private static AtomicFile stateFile(File dir) { return new AtomicFile(new File(dir,"state.json")); }
    static JSObject state(Context context, String id) throws Exception { return NativeArchiveTasks.readJson(context,stateFile(job(context,id))); }

    static synchronized JSObject begin(Context context, String taskId, String fileName, String treeUri) throws Exception {
        if (taskId == null || !taskId.matches("[0-9a-f]{8}-[0-9a-f-]{27}")) throw new IOException("任务标识无效");
        String id = taskId + "-" + key(fileName).substring(0,16);
        File dir = new File(root(context),id);
        AtomicFile file = stateFile(dir);
        if (!file.getBaseFile().exists() && !new File(file.getBaseFile()+".bak").exists()) {
            DocumentFile tree = treeUri == null ? null : DocumentFile.fromTreeUri(context,Uri.parse(treeUri));
            if (tree == null || !tree.canWrite()) throw new IOException("系统备份文件夹授权不可用");
            if (!dir.isDirectory() && !dir.mkdir()) throw new IOException("无法创建导出任务");
            JSObject state = new JSObject();
            state.put("id",id); state.put("treeUri",treeUri);
            state.put("fileName", fileName.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]","_").replaceFirst("(?i)\\.zip$", "") + "-" + taskId.substring(0,8) + ".zip");
            NativeArchiveTasks.writeJson(context,file,state);
        }
        return state(context,id);
    }

    static synchronized JSObject entry(Context context, String id, String path) throws Exception {
        File dir = job(context,id); String key = key(path);
        AtomicFile metaFile = new AtomicFile(new File(dir,key+".json"));
        if (!metaFile.getBaseFile().exists() && !new File(metaFile.getBaseFile()+".bak").exists()) return null;
        JSObject meta = NativeArchiveTasks.readJson(context,metaFile);
        File zip = new File(dir,key+".zip");
        if (!path.equals(meta.getString("path")) || !zip.isFile() || zip.length()!=meta.getLong("bytes") || !NativeFileAccess.hash(zip).equals(meta.getString("sha256"))) return null;
        return meta;
    }

    static synchronized void resetInput(Context context, String id, String path) throws Exception {
        try (FileOutputStream output = new FileOutputStream(new File(job(context,id),key(path)+".input"))) { output.getFD().sync(); }
    }
    static synchronized void appendInput(Context context, String id, String path, long offset, byte[] bytes) throws Exception {
        if (bytes.length > 1024*1024) throw new IOException("导出分块超过 1 MiB");
        File file = new File(job(context,id),key(path)+".input");
        if (!file.isFile() || file.length()!=offset) throw new IOException("导出分块位置不一致");
        try(FileOutputStream output = new FileOutputStream(file,true)) { output.write(bytes); }
    }

    static synchronized JSObject compress(Context context, String id, String path, String uri, long size, boolean compress, long mtime, JSObject descriptor) throws Exception {
        JSObject previous = entry(context,id,path);
        if (previous != null) return previous;
        File dir=job(context,id); String key=key(path);
        File input = uri == null ? new File(dir,key+".input") : NativeFileAccess.resolve(context,uri);
        if (!input.isFile() || input.length()!=size) throw new IOException("导出源文件大小变化");
        String expectedHash = descriptor == null ? null : descriptor.getString("contentHash");
        String leaf = path.substring(path.lastIndexOf('/')+1);
        if (expectedHash == null && leaf.matches("asset-[0-9a-f]{64}")) expectedHash = leaf.substring(6);
        MessageDigest contentHash = MessageDigest.getInstance("SHA-256");
        long copied = 0;
        File partial = new File(dir,key+".partial");
        try (ZipArchiveOutputStream output = new ZipArchiveOutputStream(partial)) {
            output.setUseZip64(Zip64Mode.AsNeeded); output.setLevel(1);
            ZipArchiveEntry entry = new ZipArchiveEntry(path);
            entry.setMethod(compress ? ZipArchiveOutputStream.DEFLATED : ZipArchiveOutputStream.STORED);
            entry.setSize(size); entry.setTime(mtime);
            output.putArchiveEntry(entry);
            try (FileInputStream source = new FileInputStream(input)) {
                byte[] buffer = new byte[256*1024]; int count;
                while ((count=source.read(buffer))!=-1) {
                    copied+=count;
                    if (copied>size) throw new IOException("导出源文件在读取中变大");
                    contentHash.update(buffer,0,count); output.write(buffer,0,count);
                }
            }
            if (copied!=size) throw new IOException("导出源文件读取不完整");
            StringBuilder digest = new StringBuilder(); for(byte b:contentHash.digest()) digest.append(String.format(Locale.ROOT,"%02x",b));
            if (expectedHash!=null && !digest.toString().equalsIgnoreCase(expectedHash)) throw new IOException("导出源文件哈希变化");
            output.closeArchiveEntry();
        }
        try (RandomAccessFile file = new RandomAccessFile(partial,"rw")) { file.getFD().sync(); }
        File zip = new File(dir,key+".zip");
        if (zip.exists() && !zip.delete()) throw new IOException("无法替换损坏的压缩条目");
        if (!partial.renameTo(zip)) throw new IOException("无法保存压缩检查点");
        JSObject meta = new JSObject();
        meta.put("path",path); meta.put("bytes",zip.length()); meta.put("sha256",NativeFileAccess.hash(zip));
        if (descriptor != null) meta.put("descriptor",descriptor);
        NativeArchiveTasks.writeJson(context,new AtomicFile(new File(dir,key+".json")),meta);
        if (uri == null && !input.delete()) throw new IOException("已压缩，但清理输入暂存失败");
        return meta;
    }

    static synchronized JSObject assemble(Context context, String id, List<String> paths) throws Exception {
        File dir = job(context,id); JSObject state=state(context,id);
        if (paths.size()>100000 || new HashSet<>(paths).size()!=paths.size() || !paths.contains("manifest.json")) throw new IOException("归档条目清单无效");
        File archive = new File(dir,"archive.zip");
        if (archive.isFile() && state.has("archiveHash") && NativeFileAccess.hash(archive).equals(state.getString("archiveHash"))) return state;
        File partial = new File(dir,"archive.partial");
        try (ZipArchiveOutputStream output = new ZipArchiveOutputStream(partial)) {
            output.setUseZip64(Zip64Mode.AsNeeded);
            for (String path : paths) {
                if (entry(context,id,path)==null) throw new IOException("压缩检查点缺失或损坏："+path);
                try (ZipFile source = ZipFile.builder().setFile(new File(dir,key(path)+".zip")).get()) {
                    ZipArchiveEntry item=source.getEntry(path);
                    if (item==null) throw new IOException("压缩条目名称不一致");
                    try (InputStream raw=source.getRawInputStream(item)) { output.addRawArchiveEntry(item,raw); }
                }
            }
        }
        try (RandomAccessFile file=new RandomAccessFile(partial,"rw")) { file.getFD().sync(); }
        if (archive.exists() && !archive.delete()) throw new IOException("无法替换未完成归档");
        if (!partial.renameTo(archive)) throw new IOException("无法保存完整归档");
        state.put("archiveHash",NativeFileAccess.hash(archive)); state.put("bytes",archive.length());
        NativeArchiveTasks.writeJson(context,stateFile(dir),state);
        return state;
    }

    static synchronized JSObject publish(Context context, String id) throws Exception {
        File dir=job(context,id); JSObject state=state(context,id);
        if (state.optBoolean("saved")) return state;
        File archive=new File(dir,"archive.zip");
        if (!archive.isFile() || !NativeFileAccess.hash(archive).equals(state.getString("archiveHash"))) throw new IOException("完整归档检查点无效");
        DocumentFile tree=DocumentFile.fromTreeUri(context,Uri.parse(state.getString("treeUri")));
        if (tree==null || !tree.canWrite()) throw new IOException("原导出目录授权不可用，请恢复授权后继续");
        String name=state.getString("fileName");
        DocumentFile target=null;
        if(state.has("targetUri")) {
            for(DocumentFile candidate:tree.listFiles()) {
                if(candidate.getUri().toString().equals(state.getString("targetUri"))) { target=candidate;break; }
            }
        }
        // A provider can change its URI during rename. The unique task suffix closes that crash window.
        boolean foundByName=false;
        if (target==null || !target.exists()) {
            target=tree.findFile(name);
            foundByName=target!=null;
        }
        boolean targetExists=target!=null && target.exists();
        boolean verified=(targetExists || foundByName) && verify(context,target,archive.length(),state.getString("archiveHash"));
        if (foundByName && !verified) throw new IOException("目标名称已被其它文件使用，未覆盖该文件");
        if (targetExists && verified) {
            if (!name.equals(target.getName()) && !target.renameTo(name)) throw new IOException("备份已写入但重命名未完成，请继续任务");
            state.put("saved",true); state.put("targetUri",target.getUri().toString());
            NativeArchiveTasks.writeJson(context,stateFile(dir),state); return state;
        }
        if (target==null || !target.exists()) target=tree.findFile(name+".partial");
        if (target==null) target=tree.createFile("application/octet-stream",name+".partial");
        if (target==null) throw new IOException("无法创建导出目标");
        state.put("targetUri",target.getUri().toString());
        NativeArchiveTasks.writeJson(context,stateFile(dir),state);
        // SAF may be a non-seekable cloud pipe: restart only the final copy, never compression.
        try (InputStream input=new FileInputStream(archive); OutputStream output=context.getContentResolver().openOutputStream(target.getUri(),"wt")) {
            if (output==null) throw new IOException("无法写入导出目标");
            copy(input,output); output.flush();
        }
        if (!verify(context,target,archive.length(),state.getString("archiveHash"))) throw new IOException("导出目标完整性校验失败，检查点已保留");
        if (!name.equals(target.getName()) && !target.renameTo(name)) throw new IOException("备份已写入但重命名未完成，请继续任务");
        state.put("saved",true); state.put("targetUri",target.getUri().toString());
        NativeArchiveTasks.writeJson(context,stateFile(dir),state);
        return state;
    }
    private static boolean verify(Context context, DocumentFile target, long size, String expected) throws Exception {
        if (target.length()!=size) return false;
        MessageDigest hash=MessageDigest.getInstance("SHA-256");
        try(InputStream input=context.getContentResolver().openInputStream(target.getUri())) {
            if (input==null) return false;
            byte[] buffer=new byte[256*1024]; int count;
            while((count=input.read(buffer))!=-1) hash.update(buffer,0,count);
        }
        StringBuilder hex=new StringBuilder(); for(byte b:hash.digest()) hex.append(String.format(Locale.ROOT,"%02x",b));
        return hex.toString().equals(expected);
    }
    private static void copy(InputStream input, OutputStream output) throws IOException {
        byte[] buffer=new byte[256*1024]; int count;
        while((count=input.read(buffer))!=-1) output.write(buffer,0,count);
    }

    static synchronized void removeTask(Context context, String taskId) throws Exception {
        if(taskId==null || !taskId.matches("[0-9a-f]{8}-[0-9a-f-]{27}")) throw new IOException("任务标识无效");
        File[] dirs=root(context).listFiles(); if(dirs==null) return;
        for(File dir:dirs) {
            if(!dir.getName().startsWith(taskId+"-") || !dir.isDirectory()) continue;
            AtomicFile checkpoint=stateFile(dir);
            JSObject state=checkpoint.getBaseFile().exists() || new File(checkpoint.getBaseFile()+".bak").exists()
                ? state(context,dir.getName()) : new JSObject();
            if(!state.optBoolean("saved") && state.has("targetUri")) {
                DocumentFile partial=DocumentFile.fromSingleUri(context,Uri.parse(state.getString("targetUri")));
                if(partial!=null && partial.exists() && (state.getString("fileName")+".partial").equals(partial.getName()) && !partial.delete()) throw new IOException("无法清理未完成的目标文件");
            }
            File[] files=dir.listFiles(); if(files!=null) for(File file:files) {
                if(!file.isFile() || !file.getCanonicalFile().getParentFile().equals(dir.getCanonicalFile()) || !file.delete()) throw new IOException("无法清理导出检查点");
            }
            if(!dir.delete()) throw new IOException("无法清理导出任务目录");
        }
    }
}
