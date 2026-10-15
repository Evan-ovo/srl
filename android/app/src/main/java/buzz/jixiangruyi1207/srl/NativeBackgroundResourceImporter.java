package buzz.jixiangruyi1207.srl;

import android.content.Context;
import android.graphics.Bitmap;
import android.webkit.MimeTypeMap;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/** Commits recognized Tavern resources into the shared native library. */
final class NativeBackgroundResourceImporter {
    private static final String ACTIVE_STATE = "migration:appdb:v1:active";
    private static final String VAULT_SETTING = "\"local-vault\"";
    private static final String BLOB_PATH = "$/originalBlob";
    private static final String THUMBNAIL_PATH = "$/blob";
    private static final int THUMBNAIL_MAX_EDGE = 640;
    private static final int PAGE_SIZE = 25;
    private static final int MAX_MATCHES = 100;
    private static final int MAX_ROW_JSON_CHARS = 4 * 1024 * 1024;
    private static final int AUTO_BIND_FUTURE_LIMIT = 5;
    static final long POST_ATTACHMENT_AUTO_BYTES = 8L * 1024 * 1024;

    private static final class DuplicateHashLookup {
        final boolean found;
        final JSONObject currentResource;
        DuplicateHashLookup(boolean found, JSONObject currentResource) {
            this.found = found;
            this.currentResource = currentResource;
        }
    }

    private NativeBackgroundResourceImporter() {}

    static JSONObject saveCloudPostIfSafe(Context context, JSONObject envelope, String id, String library, String worker) throws Exception {
        NativeAppDatabase database = new NativeAppDatabase(context);
        try { return saveCloudPostIfSafe(database, envelope, id, library, worker); }
        finally { database.close(); }
    }

    /** New captures commit through the same guarded shared database as resource imports. */
    static synchronized JSONObject saveCloudPostIfSafe(NativeAppDatabase database, JSONObject envelope, String id, String library, String worker) throws Exception {
        JSONObject delivery = envelope.getJSONObject("delivery");
        if (!id.equals(delivery.getString("id")) || !library.equals(delivery.optString("libraryId"))
            || delivery.has("claimedLibraryId") && !library.equals(delivery.getString("claimedLibraryId"))
            || delivery.optLong("capturedAt", 0) <= 0) throw new IllegalArgumentException("帖子收件目标不匹配");
        JSONObject capture = NativeDiscordPostCapture.normalize(envelope.getJSONObject("capture"));
        return database.withReadGuard(() -> {
            JSONObject active = parseState(database.getState(ACTIVE_STATE));
            if (active == null || "legacy".equals(active.optString("mode")) || "rolling-back".equals(active.optString("mode"))
                || !"verified-v1".equals(database.getState("migration:appdb:indexes:v1:active")))
                return outcome("foreground_required", "本机主库尚未就绪，请回前台完成保存");
            JSONObject vault = database.getRecord("settings", VAULT_SETTING);
            if (vault != null && vault.optJSONObject("value") != null)
                return outcome("foreground_required", "帖子需要在前台解锁保险库后保存");
            JSONObject settings = readAutomationSettings(database);
            String sourceHash = NativeDiscordPostCapture.sourceHash(capture);
            JSONArray sources = database.queryKeyPage("communitySources", new JSONObject().put("indexName", "sourceKeyHash")
                .put("lower", JSONObject.quote(sourceHash)).put("upper", JSONObject.quote(sourceHash)).put("limit", 2)).getJSONArray("rows");
            long now = System.currentTimeMillis(), capturedAt = delivery.getLong("capturedAt");
            String sourceId = sources.length() == 0 ? java.util.UUID.randomUUID().toString()
                : database.getRecord("communitySources", sources.getJSONObject(0).getString("primaryKey")).getString("id");
            JSONObject message = NativeDiscordPostCapture.message(capture, sourceId, capturedAt, now);
            String key = JSONObject.quote(message.getString("id"));
            String fingerprint = NativeDiscordPostCapture.hash(capture.toString());
            if (sources.length() > 0) {
                JSONObject existing = database.getRecord("communitySourceMessages", key);
                JSONObject receipt = existing == null ? null : existing.optJSONObject("nativeInboxReceipt");
                if (receipt != null && id.equals(receipt.optString("id")) && library.equals(receipt.optString("libraryId"))
                    && worker.equals(receipt.optString("workerUrl"))
                    && fingerprint.equals(receipt.optString("captureHash")) && capturedAt == existing.optLong("deliveryCapturedAt"))
                    return new JSONObject().put("state", "saved").put("sourceId", sourceId).put("messageKey", message.getString("id"))
                        .put("alreadySaved", true).put("notificationPosted", !receipt.optString("notificationState", "").isEmpty())
                        .put("attachmentDownloadPending", postAttachmentsNeedDownload(existing, settings));
                // The foreground owner preserves edits, revisions, ignored messages and local attachment identities.
                return outcome("foreground_required", "已有帖子的更新需在前台合并，云端原文仍保留");
            }
            JSONObject source = NativeDiscordPostCapture.source(capture, sourceId, capturedAt, now, settings);
            message.put("nativeInboxReceipt", new JSONObject().put("id", id).put("libraryId", library).put("workerUrl", worker).put("captureHash", fingerprint)
                .put("attachmentState", postAttachmentsNeedDownload(message, settings) ? "pending" : "complete"));
            if (message.toString().length() > NativeAppDatabase.MAX_ROW_JSON_CHARS)
                return outcome("foreground_required", "帖子超过当前原生单条保存预算，请回前台领取；正文未截断");
            database.applyBatch(new JSONArray().put(putOperation("communitySources", JSONObject.quote(sourceId), source))
                .put(putOperation("communitySourceMessages", key, message)), true);
            JSONObject savedSource = database.getRecord("communitySources", JSONObject.quote(sourceId));
            JSONObject savedMessage = database.getRecord("communitySourceMessages", key);
            if (savedSource == null || !sourceHash.equals(savedSource.optString("sourceKeyHash")) || savedMessage == null
                || !message.toString().equals(savedMessage.toString())) throw new IllegalStateException("帖子保存读回验证失败");
            return new JSONObject().put("state", "saved").put("sourceId", sourceId).put("messageKey", message.getString("id"))
                .put("alreadySaved", false).put("notificationPosted", false)
                .put("attachmentDownloadPending", postAttachmentsNeedDownload(message, settings));
        });
    }

    static boolean postAttachmentsNeedDownload(JSONObject message, JSONObject settings) {
        if (!settings.optBoolean("downloadPostMedia", false)) return false;
        JSONArray attachments = message.optJSONArray("attachments");
        if (attachments == null) return false;
        for (int index = 0; index < attachments.length(); index++) {
            JSONObject attachment = attachments.optJSONObject(index);
            // The existing automatic attachment owner leaves files over 8 MiB as remote links.
            if (attachment != null && attachment.optDouble("size", 0) <= POST_ATTACHMENT_AUTO_BYTES
                && attachment.optString("localAssetId", "").isBlank()) return true;
        }
        return false;
    }

    static JSONArray pendingPostAttachments(NativeAppDatabase database, String messageKey) throws Exception {
        return database.withReadGuard(() -> {
            requirePostAttachmentLibrary(database);
            JSONObject message = database.getRecord("communitySourceMessages", JSONObject.quote(messageKey));
            if (message == null) throw new IllegalStateException("帖子已不存在");
            JSONArray result = new JSONArray(), attachments = message.optJSONArray("attachments");
            if (!readAutomationSettings(database).optBoolean("downloadPostMedia") || attachments == null) return result;
            for (int i = 0; i < attachments.length(); i++) {
                JSONObject attachment = attachments.getJSONObject(i);
                if (attachment.optDouble("size", 0) <= POST_ATTACHMENT_AUTO_BYTES && attachment.optString("localAssetId").isBlank())
                    result.put(new JSONObject(attachment.toString()));
            }
            return result;
        });
    }

    private static void requirePostAttachmentLibrary(NativeAppDatabase database) throws Exception {
        JSONObject active = parseState(database.getState(ACTIVE_STATE));
        if (active == null || active.optInt("version") != 1 || !("active".equals(active.optString("mode", "active")) || active.optString("mode").isEmpty())
            || !"verified-v1".equals(database.getState("migration:appdb:indexes:v1:active"))) throw new IllegalStateException("本机主库尚未就绪");
        JSONObject vault = database.getRecord("settings", VAULT_SETTING);
        if (vault != null && vault.optJSONObject("value") != null) throw new IllegalStateException("帖子附件需要解锁保险库");
    }

    static void setPostAttachmentState(NativeAppDatabase database, String messageKey, String state) throws Exception {
        database.withReadGuard(() -> {
            requirePostAttachmentLibrary(database);
            JSONObject message = database.getRecord("communitySourceMessages", JSONObject.quote(messageKey));
            if (message != null && message.optJSONObject("nativeInboxReceipt") != null) {
                message.getJSONObject("nativeInboxReceipt").put("attachmentState", state);
                database.applyBatch(new JSONArray().put(putOperation("communitySourceMessages", JSONObject.quote(messageKey), message)), true);
            }
            return null;
        });
    }

    static synchronized void savePostAttachment(NativeAppDatabase database, String messageKey, JSONObject identity,
        File payload, String mimeType, java.util.function.BooleanSupplier cancelled) throws Exception {
        if (cancelled.getAsBoolean()) throw new java.io.InterruptedIOException("收件已停止，附件断点仍保留");
        database.withReadGuard(() -> {
            if (cancelled.getAsBoolean()) throw new java.io.InterruptedIOException("收件已停止，附件断点仍保留");
            requirePostAttachmentLibrary(database);
            if (!readAutomationSettings(database).optBoolean("downloadPostMedia")) return null;
            JSONObject message = database.getRecord("communitySourceMessages", JSONObject.quote(messageKey));
            if (message == null) throw new IllegalStateException("帖子已不存在");
            JSONObject target = null;
            JSONArray attachments = message.getJSONArray("attachments");
            for (int i = 0; i < attachments.length(); i++) {
                JSONObject attachment = attachments.getJSONObject(i);
                if (identity.getString("id").equals(attachment.optString("id")) && identity.getString("url").equals(attachment.optString("url"))
                    && identity.optDouble("size") == attachment.optDouble("size")) target = attachment;
            }
            if (target == null) throw new IllegalStateException("帖子附件已变化，保留下载文件供核对");
            if (!target.optString("localAssetId").isBlank()) return null;
            long size = payload.length();
            if (size <= 0 || size > POST_ATTACHMENT_AUTO_BYTES) throw new IllegalArgumentException("附件超过本次自动下载上限");
            String contentHash = hashFile(payload), assetId = "asset-" + contentHash, key = JSONObject.quote(assetId);
            JSONObject asset = database.getRecord("assets", key);
            if (asset != null && asset.optBoolean("encrypted")) throw new IllegalStateException("已有附件需要解锁保险库");
            JSONObject file = database.getRecord("assetFiles", key);
            long now = System.currentTimeMillis();
            if (file == null) {
                NativeAppDatabase.BlobTransfer transfer = database.beginBlob("assetFiles", key, THUMBNAIL_PATH, size, mimeType, contentHash);
                long offset = transfer.offset;
                try (java.io.RandomAccessFile input = new java.io.RandomAccessFile(payload, "r")) {
                    input.seek(offset);
                    while (offset < size) {
                        if (cancelled.getAsBoolean()) throw new java.io.InterruptedIOException("收件已停止，附件断点仍保留");
                        byte[] chunk = new byte[(int) Math.min(NativeAppDatabase.MAX_BLOB_CHUNK_BYTES, size - offset)];
                        input.readFully(chunk); offset = database.appendBlob(transfer.token, offset, chunk);
                    }
                }
                JSONObject stored = database.completeBlob(transfer.token);
                file = new JSONObject().put("assetId", assetId).put("updatedAt", now)
                    .put("blob", blobReference(key, size, mimeType, stored, THUMBNAIL_PATH));
            }
            if (asset == null) asset = new JSONObject().put("assetId", assetId).put("contentHash", contentHash).put("mimeType", mimeType)
                .put("size", size).put("source", "remote").put("thumbnailRefs", new JSONObject()).put("webStorageRef", assetId)
                .put("remoteUrl", identity.getString("url")).put("encrypted", false).put("createdAt", now);
            asset.put("vaultProtected", true);
            target.put("localAssetId", assetId).put("localState", "local");
            if (cancelled.getAsBoolean()) throw new java.io.InterruptedIOException("收件已停止，附件断点仍保留");
            database.applyBatch(new JSONArray().put(putOperation("assets", key, asset)).put(putOperation("assetFiles", key, file))
                .put(putOperation("communitySourceMessages", JSONObject.quote(messageKey), message)), true);
            JSONObject readBack = database.getRecord("communitySourceMessages", JSONObject.quote(messageKey));
            if (readBack == null || !readBack.toString().equals(message.toString()) || database.getBlobPath("assetFiles", key, THUMBNAIL_PATH) == null)
                throw new IllegalStateException("附件保存读回校验失败");
            return null;
        });
    }

    static String cloudPostNotificationState(Context context, String messageKey, String id, String worker, String library, String state) throws Exception {
        if (messageKey == null || messageKey.isBlank()) return "";
        NativeAppDatabase database = new NativeAppDatabase(context);
        try { return cloudPostNotificationState(database, messageKey, id, worker, library, state); }
        finally { database.close(); }
    }

    static boolean canConfirmCloudSourceBound(NativeAppDatabase database, String hash) throws Exception {
        return database.withReadGuard(() -> {
            JSONObject active = parseState(database.getState(ACTIVE_STATE));
            if (active == null || "legacy".equals(active.optString("mode")) || "rolling-back".equals(active.optString("mode"))
                || !"verified-v1".equals(database.getState("migration:appdb:indexes:v1:active"))) return false;
            JSONObject vault = database.getRecord("settings", VAULT_SETTING);
            if (vault != null && vault.optJSONObject("value") != null) return false;
            JSONArray sources = database.queryKeyPage("communitySources", new JSONObject().put("indexName", "sourceKeyHash")
                .put("lower", JSONObject.quote(hash)).put("upper", JSONObject.quote(hash)).put("limit", 2)).getJSONArray("rows");
            for (int index = 0; index < sources.length(); index++) {
                JSONObject source = database.getRecord("communitySources", sources.getJSONObject(index).getString("primaryKey"));
                if (source != null && hash.equals(source.optString("sourceKeyHash"))
                    && database.countIndexEntries("resourceSourceBindings", "sourceId", JSONObject.quote(source.getString("id"))) > 0) return true;
            }
            return false;
        });
    }
    static String cloudPostNotificationState(NativeAppDatabase database, String messageKey, String id, String worker, String library, String state) throws Exception {
        return database.withReadGuard(() -> {
                JSONObject message = database.getRecord("communitySourceMessages", JSONObject.quote(messageKey));
                JSONObject receipt = message == null ? null : message.optJSONObject("nativeInboxReceipt");
                if (receipt == null || !id.equals(receipt.optString("id")) || !worker.equals(receipt.optString("workerUrl"))
                    || !library.equals(receipt.optString("libraryId"))) return "";
                String previous = receipt.optString("notificationState", "");
                if (state != null && !state.equals(previous)) {
                    JSONObject vault = database.getRecord("settings", VAULT_SETTING);
                    if (vault != null && vault.optJSONObject("value") != null) return previous;
                    receipt.put("notificationState", state);
                    database.applyBatch(new JSONArray().put(putOperation("communitySourceMessages", JSONObject.quote(messageKey), message)), true);
                }
                return previous;
        });
    }

    static boolean requiresForegroundImport(JSONObject metadata) {
        JSONObject outcome = metadata.optJSONObject("nativeImportOutcome");
        if (outcome == null) return false;
        String state = outcome.optString("state");
        JSONObject parsed = metadata.optJSONObject("nativeCharacterCardResult");
        // Old APKs left non-card attachments deferred even after parsing had finished.
        return "foreground_required".equals(state) || ("deferred".equals(state)
            && (metadata.optBoolean("nativeBackgroundImportFinished", false)
                || metadata.optBoolean("nativeCompletionNotificationPosted", false)
                || parsed != null && "not_character_card".equals(parsed.optString("state"))));
    }

    static boolean blocksAutoReceiveCycle(JSONObject metadata) {
        if (metadata.optBoolean("nativeBackgroundImportFinished", false)
            || metadata.optBoolean("nativeCompletionNotificationPosted", false)) return false;
        JSONObject outcome = metadata.optJSONObject("nativeImportOutcome");
        if (outcome == null) return !metadata.has("error");
        if (requiresForegroundImport(metadata)) return false;
        String state = outcome.optString("state");
        return "deferred".equals(state) || "native_database_unavailable".equals(state);
    }

    static boolean settleAutoReceiveMetadata(JSONObject metadata, boolean workFinished) throws Exception {
        if (blocksAutoReceiveCycle(metadata) && !workFinished) return false;
        JSONObject result = metadata.optJSONObject("nativeImportOutcome");
        if (workFinished) metadata.put("nativeBackgroundImportFinished", true);
        if (result == null && workFinished) {
            metadata.put("nativeImportOutcome", outcome("failed", "后台任务已结束，可在收件箱检查并重试"));
        } else if (requiresForegroundImport(metadata)) {
            String detail = result.optString("message", "");
            result.put("state", "foreground_required").put("message", detail.isBlank() ? "此附件需要在前台解析导入" : detail);
        }
        return true;
    }

    static long currentVersionImportedAt(JSONObject resource) {
        return resource.optLong("versionImportedAt", resource.optLong("createdAt"));
    }

    /** Reconcile completed automatic receives together at the inbox's 30-second check boundary. */
    static synchronized JSONArray reconcileAutoReceiveCycle(Context context, String receiveWindow) throws Exception {
        NativeAppDatabase database = new NativeAppDatabase(context);
        try { return reconcileAutoReceiveCycle(context, database, receiveWindow, new File(context.getFilesDir(), ShareReceiverPlugin.CACHE_FOLDER)); }
        finally { database.close(); }
    }

    static synchronized JSONArray reconcileAutoReceiveCycle(Context context, NativeAppDatabase database, String receiveWindow, File folder) throws Exception {
        JSONArray reconciledTokens = new JSONArray();
        if (receiveWindow == null || !receiveWindow.matches("[0-9]{1,13}")) return reconciledTokens;
        File[] receipts = folder.listFiles((dir, name) -> name.endsWith(".json"));
        if (receipts == null) receipts = new File[0];
        final File[] receiveReceipts = receipts;
        return database.withReadGuard(() -> {
            JSONObject active = parseState(database.getState(ACTIVE_STATE));
            if (active == null || "legacy".equals(active.optString("mode"))
                || "rolling-back".equals(active.optString("mode"))
                || !"verified-v1".equals(database.getState("migration:appdb:indexes:v1:active"))) return reconciledTokens;
            JSONObject vault = database.getRecord("settings", VAULT_SETTING);
            if (vault != null && vault.optJSONObject("value") != null) return reconciledTokens;
            JSONObject settings = readAutomationSettings(database);

            ArrayList<JSONObject> incoming = new ArrayList<>();
            HashSet<String> resourceIds = new HashSet<>();
            ArrayList<File> completedReceipts = new ArrayList<>();
            ArrayList<JSONObject> completedMetadata = new ArrayList<>();
            Set<String> finishedDownloads = null;
            for (File receipt : receiveReceipts) {
                JSONObject metadata;
                try { metadata = NativeShareImportService.readMetadata(receipt); }
                catch (Exception ignored) { continue; }
                if (!metadata.optBoolean("cloudAutoBindingPending", false)
                    || metadata.optBoolean("cloudAutoBindingOptOut", false)) continue;
                if (!receiveWindow.equals(metadata.optString("cloudAutoReceiveWindow", ""))) continue;
                boolean workFinished = false;
                if (blocksAutoReceiveCycle(metadata)) {
                    if (finishedDownloads == null) finishedDownloads = NativeDiscordDownloadWorker.finishedTokens(context);
                    String token = metadata.optString("discordSourceToken", receipt.getName().replaceFirst("\\.json$", ""));
                    workFinished = finishedDownloads.contains(token);
                }
                if (!settleAutoReceiveMetadata(metadata, workFinished)) return new JSONArray();
                JSONObject outcome = metadata.optJSONObject("nativeImportOutcome");
                String state = outcome == null ? "failed" : outcome.optString("state");
                completedReceipts.add(receipt);
                completedMetadata.add(metadata);
                String token = metadata.optString("discordSourceToken", "");
                if (("imported".equals(state) || "duplicate_file".equals(state) || "duplicate_card".equals(state))
                    && token.matches("discord-url-[a-fA-F0-9-]{36}")) reconciledTokens.put(token);
                if (!"imported".equals(state) && !"duplicate_file".equals(state) && !"duplicate_card".equals(state)) continue;
                String resourceId = outcome.optString("resourceId", "");
                if (resourceId.isBlank() || !resourceIds.add(resourceId)) continue;
                JSONObject row = database.getRecord("resourceListSummaries", JSONObject.quote(resourceId));
                if (row != null && "characterCard".equals(row.optString("type"))) incoming.add(row);
            }
            if (completedReceipts.isEmpty() && !"0".equals(receiveWindow)) return reconciledTokens;

            JSONArray pendingRows = database.getRecentRecordsByIndex("communitySources", "updatedAt", 100);
            ArrayList<JSONObject> pending = new ArrayList<>();
            for (int index = 0; index < pendingRows.length(); index++) {
                JSONObject row = pendingRows.optJSONObject(index);
                JSONObject source = row == null ? null : row.optJSONObject("value");
                if (source == null) continue;
                JSONObject scan = source.optJSONObject("autoBindScan");
                if (scan == null && !source.optBoolean("autoBindPendingPng", false)) continue;
                if (scan != null && "review".equals(scan.optString("status"))) continue;
                pending.add(source);
            }
            pending.sort((left, right) -> Long.compare(left.optLong("createdAt"), right.optLong("createdAt")));

            JSONArray operations = new JSONArray();
            JSONArray bindingNotices = new JSONArray();
            HashSet<String> claimedResources = new HashSet<>();
            long now = System.currentTimeMillis();
            ArrayList<JSONObject> recentCards = new ArrayList<>();
            JSONArray recentRows = pending.isEmpty() ? new JSONArray() : database.getRecentRecordsByIndex("resourceListSummaries", "updatedAt", AUTO_BIND_FUTURE_LIMIT,
                "type", JSONObject.quote("characterCard"));
            for (int index = 0; index < recentRows.length(); index++) recentCards.add(recentRows.getJSONObject(index).getJSONObject("value"));
            for (JSONObject source : pending) {
                if (operations.length() >= 96) {
                    database.applyBatch(operations, true);
                    operations = new JSONArray();
                }
                String sourceId = source.optString("id", "");
                if (sourceId.isBlank()) continue;
                if (database.countIndexEntries("resourceSourceBindings", "sourceId", JSONObject.quote(sourceId)) > 0) continue;
                JSONObject scan = source.optJSONObject("autoBindScan");
                JSONArray scanned = scan == null ? new JSONArray() : scan.optJSONArray("scannedResourceIds");
                JSONArray future = scan == null ? new JSONArray() : scan.optJSONArray("futureResourceIds");
                if (scanned == null) scanned = new JSONArray();
                if (future == null) future = new JSONArray();
                HashSet<String> scannedIds = jsonStringSet(scanned);
                HashSet<String> futureIds = jsonStringSet(future);
                boolean initialScan = source.optBoolean("nativeInitialAutoBindPending", false)
                    && scan != null && "scanning".equals(scan.optString("status"));
                ArrayList<JSONObject> fresh = new ArrayList<>();
                for (JSONObject resource : initialScan ? recentCards : incoming) {
                    String id = resource.optString("id", "");
                    if (!id.isBlank() && !scannedIds.contains(id) && !claimedResources.contains(id)
                        && database.countIndexEntries("resourceSourceBindings", "resourceId", JSONObject.quote(id)) == 0
                        && (initialScan || currentVersionImportedAt(resource) >= source.optLong("createdAt"))) fresh.add(resource);
                }
                if (initialScan) {
                    source.remove("nativeInitialAutoBindPending");
                    source.put("updatedAt", now);
                    if (fresh.isEmpty()) operations.put(putOperation("communitySources", JSONObject.quote(sourceId), source));
                }
                if (fresh.isEmpty()) continue;

                boolean nameEnabled = settings.optBoolean("bindSameName", false);
                boolean authorEnabled = settings.optBoolean("bindSameAuthor", false);
                ArrayList<JSONObject> eligible = new ArrayList<>();
                if (scan != null && "scanning".equals(scan.optString("status"))) {
                    int remaining = Math.max(0, AUTO_BIND_FUTURE_LIMIT - futureIds.size());
                    for (JSONObject resource : fresh) {
                        if (eligible.size() >= remaining) break;
                        if (!futureIds.contains(resource.optString("id"))) eligible.add(resource);
                    }
                }
                String starter = readStarterContent(database, sourceId);
                String searchable = normalize(source.optString("title", "") + "\n" + starter);
                ArrayList<JSONObject> nameMatches = new ArrayList<>();
                ArrayList<JSONObject> authorMatches = new ArrayList<>();
                if (!eligible.isEmpty() && nameEnabled) for (JSONObject resource : eligible) {
                    String name = normalize(resource.optString("name", ""));
                    if (!name.isEmpty() && searchable.contains(name)) nameMatches.add(resource);
                }
                if (nameMatches.isEmpty() && !eligible.isEmpty() && authorEnabled) {
                    String postAuthor = authorLabel(starter);
                    if (!postAuthor.isEmpty()) for (JSONObject resource : eligible) {
                        JSONObject metadata = resource.optJSONObject("metadata");
                        String creator = normalizeAuthor(metadata == null ? "" : metadata.optString("creator", ""));
                        if (!creator.isEmpty() && creator.equals(postAuthor)) authorMatches.add(resource);
                    }
                }
                ArrayList<JSONObject> candidates = !nameMatches.isEmpty() ? nameMatches : authorMatches;
                if (!candidates.isEmpty()) {
                    String rule = !nameMatches.isEmpty() ? "same-name" : "same-author";
                    if (candidates.size() > 1) {
                        JSONArray review = new JSONArray();
                        for (JSONObject candidate : candidates) {
                            JSONObject metadata = candidate.optJSONObject("metadata");
                            String reason = "same-name".equals(rule)
                                ? "角色卡名“" + candidate.optString("name") + "”出现在帖子标题或首楼"
                                : "帖子作者与角色卡作者“" + (metadata == null ? "" : metadata.optString("creator")) + "”一致";
                            review.put(new JSONObject().put("resourceId", candidate.optString("id"))
                                .put("resourceName", candidate.optString("name")).put("rule", rule).put("reason", reason));
                        }
                        source.put("autoBindScan", new JSONObject().put("version", 1).put("status", "review")
                            .put("scannedResourceIds", scanned).put("futureResourceIds", future).put("reviewCandidates", review));
                        source.remove("autoBindPendingPng");
                        source.put("updatedAt", now);
                        operations.put(putOperation("communitySources", JSONObject.quote(sourceId), source));
                        continue;
                    }
                    JSONObject chosen = candidates.get(0);
                    appendCloudAutoBinding(operations, source, chosen, rule, now);
                    claimedResources.add(chosen.optString("id"));
                    bindingNotices.put(autoBindingNotice(source, chosen));
                    continue;
                }

                // The next-PNG rule runs only after name and author checks across this whole batch.
                if (settings.optBoolean("bindNextPng", false) && source.optBoolean("autoBindPendingPng", false)) {
                    JSONObject png = null;
                    for (JSONObject resource : fresh) {
                        String id = resource.optString("id", "");
                        if (resource.optString("type").equals("characterCard")
                            && resource.optString("fileName", "").toLowerCase(Locale.ROOT).endsWith(".png")
                            && currentVersionImportedAt(resource) >= source.optLong("createdAt")
                            && !claimedResources.contains(id)) { png = resource; break; }
                    }
                    if (png != null) {
                        claimedResources.add(png.optString("id"));
                        appendCloudAutoBinding(operations, source, png, "next-png", now);
                        bindingNotices.put(autoBindingNotice(source, png));
                        continue;
                    }
                }

                if (!eligible.isEmpty()) {
                    JSONArray nextScanned = mergeStringArrays(scanned, eligible, "id");
                    JSONArray nextFuture = initialScan ? future : mergeStringArrays(future, eligible, "id");
                    source.put("autoBindScan", new JSONObject().put("version", 1)
                        .put("status", nextFuture.length() >= AUTO_BIND_FUTURE_LIMIT ? "exhausted" : "scanning")
                        .put("scannedResourceIds", nextScanned).put("futureResourceIds", nextFuture));
                    source.put("updatedAt", now);
                    operations.put(putOperation("communitySources", JSONObject.quote(sourceId), source));
                }
            }
            if (operations.length() > 0) database.applyBatch(operations, true);
            NativeDiscordInboxService.notifyAutoBindings(context, bindingNotices);
            for (int index = 0; index < completedReceipts.size(); index++) {
                String receiptName = completedReceipts.get(index).getName();
                String receiptToken = receiptName.substring(0, receiptName.length() - ".json".length());
                synchronized (NativeDiscordDownloadWorker.class) {
                    JSONObject metadata = NativeShareImportService.readMetadata(completedReceipts.get(index));
                    JSONObject settled = completedMetadata.get(index);
                    if (settled.optBoolean("nativeBackgroundImportFinished", false)) metadata.put("nativeBackgroundImportFinished", true);
                    if (!metadata.has("nativeImportOutcome") && settled.has("nativeImportOutcome"))
                        metadata.put("nativeImportOutcome", settled.getJSONObject("nativeImportOutcome"));
                    if (requiresForegroundImport(metadata)) metadata.getJSONObject("nativeImportOutcome").put("state", "foreground_required");
                    metadata.put("cloudAutoBindingPending", false).put("cloudAutoBindingReconciledAt", System.currentTimeMillis());
                    metadata.remove("cloudAutoReceiveWindow");
                    NativeShareImportService.writeMetadata(folder, receiptToken, metadata);
                }
            }
            return reconciledTokens;
            });
    }

    static JSONArray pendingAutoReceiveWindows(Context context) {
        JSONArray result = new JSONArray();
        HashSet<String> windows = new HashSet<>();
        File folder = new File(context.getFilesDir(), ShareReceiverPlugin.CACHE_FOLDER);
        File[] receipts = folder.listFiles((dir, name) -> name.endsWith(".json"));
        if (receipts == null) return result;
        for (File receipt : receipts) try {
            JSONObject metadata = NativeShareImportService.readMetadata(receipt);
            String window = metadata.optString("cloudAutoReceiveWindow", "");
            if (metadata.optBoolean("cloudAutoBindingPending", false)
                && !metadata.optBoolean("cloudAutoBindingOptOut", false)
                && window.matches("[0-9]{1,13}"))
                windows.add(window);
        } catch (Exception ignored) { /* Ignore unrelated or incomplete share receipts. */ }
        ArrayList<String> ordered = new ArrayList<>(windows);
        ordered.sort((left, right) -> Long.compare(Long.parseLong(left), Long.parseLong(right)));
        for (String window : ordered) result.put(window);
        return result;
    }

    static boolean hasPendingAutoReceiveWindow(Context context, String receiveWindow) {
        if (receiveWindow == null || !receiveWindow.matches("[0-9]{1,13}")) return false;
        File folder = new File(context.getFilesDir(), ShareReceiverPlugin.CACHE_FOLDER);
        File[] receipts = folder.listFiles((dir, name) -> name.endsWith(".json"));
        if (receipts == null) return false;
        for (File receipt : receipts) try {
            JSONObject metadata = NativeShareImportService.readMetadata(receipt);
            if (metadata.optBoolean("cloudAutoBindingPending", false)
                && !metadata.optBoolean("cloudAutoBindingOptOut", false)
                && receiveWindow.equals(metadata.optString("cloudAutoReceiveWindow", ""))) return true;
        } catch (Exception ignored) { /* Ignore unrelated and incomplete receipt files. */ }
        return false;
    }

    private static HashSet<String> jsonStringSet(JSONArray array) {
        HashSet<String> values = new HashSet<>();
        for (int index = 0; index < array.length(); index++) values.add(array.optString(index, ""));
        return values;
    }

    private static JSONArray mergeStringArrays(JSONArray existing, ArrayList<JSONObject> resources, String field) {
        JSONArray merged = new JSONArray();
        HashSet<String> seen = new HashSet<>();
        for (int index = 0; index < existing.length(); index++) {
            String value = existing.optString(index, "");
            if (!value.isBlank() && seen.add(value)) merged.put(value);
        }
        for (JSONObject resource : resources) {
            String value = resource.optString(field, "");
            if (!value.isBlank() && seen.add(value)) merged.put(value);
        }
        return merged;
    }

    private static void appendCloudAutoBinding(JSONArray operations, JSONObject source,
        JSONObject resource, String rule, long now) throws Exception {
        String sourceId = source.optString("id", ""), resourceId = resource.optString("id", "");
        if (sourceId.isBlank() || resourceId.isBlank()) return;
        source.remove("autoBindScan");
        source.remove("nativeInitialAutoBindPending");
        source.remove("autoBindPendingPng");
        source.put("updatedAt", now);
        JSONObject binding = new JSONObject().put("id", resourceId + ":source:" + sourceId)
            .put("resourceId", resourceId).put("sourceId", sourceId).put("autoBindingRule", rule)
            .put("note", "自动关联：" + ("same-name".equals(rule) ? "同名" : "same-author".equals(rule) ? "同作者" : "后续 PNG") + " · " + resource.optString("name"))
            .put("createdAt", now);
        operations.put(putOperation("communitySources", JSONObject.quote(sourceId), source));
        operations.put(putOperation("resourceSourceBindings", JSONObject.quote(binding.getString("id")), binding));
    }

    static JSONObject importIfSafe(Context context, File payload, File parsedFile, String fileName,
                                   String mimeType) throws Exception {
        NativeAppDatabase database = new NativeAppDatabase(context);
        try {
            return importIfSafe(context, database, payload, parsedFile, fileName, mimeType, false);
        } finally {
            database.close();
        }
    }

    static synchronized JSONObject importIfSafe(Context context, NativeAppDatabase database, File payload, File parsedFile,
                                   String fileName, String mimeType) throws Exception {
        return importIfSafe(context, database, payload, parsedFile, fileName, mimeType, false);
    }

    static synchronized JSONObject importIfSafe(Context context, NativeAppDatabase database, File payload, File parsedFile,
                                   String fileName, String mimeType, boolean deferAutoBinding) throws Exception {
        return database.withReadGuard(() -> importWithinReadGuard(context, database, payload, parsedFile, fileName, mimeType, deferAutoBinding));
    }

    private static JSONObject importWithinReadGuard(Context context, NativeAppDatabase database, File payload, File parsedFile,
                                   String fileName, String mimeType, boolean deferAutoBinding) throws Exception {
        JSONObject parsed = readJson(parsedFile);
        boolean characterCard = "characterCard".equals(parsed.optString("type"));
        if (!NativeTavernResourceParser.supportedType(parsed.optString("type")))
            return outcome("not_character_card", "附件不是角色卡");
        {
            JSONObject active = parseState(database.getState(ACTIVE_STATE));
            if (active == null || "legacy".equals(active.optString("mode"))
                || "rolling-back".equals(active.optString("mode")))
                return outcome("native_database_unavailable", "原生资源库尚未完成迁移");
            if (!"verified-v1".equals(database.getState("migration:appdb:indexes:v1:active")))
                return outcome("native_database_unavailable", "原生资源库索引尚未就绪");
            JSONObject vault = database.getRecord("settings", VAULT_SETTING);
            if (vault != null && vault.optJSONObject("value") != null)
                return outcome("vault_requires_foreground", "本地加密库需要在前台解锁后导入");

            JSONObject automationSettings = readAutomationSettings(database);
            String fileHash = hashFile(payload);
            DuplicateHashLookup duplicateHash = findCurrentResourceByHash(database, fileHash);
            if (duplicateHash.found) {
                JSONObject existingByHash = duplicateHash.currentResource;
                if (characterCard && existingByHash != null)
                    repairMissingThumbnail(database, payload, fileName, existingByHash.optString("id", ""));
                JSONObject autoBinding = !characterCard || deferAutoBinding ? null : bindExistingCardIfPossible(database, parsed, fileName,
                    existingByHash == null ? "" : existingByHash.optString("id", ""), automationSettings);
                JSONObject duplicate = outcome("duplicate_file", "资源库已存在完全相同的文件");
                duplicate.put("resourceType", parsed.optString("type"));
                if (existingByHash != null) duplicate.put("resourceId", existingByHash.optString("id", ""));
                addAutoBindingResult(context, duplicate, autoBinding, database);
                return duplicate;
            }

            if (characterCard) {
            JSONArray matches = findMatches(database, parsed, fileName, "resourceSummaries", false);
            // Preserve the existing active-content fast path: an exact same-format duplicate
            // does not need to scan every historical version record.
            if (hasContentDuplicate(matches)) {
                String duplicateResourceId = findContentDuplicateResourceId(database, matches);
                repairMissingThumbnail(database, payload, fileName, duplicateResourceId);
                JSONObject autoBinding = deferAutoBinding ? null : bindExistingCardIfPossible(database, parsed, fileName,
                    duplicateResourceId, automationSettings);
                JSONObject duplicate = outcome("duplicate_card", "资源库已存在卡内数据完全相同的角色卡")
                    .put("resourceId", duplicateResourceId);
                addAutoBindingResult(context, duplicate, autoBinding, database);
                return duplicate;
            }
            JSONArray versions = findMatches(database, parsed, fileName, "resourceVersionSummaries", true);
            matches = mergeMatches(matches, versions);
            if (automationSettings.optBoolean("preferPngContainer", false)) {
                JSONObject containerMatch = uniqueContainerMatch(matches, fileName);
                if (containerMatch != null) {
                    JSONObject containerResult = importPreferredPngContainer(
                        context, database, payload, parsed, fileName, mimeType, fileHash,
                        containerMatch, matches, automationSettings, deferAutoBinding);
                    if (containerResult != null) return containerResult;
                }
            }
            if (hasContentDuplicate(matches)) {
                String duplicateResourceId = findContentDuplicateResourceId(database, matches);
                repairMissingThumbnail(database, payload, fileName, duplicateResourceId);
                JSONObject autoBinding = deferAutoBinding ? null : bindExistingCardIfPossible(database, parsed, fileName,
                    duplicateResourceId, automationSettings);
                JSONObject duplicate = outcome("duplicate_card", "资源库已存在卡内数据完全相同的角色卡")
                    .put("resourceId", duplicateResourceId);
                addAutoBindingResult(context, duplicate, autoBinding, database);
                return duplicate;
            }
            if (matches.length() > 0) {
                JSONObject waiting = outcome("waiting_version", "发现相似角色卡，需要选择版本");
                waiting.put("candidateCount", matches.length()).put("candidates", matches);
                return waiting;
            }
            }

            long now = System.currentTimeMillis();
            String id = java.util.UUID.randomUUID().toString();
            String key = JSONObject.quote(id);
            String type = normalizedMimeType(fileName, mimeType);
            long size = payload.length();
            JSONObject resource = newResource(parsed, fileName, type, fileHash, size, id, now);

            JSONArray automationOperations = new JSONArray();
            JSONObject autoBinding = !characterCard || deferAutoBinding ? null : findAutoBinding(database, parsed, fileName, id, automationSettings, now);
            if (autoBinding != null) {
                JSONObject source = autoBinding.optJSONObject("source");
                JSONObject binding = autoBinding.getJSONObject("binding");
                if (source != null)
                    automationOperations.put(putOperation("communitySources",
                        JSONObject.quote(source.optString("id")), source));
                automationOperations.put(putOperation("resourceSourceBindings",
                    JSONObject.quote(binding.getString("id")), binding));
            }

            JSONObject attachment = storeAttachment(database, payload, id, key, type);
            resource.put("originalBlob", new JSONObject()
                .put("__srlAppDatabaseValueV1", "blob")
                .put("fieldPath", BLOB_PATH)
                .put("blobOwnerKey", key)
                .put("size", size)
                .put("mimeType", type)
                .put("sha256", attachment.getString("sha256")));
            String thumbnail = fileName.toLowerCase(Locale.ROOT).endsWith(".png")
                ? storeThumbnail(database, payload) : null;
            if (thumbnail != null) resource.put("thumbnailAssetId", thumbnail);
            JSONObject summary = new JSONObject(resource.toString());
            summary.remove("originalBlob");
            JSONObject listSummary = new JSONObject(summary.toString())
                .put("metadata", listMetadata(summary.optJSONObject("metadata")));

            JSONArray operations = new JSONArray()
                .put(putOperation("resources", key, resource))
                .put(putOperation("resourceSummaries", key, summary))
                .put(putOperation("resourceListSummaries", key, listSummary));
            for (int index = 0; index < automationOperations.length(); index++)
                operations.put(automationOperations.getJSONObject(index));
            try {
                if (resource.toString().length() > MAX_ROW_JSON_CHARS ||
                    summary.toString().length() > MAX_ROW_JSON_CHARS ||
                    listSummary.toString().length() > MAX_ROW_JSON_CHARS)
                    throw new IllegalStateException("资源数据较大，请打开资源库完成导入");
                database.applyBatch(operations, true);
            } catch (Exception error) {
                database.deleteBlob("resources", key, BLOB_PATH);
                throw error;
            }
            JSONObject result = outcome("imported", NativeTavernResourceParser.label(parsed.optString("type")) + "已在后台解析并导入原生资源库")
                .put("resourceType", parsed.optString("type"))
                .put("resourceId", id).put("contentHash", fileHash).put("name", resource.optString("name"));
            addAutoBindingResult(context, result, autoBinding, database);
            return result;
        }
    }

    private static JSONObject uniqueContainerMatch(JSONArray matches, String incomingFileName) {
        boolean incomingPng = incomingFileName.toLowerCase(Locale.ROOT).endsWith(".png");
        JSONObject selected = null;
        for (int index = 0; index < matches.length(); index++) {
            JSONObject match = matches.optJSONObject(index);
            if (match == null || !"containerVariant".equals(match.optString("matchKind"))) continue;
            String matchedName = match.optString("fileName", "");
            boolean matchedPng = matchedName.toLowerCase(Locale.ROOT).endsWith(".png");
            if (incomingPng == matchedPng) continue;
            if (selected != null) return null;
            selected = match;
        }
        return selected;
    }

    private static JSONObject importPreferredPngContainer(Context context, NativeAppDatabase database,
        File payload, JSONObject parsed, String fileName, String mimeType, String fileHash,
        JSONObject match, JSONArray matches, JSONObject automationSettings, boolean deferAutoBinding) throws Exception {
        String targetId = match.optString("resourceId", "");
        boolean matchedHistorical = match.optBoolean("historical");
        if (matchedHistorical) targetId = match.optString("versionGroupId", "");
        if (targetId.isBlank()) return null;
        String targetKey = JSONObject.quote(targetId);
        long now = System.currentTimeMillis();
        String type = normalizedMimeType(fileName, mimeType);
        JSONObject current = database.getRecord("resources", targetKey);
        if (current == null) return null;
        if (matchedHistorical)
            return storeHistoricalContainer(context, database, payload, parsed, fileName, type, fileHash,
                current, match, targetId, automationSettings, now, deferAutoBinding);
        boolean incomingPng = fileName.toLowerCase(Locale.ROOT).endsWith(".png");
        boolean currentPng = current.optString("fileName", "").toLowerCase(Locale.ROOT).endsWith(".png");
        if (incomingPng == currentPng && !matchedHistorical) return null;
        // A second JSON representation is still the same-format duplicate. Keep the PNG
        // current, and do not manufacture another JSON history record for it.
        if (!incomingPng) {
            for (int index = 0; index < matches.length(); index++) {
                JSONObject candidate = matches.optJSONObject(index);
                if (candidate != null && "contentDuplicate".equals(candidate.optString("matchKind")))
                    return outcome("duplicate_card", "PNG 封装已保留；资源库已有相同角色卡 JSON 文件")
                        .put("resourceId", targetId).put("name", current.optString("name"));
            }
        }

        long size = payload.length();
        JSONObject incoming = newResource(parsed, fileName, type, fileHash, size,
            java.util.UUID.randomUUID().toString(), now);
        JSONArray operations = new JSONArray();
        String bindingResourceId = targetId;
        String attachmentStore = incomingPng ? "resources" : "resourceVersions";
        String attachmentKey = JSONObject.quote(incoming.optString("id"));

        if (incomingPng) {
            String stagedKey = JSONObject.quote(incoming.optString("id"));
            String versionId = java.util.UUID.randomUUID().toString();
            String versionKey = JSONObject.quote(versionId);
            JSONObject archived = new JSONObject(current.toString())
                .put("id", versionId)
                .put("versionGroupId", targetId)
                .put("versionNote", "同内容 JSON / PNG 封装")
                .put("versionVariantKind", "container");
            JSONObject archivedBlob = archived.optJSONObject("originalBlob");
            if (archivedBlob != null) archivedBlob.remove("blobOwnerKey");
            JSONObject archivedBackup = archived.optJSONObject("backupDescriptor");
            if (archivedBackup != null) archivedBackup.put("resourceId", versionId);
            JSONObject archivedMetadata = archived.optJSONObject("metadata");
            if (archivedMetadata == null) archivedMetadata = new JSONObject();
            archived.put("metadata", new JSONObject(archivedMetadata.toString())
                .put("versionVariantKind", "container"));
            long logicalCount = Math.max(1, current.optLong("versionCount", 1));
            archived.put("versionCount", logicalCount)
                .put("versionImportedAt", current.optLong("versionImportedAt", current.optLong("createdAt", now)))
                .put("versionLabel", current.optString("versionLabel", versionLabel(current.optJSONObject("metadata"), current.optString("fileName"))));

            incoming.put("id", targetId)
                .put("versionCount", logicalCount)
                .put("createdAt", current.optLong("createdAt", now));
            JSONObject incomingBackup = incoming.optJSONObject("backupDescriptor");
            if (incomingBackup != null) incomingBackup.put("resourceId", targetId);
            JSONObject incomingMetadata = incoming.optJSONObject("metadata");
            if (incomingMetadata == null) incomingMetadata = new JSONObject();
            incoming.put("metadata", new JSONObject(incomingMetadata.toString())
                .put("versionVariantKind", "container"));
            preserveUserFields(incoming, current);
            attachmentStore = "resources";
            attachmentKey = stagedKey;
            JSONObject attachment = storeAttachment(database, attachmentStore, payload,
                incoming.optString("id"), attachmentKey, type);
            incoming.put("originalBlob", blobReference(stagedKey, size, type, attachment));
            String thumbnail = incomingPng ? storeThumbnail(database, payload) : null;
            if (thumbnail != null) incoming.put("thumbnailAssetId", thumbnail);
            JSONObject archivedSummary = resourceSummary(archived);
            JSONObject archivedList = listSummary(archivedSummary);
            JSONObject currentSummary = resourceSummary(incoming);
            JSONObject currentList = listSummary(currentSummary);
            operations.put(moveBlobsOperation("resources", targetKey, "resourceVersions", versionKey))
                .put(putOperation("resourceVersions", versionKey, archived))
                .put(putOperation("resourceVersionSummaries", versionKey, archivedSummary))
                .put(putOperation("resources", targetKey, incoming))
                .put(putOperation("resourceSummaries", targetKey, currentSummary))
                .put(putOperation("resourceListSummaries", targetKey, currentList));
        } else {
            String versionId = incoming.optString("id");
            String versionKey = JSONObject.quote(versionId);
            long logicalCount = Math.max(1, current.optLong("versionCount", 1));
            incoming.put("versionGroupId", targetId)
                .put("versionCount", logicalCount)
                .put("versionNote", "同内容 JSON / PNG 封装");
            JSONObject metadata = incoming.optJSONObject("metadata");
            if (metadata == null) metadata = new JSONObject();
            incoming.put("metadata", new JSONObject(metadata.toString()).put("versionVariantKind", "container"));

            current.put("versionCount", logicalCount).put("updatedAt", now);
            attachmentStore = "resourceVersions";
            attachmentKey = versionKey;
            JSONObject attachment = storeAttachment(database, attachmentStore, payload,
                versionId, attachmentKey, type);
            JSONObject versionBlob = blobReference(versionKey, size, type, attachment);
            versionBlob.remove("blobOwnerKey");
            incoming.put("originalBlob", versionBlob);
            JSONObject versionSummary = resourceSummary(incoming);
            JSONObject currentSummary = resourceSummary(current);
            operations.put(putOperation("resourceVersions", versionKey, incoming))
                .put(putOperation("resourceVersionSummaries", versionKey, versionSummary))
                .put(putOperation("resources", targetKey, current))
                .put(putOperation("resourceSummaries", targetKey, currentSummary))
                .put(putOperation("resourceListSummaries", targetKey, listSummary(currentSummary)));
        }

        JSONObject autoBinding = deferAutoBinding ? null : findAutoBinding(database, parsed, fileName, bindingResourceId, automationSettings, now);
        appendAutoBindingOperations(operations, autoBinding);
        try {
            for (int index = 0; index < operations.length(); index++) {
                JSONObject operation = operations.optJSONObject(index);
                if (operation == null) continue;
                JSONArray rows = operation.optJSONArray("rows");
                if (rows != null) for (int row = 0; row < rows.length(); row++) {
                    JSONObject record = rows.optJSONObject(row);
                    JSONObject value = record == null ? null : record.optJSONObject("value");
                    if (value != null && value.toString().length() > MAX_ROW_JSON_CHARS)
                        throw new IllegalStateException("角色卡数据较大，请打开资源库完成导入");
                }
            }
            database.applyBatch(operations, true);
        } catch (Exception error) {
            database.deleteBlob(attachmentStore, attachmentKey, BLOB_PATH);
            throw error;
        }
        JSONObject result = outcome("imported", incomingPng
            ? "PNG 封装已设为当前资源，原 JSON 已保留为不同封装"
            : "JSON 已保存为不同封装，PNG 当前封装保持不变")
            .put("resourceId", targetId).put("contentHash", fileHash)
            .put("name", incoming.optString("name")).put("containerPreference", "png-current")
            .put("importedAs", incomingPng ? "current-png-container" : "json-container-variant");
        addAutoBindingResult(context, result, autoBinding, database);
        return result;
    }

    private static JSONObject storeHistoricalContainer(Context context, NativeAppDatabase database, File payload,
        JSONObject parsed, String fileName, String type, String fileHash, JSONObject current,
        JSONObject match, String targetId, JSONObject automationSettings, long now,
        boolean deferAutoBinding) throws Exception {
        String selectedKey = JSONObject.quote(match.optString("resourceId", ""));
        JSONObject selected = database.getRecord("resourceVersions", selectedKey);
        if (selected == null || !targetId.equals(selected.optString("versionGroupId", ""))) return null;
        boolean incomingPng = fileName.toLowerCase(Locale.ROOT).endsWith(".png");
        boolean selectedPng = selected.optString("fileName", "").toLowerCase(Locale.ROOT).endsWith(".png");
        if (incomingPng == selectedPng) return null;
        String incomingId = java.util.UUID.randomUUID().toString();
        String incomingKey = JSONObject.quote(incomingId);
        long logicalCount = Math.max(1, current.optLong("versionCount", 1));
        JSONObject incoming = newResource(parsed, fileName, type, fileHash, payload.length(), incomingId, now)
            .put("versionGroupId", targetId)
            .put("versionCount", logicalCount)
            .put("versionNote", "同内容 JSON / PNG 封装");
        JSONObject incomingMetadata = incoming.optJSONObject("metadata");
        if (incomingMetadata == null) incomingMetadata = new JSONObject();
        incoming.put("metadata", new JSONObject(incomingMetadata.toString()).put("versionVariantKind", "container"));
        JSONObject incomingAttachment = storeAttachment(database, "resourceVersions", payload,
            incomingId, incomingKey, type);
        JSONObject incomingBlob = blobReference(incomingKey, payload.length(), type, incomingAttachment);
        incomingBlob.remove("blobOwnerKey");
        incoming.put("originalBlob", incomingBlob);
        JSONArray operations = new JSONArray()
            .put(putOperation("resourceVersions", incomingKey, incoming))
            .put(putOperation("resourceVersionSummaries", incomingKey, resourceSummary(incoming)));
        JSONObject autoBinding = deferAutoBinding ? null : findAutoBinding(database, parsed, fileName, targetId, automationSettings, now);
        appendAutoBindingOperations(operations, autoBinding);
        try {
            database.applyBatch(operations, true);
        } catch (Exception error) {
            database.deleteBlob("resourceVersions", incomingKey, BLOB_PATH);
            throw error;
        }
        JSONObject result = outcome("imported", "历史封装已保存；当前版本保持不变")
            .put("resourceId", targetId).put("contentHash", fileHash)
            .put("name", incoming.optString("name")).put("containerPreference", "png-current")
            .put("importedAs", "historical-container-variant");
        addAutoBindingResult(context, result, autoBinding, database);
        return result;
    }

    private static JSONObject newResource(JSONObject parsed, String fileName, String type, String fileHash,
                                            long size, String id, long now) throws Exception {
        return new JSONObject(parsed.toString())
            .put("tags", parsed.optJSONArray("tags") == null ? new JSONArray() : parsed.getJSONArray("tags"))
            .put("id", id).put("fileName", fileName).put("mimeType", type).put("fileSize", size)
            .put("contentHash", fileHash)
            .put("backupDescriptor", new JSONObject().put("version", 1).put("resourceId", id)
                .put("contentHash", fileHash).put("size", size).put("updatedAt", now))
            .put("favorite", false).put("categoryId", JSONObject.NULL).put("categoryIds", new JSONArray())
            .put("relatedResourceIds", new JSONArray()).put("sourceLinks", new JSONArray())
            .put("versionImportedAt", now).put("versionCount", 1).put("createdAt", now).put("updatedAt", now)
            .put("versionLabel", versionLabel(parsed.optJSONObject("metadata"), fileName));
    }

    private static void preserveUserFields(JSONObject incoming, JSONObject current) throws Exception {
        for (String field : new String[] {"favorite", "categoryId", "categoryIds", "relatedResourceIds", "sourceLinks", "tags", "thumbnailAssetId"})
            if (current.has(field)) incoming.put(field, current.get(field));
        JSONObject metadata = incoming.optJSONObject("metadata");
        JSONObject previous = current.optJSONObject("metadata");
        if (metadata == null) metadata = new JSONObject();
        if (previous != null) for (String field : new String[] {
            "authorNote", "manuallyBoundResourceIds", "resourceCoverId", "characterContentEdits", "recognizedFileHashes"})
            if (previous.has(field)) metadata.put(field, previous.get(field));
        incoming.put("metadata", metadata);
    }

    private static JSONObject resourceSummary(JSONObject resource) throws Exception {
        JSONObject summary = new JSONObject(resource.toString());
        summary.remove("originalBlob");
        return summary;
    }

    private static JSONObject listSummary(JSONObject summary) throws Exception {
        return new JSONObject(summary.toString()).put("metadata", listMetadata(summary.optJSONObject("metadata")));
    }

    private static JSONObject blobReference(String ownerKey, long size, String type, JSONObject attachment) throws Exception {
        return blobReference(ownerKey, size, type, attachment, BLOB_PATH);
    }

    private static JSONObject autoBindingNotice(JSONObject source, JSONObject resource) throws Exception {
        return new JSONObject().put("sourceTitle", source.optString("title", "未命名帖子"))
            .put("resourceName", resource.optString("name", "未命名角色卡"))
            .put("sourceId", source.optString("id")).put("resourceId", resource.optString("id"));
    }

    private static JSONObject blobReference(String ownerKey, long size, String type, JSONObject attachment,
                                            String fieldPath) throws Exception {
        return new JSONObject().put("__srlAppDatabaseValueV1", "blob").put("fieldPath", fieldPath)
            .put("blobOwnerKey", ownerKey).put("size", size).put("mimeType", type)
            .put("sha256", attachment.getString("sha256"));
    }

    /** Best-effort list preview: a bad/unsupported image must never block the original import. */
    private static String storeThumbnail(NativeAppDatabase database, File png) {
        String preview = storeThumbnail(database, png, THUMBNAIL_MAX_EDGE);
        if (preview == null) return null;
        String card = storeThumbnail(database, png, 320);
        if (card != null) try {
            String key = JSONObject.quote(preview);
            JSONObject asset = database.getRecord("assets", key);
            JSONObject refs = asset.optJSONObject("thumbnailRefs");
            if (refs == null) refs = new JSONObject();
            asset.put("thumbnailRefs", refs.put("card", card));
            database.applyBatch(new JSONArray().put(putOperation("assets", key, asset)), true);
        } catch (Exception ignored) { /* The full preview remains usable. */ }
        return preview;
    }

    private static String storeThumbnail(NativeAppDatabase database, File png, int maxEdge) {
        byte[] bytes = null;
        NativeAppDatabase.BlobTransfer transfer = null;
        try {
            Bitmap scaled = NativeImageDecoder.thumbnail(png, maxEdge);
            if (scaled == null) return null;
            try {
                ByteArrayOutputStream output = new ByteArrayOutputStream();
                if (!scaled.compress(Bitmap.CompressFormat.JPEG, 84, output)) return null;
                bytes = output.toByteArray();
            } finally { scaled.recycle(); }
            if (bytes.length == 0 || bytes.length > NativeAppDatabase.MAX_BLOB_BYTES) return null;
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
            StringBuilder hex = new StringBuilder();
            for (byte value : digest) hex.append(String.format(Locale.ROOT, "%02x", value & 0xff));
            String contentHash = hex.toString();
            String assetId = "asset-" + contentHash;
            String encodedKey = JSONObject.quote(assetId);
            JSONObject existing = database.getRecord("assets", encodedKey);
            if (existing != null && existing.optBoolean("encrypted")) return null;
            // Use the same content-addressed asset owner as foreground imports. The
            // lightweight list deliberately strips inline Blob values.
            transfer = database.beginBlob("assetFiles", encodedKey, THUMBNAIL_PATH,
                bytes.length, "image/jpeg");
            long offset = transfer.offset;
            if (offset > bytes.length) throw new IllegalStateException("缩略图暂存位置无效");
            while (offset < bytes.length) {
                int count = (int) Math.min(NativeAppDatabase.MAX_BLOB_CHUNK_BYTES, bytes.length - offset);
                byte[] chunk = java.util.Arrays.copyOfRange(bytes, (int) offset, (int) offset + count);
                offset = database.appendBlob(transfer.token, offset, chunk);
            }
            JSONObject stored = database.completeBlob(transfer.token);
            long now = System.currentTimeMillis();
            JSONObject asset = existing == null ? new JSONObject()
                .put("assetId", assetId).put("contentHash", contentHash).put("mimeType", "image/jpeg")
                .put("size", bytes.length).put("source", "thumbnail").put("thumbnailRefs", new JSONObject())
                .put("webStorageRef", assetId).put("vaultProtected", true).put("encrypted", false)
                .put("createdAt", now) : existing;
            asset.put("vaultProtected", true);
            JSONObject file = new JSONObject().put("assetId", assetId).put("updatedAt", now)
                .put("blob", blobReference(encodedKey, bytes.length, "image/jpeg", stored, THUMBNAIL_PATH));
            database.applyBatch(new JSONArray().put(putOperation("assets", encodedKey, asset))
                .put(putOperation("assetFiles", encodedKey, file)), true);
            return assetId;
        } catch (Exception ignored) {
            // Keep an existing thumbnail intact if regeneration failed. A partial transfer is
            // resumed or replaced by beginBlob on the next successful import.
            return null;
        }
    }

    private static void repairMissingThumbnail(NativeAppDatabase database, File payload,
                                              String fileName, String resourceId) {
        if (resourceId == null || resourceId.isBlank()
            || !fileName.toLowerCase(Locale.ROOT).endsWith(".png")) return;
        String key = JSONObject.quote(resourceId);
        try {
            JSONObject resource = database.getRecord("resources", key);
            if (resource == null || !resource.optString("thumbnailAssetId", "").isEmpty()) return;
            String thumbnail = storeThumbnail(database, payload);
            if (thumbnail == null) return;
            resource.put("thumbnailAssetId", thumbnail);
            JSONObject summary = resourceSummary(resource);
            database.applyBatch(new JSONArray().put(putOperation("resources", key, resource))
                .put(putOperation("resourceSummaries", key, summary))
                .put(putOperation("resourceListSummaries", key, listSummary(summary))), true);
        } catch (Exception ignored) {
            // Thumbnail repair must not turn a harmless duplicate into a failed receipt.
        }
    }

    private static JSONObject moveBlobsOperation(String fromStore, String fromKey, String toStore,
                                                  String toKey) throws Exception {
        return new JSONObject().put("type", "moveBlobs").put("store", fromStore)
            .put("fromStore", fromStore).put("fromKey", fromKey).put("toStore", toStore).put("toKey", toKey);
    }

    private static void appendAutoBindingOperations(JSONArray operations, JSONObject autoBinding) throws Exception {
        if (autoBinding == null) return;
        JSONObject source = autoBinding.optJSONObject("source");
        JSONObject binding = autoBinding.getJSONObject("binding");
        if (source != null) operations.put(putOperation("communitySources", JSONObject.quote(source.optString("id")), source));
        operations.put(putOperation("resourceSourceBindings", JSONObject.quote(binding.getString("id")), binding));
    }

    private static JSONObject readJson(File file) throws Exception {
        if (!file.isFile() || file.length() > 32L * 1024L * 1024L)
            throw new IllegalArgumentException("原生解析结果缺失或超出大小限制");
        byte[] bytes = new byte[(int) file.length()];
        try (FileInputStream input = new FileInputStream(file)) {
            int offset = 0;
            while (offset < bytes.length) {
                int count = input.read(bytes, offset, bytes.length - offset);
                if (count < 0) throw new java.io.IOException("原生解析结果读取不完整");
                offset += count;
            }
        }
        return new JSONObject(new String(bytes, java.nio.charset.StandardCharsets.UTF_8));
    }

    private static JSONObject parseState(String raw) {
        if (raw == null || raw.isBlank()) return null;
        try {
            JSONObject state = new JSONObject(raw);
            return state.optInt("version") == 1 ? state : null;
        } catch (Exception ignored) { return null; }
    }

    private static JSONObject readAutomationSettings(NativeAppDatabase database) {
        JSONObject record = database.getRecord("settings", JSONObject.quote("discordInbox.automation.v1"));
        return record == null ? new JSONObject() : record.optJSONObject("value") == null
            ? new JSONObject() : record.optJSONObject("value");
    }

    private static JSONObject findAutoBinding(NativeAppDatabase database, JSONObject parsed, String fileName,
                                               String resourceId, JSONObject settings, long now) throws Exception {
        if (!"characterCard".equals(parsed.optString("type"))) return null;
        if (database.countIndexEntries("resourceSourceBindings", "resourceId", JSONObject.quote(resourceId)) > 0) return null;
        boolean sameNameEnabled = settings.optBoolean("bindSameName", false);
        boolean sameAuthorEnabled = settings.optBoolean("bindSameAuthor", false);
        boolean nextPngEnabled = settings.optBoolean("bindNextPng", false) && fileName.toLowerCase(Locale.ROOT).endsWith(".png");
        if (!sameNameEnabled && !sameAuthorEnabled && !nextPngEnabled) return null;

        ArrayList<JSONObject> recent = new ArrayList<>();
        JSONArray sourceRows = database.getRecentRecordsByIndex("communitySources", "updatedAt", 5);
        for (int index = 0; index < sourceRows.length(); index++) {
            JSONObject row = sourceRows.optJSONObject(index);
            JSONObject source = row == null ? null : row.optJSONObject("value");
            if (source != null) recent.add(source);
        }
        if (recent.isEmpty()) return null;

        ArrayList<JSONObject> nameMatches = new ArrayList<>();
        ArrayList<JSONObject> authorMatches = new ArrayList<>();
        ArrayList<JSONObject> pendingPng = new ArrayList<>();
        String cardName = normalize(parsed.optString("name", ""));
        JSONObject metadata = parsed.optJSONObject("metadata");
        String creator = normalizeAuthor(parsed.optString("creator", metadata == null ? "" : metadata.optString("creator", "")));
        for (JSONObject source : recent) {
            String sourceId = source.optString("id", "");
            if (sourceId.isBlank()) continue;
            // A committed earlier post must not make the next post's author match ambiguous.
            if (database.countIndexEntries("resourceSourceBindings", "sourceId", JSONObject.quote(sourceId)) > 0) continue;
            JSONObject scan = source.optJSONObject("autoBindScan");
            if (scan != null && "review".equals(scan.optString("status"))) continue;
            String starterContent = readStarterContent(database, sourceId);
            if (sameNameEnabled && !cardName.isEmpty()
                && normalize(source.optString("title", "") + "\n" + starterContent).contains(cardName))
                nameMatches.add(source);
            if (sameAuthorEnabled && !creator.isEmpty() && creator.equals(authorLabel(starterContent)))
                authorMatches.add(source);
            if (nextPngEnabled && source.optBoolean("autoBindPendingPng", false)) pendingPng.add(source);
        }

        String rule = null;
        JSONObject source = unique(nameMatches);
        if (source != null) rule = "same-name";
        else if (!nameMatches.isEmpty()) return null;
        if (source == null) {
            source = unique(authorMatches);
            if (source != null) rule = "same-author";
            else if (!authorMatches.isEmpty()) return null;
        }
        if (source == null && !pendingPng.isEmpty()) {
            // Recent sources are newest-first; the oldest marked post owns the next PNG.
            source = pendingPng.get(pendingPng.size() - 1);
            rule = "next-png";
        }
        if (source == null || rule == null) return null;

        String sourceId = source.getString("id");
        source.remove("autoBindPendingPng");
        source.remove("autoBindScan");
        source.put("updatedAt", now);
        JSONObject binding = new JSONObject()
            .put("id", resourceId + ":source:" + sourceId)
            .put("resourceId", resourceId)
            .put("sourceId", sourceId)
            .put("autoBindingRule", rule)
            .put("note", "自动关联：" + ("same-name".equals(rule) ? "同名" : "same-author".equals(rule) ? "同作者" : "后续 PNG") + " · " + parsed.optString("name"))
            .put("createdAt", now);
        return new JSONObject().put("source", source)
            .put("binding", binding);
    }

    private static JSONObject unique(ArrayList<JSONObject> candidates) {
        return candidates.size() == 1 ? candidates.get(0) : null;
    }

    private static String readStarterContent(NativeAppDatabase database, String sourceId) throws Exception {
        JSONArray compoundKey = new JSONArray().put(sourceId).put("starter");
        JSONArray entries = database.getIndexEntries("communitySourceMessages", "[sourceId+kind]", compoundKey.toString());
        if (entries.length() == 0) return "";
        String key = entries.optJSONObject(0) == null ? "" : entries.optJSONObject(0).optString("primaryKey", "");
        if (key.isEmpty()) return "";
        JSONObject row = database.getRecordsByKeys("communitySourceMessages", new JSONArray().put(key)).optJSONObject(0);
        JSONObject message = row == null ? null : row.optJSONObject("value");
        return message == null ? "" : message.optString("content", "");
    }

    private static String authorLabel(String content) {
        java.util.regex.Matcher matcher = java.util.regex.Pattern
            .compile("(?:^|\\n)\\s*(?:作者|author)\\s*[:：]\\s*([^\\r\\n]+)", java.util.regex.Pattern.CASE_INSENSITIVE)
            .matcher(content == null ? "" : content);
        return matcher.find() ? normalizeAuthor(matcher.group(1)) : "";
    }

    private static String normalizeAuthor(String value) {
        return normalize(value).replaceFirst("^dc\\s*", "").trim();
    }

    private static String normalize(String value) {
        return java.text.Normalizer.normalize(value == null ? "" : value, java.text.Normalizer.Form.NFKC)
            .trim().replaceAll("\\s+", " ").toLowerCase(Locale.ROOT);
    }

    private static DuplicateHashLookup findCurrentResourceByHash(NativeAppDatabase database, String hash)
        throws Exception {
        DuplicateHashLookup active = findCurrentResourceByHash(database, "resourceSummaries", hash);
        return active.found ? active : findCurrentResourceByHash(database, "resourceVersionSummaries", hash);
    }

    private static DuplicateHashLookup findCurrentResourceByHash(NativeAppDatabase database, String store,
                                                                  String hash) throws Exception {
        // Hash lookup stays on the verified index. Resolve historical duplicates back to their
        // active resource so an already-present cloud card can still bind its matching post.
        JSONArray indexed = database.getIndexEntries(
            store, "contentHash", JSONObject.quote(hash.toLowerCase(Locale.ROOT)));
        for (int offset = 0; offset < indexed.length(); offset += 900) {
            JSONArray keys = new JSONArray();
            for (int index = offset; index < Math.min(indexed.length(), offset + 900); index++) {
                JSONObject entry = indexed.optJSONObject(index);
                if (entry != null) keys.put(entry.optString("primaryKey"));
            }
            JSONArray rows = database.getRecordsByKeys(store, keys);
            for (int index = 0; index < rows.length(); index++) {
                JSONObject row = rows.optJSONObject(index);
                JSONObject summary = row == null ? null : row.optJSONObject("value");
                if (summary == null || !hash.equalsIgnoreCase(summary.optString("contentHash"))) continue;
                if (summary.optBoolean("encrypted"))
                    throw new IllegalStateException("本地加密库需要在前台解锁后导入");
                JSONObject current = resolveCurrentResource(database, summary.optString("id", ""),
                    summary.optString("versionGroupId", ""));
                return new DuplicateHashLookup(true, current);
            }
        }
        return new DuplicateHashLookup(false, null);
    }

    private static String findContentDuplicateResourceId(NativeAppDatabase database, JSONArray matches)
        throws Exception {
        Set<String> resourceIds = new HashSet<>();
        for (int index = 0; index < matches.length(); index++) {
            JSONObject match = matches.optJSONObject(index);
            if (match == null || !"contentDuplicate".equals(match.optString("matchKind"))) continue;
            JSONObject current = resolveCurrentResource(database, match.optString("resourceId", ""),
                match.optString("versionGroupId", ""));
            if (current != null) resourceIds.add(current.optString("id", ""));
        }
        resourceIds.remove("");
        return resourceIds.size() == 1 ? resourceIds.iterator().next() : "";
    }

    private static JSONObject resolveCurrentResource(NativeAppDatabase database, String resourceId,
                                                       String versionGroupId) throws Exception {
        if (resourceId != null && !resourceId.isBlank()) {
            JSONObject current = database.getRecord("resources", JSONObject.quote(resourceId));
            if (current != null) return current;
            JSONObject version = database.getRecord("resourceVersions", JSONObject.quote(resourceId));
            if (version != null && versionGroupId.isBlank())
                versionGroupId = version.optString("versionGroupId", "");
        }
        return versionGroupId == null || versionGroupId.isBlank()
            ? null : database.getRecord("resources", JSONObject.quote(versionGroupId));
    }

    private static JSONObject bindExistingCardIfPossible(NativeAppDatabase database, JSONObject parsed,
        String fileName, String resourceId, JSONObject settings) throws Exception {
        if (resourceId == null || resourceId.isBlank()) return null;
        JSONObject autoBinding = findAutoBinding(database, parsed, fileName, resourceId, settings,
            System.currentTimeMillis());
        if (autoBinding == null) return null;
        JSONArray operations = new JSONArray();
        appendAutoBindingOperations(operations, autoBinding);
        database.applyBatch(operations, true);
        return autoBinding;
    }

    private static void addAutoBindingResult(Context context, JSONObject result, JSONObject autoBinding,
                                             NativeAppDatabase database) throws Exception {
        if (autoBinding == null) return;
        JSONObject binding = autoBinding.getJSONObject("binding");
        String sourceId = binding.optString("sourceId");
        JSONObject source = database.getRecord("communitySources", JSONObject.quote(sourceId));
        JSONObject resource = database.getRecord("resourceListSummaries",
            JSONObject.quote(binding.optString("resourceId")));
        result.put("autoBoundSourceId", sourceId)
            .put("autoBoundSourceTitle", source == null ? "" : source.optString("title", ""))
            .put("autoBoundResourceName", resource == null ? result.optString("name", "") : resource.optString("name", ""))
            .put("autoBindingRule", binding.optString("autoBindingRule"));
        NativeDiscordInboxService.notifyAutoBindings(context, new JSONArray().put(new JSONObject()
            .put("sourceId", sourceId).put("resourceId", binding.optString("resourceId"))
            .put("sourceTitle", result.optString("autoBoundSourceTitle"))
            .put("resourceName", result.optString("autoBoundResourceName"))));
    }

    private static JSONArray findMatches(NativeAppDatabase database, JSONObject parsed, String fileName,
                                         String store, boolean historical) throws Exception {
        JSONArray matches = new JSONArray();
        if (!historical && "resourceSummaries".equals(store)) {
            JSONArray indexedCards = database.getIndexEntries(
                store, "type", JSONObject.quote("characterCard"));
            for (int offset = 0; offset < indexedCards.length(); offset += PAGE_SIZE) {
                JSONArray keys = new JSONArray();
                for (int index = offset; index < Math.min(indexedCards.length(), offset + PAGE_SIZE); index++) {
                    JSONObject entry = indexedCards.optJSONObject(index);
                    if (entry != null) keys.put(entry.optString("primaryKey"));
                }
                matches = matchRows(matches, database.getRecordsByKeys(store, keys), parsed, fileName, false);
            }
            return matches;
        }
        String afterKey = null;
        while (true) {
            JSONArray page = database.getRecords(store, afterKey, PAGE_SIZE);
            matches = matchRows(matches, page, parsed, fileName, historical);
            if (page.length() < PAGE_SIZE) break;
            afterKey = page.optJSONObject(page.length() - 1).optString("key");
        }
        return matches;
    }

    private static JSONArray matchRows(JSONArray matches, JSONArray page, JSONObject parsed,
                                       String fileName, boolean historical) throws Exception {
        JSONArray rows = new JSONArray();
        for (int index = 0; index < page.length(); index++) {
            JSONObject row = page.optJSONObject(index);
            JSONObject value = row == null ? null : row.optJSONObject("value");
            if (value == null) continue;
            if (value.optBoolean("encrypted")) throw new IllegalStateException("本地加密库需要在前台解锁后导入");
            if (historical) value.put("historical", true);
            rows.put(value);
        }
        return mergeMatches(matches,
            NativeCharacterCardProcessor.matchParsedResource(parsed, fileName, rows, false));
    }

    private static JSONArray mergeMatches(JSONArray left, JSONArray right) throws Exception {
        java.util.ArrayList<JSONObject> sorted = new java.util.ArrayList<>();
        for (int index = 0; index < left.length(); index++) sorted.add(left.getJSONObject(index));
        for (int index = 0; index < right.length(); index++) sorted.add(right.getJSONObject(index));
        sorted.sort((first, second) -> Integer.compare(second.optInt("score"), first.optInt("score")));
        JSONArray matches = new JSONArray();
        for (int index = 0; index < Math.min(MAX_MATCHES, sorted.size()); index++) matches.put(sorted.get(index));
        return matches;
    }

    private static boolean hasContentDuplicate(JSONArray matches) {
        for (int index = 0; index < matches.length(); index++) {
            JSONObject match = matches.optJSONObject(index);
            if (match != null && "contentDuplicate".equals(match.optString("matchKind"))) return true;
        }
        return false;
    }

    private static JSONObject storeAttachment(NativeAppDatabase database, File payload, String id,
                                              String encodedKey, String mimeType) throws Exception {
        return storeAttachment(database, "resources", payload, id, encodedKey, mimeType);
    }

    private static JSONObject storeAttachment(NativeAppDatabase database, String store, File payload,
                                              String id, String encodedKey, String mimeType) throws Exception {
        long size = payload.length();
        NativeAppDatabase.BlobTransfer transfer = database.beginBlob(store, encodedKey, BLOB_PATH, size, mimeType);
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[NativeAppDatabase.MAX_BLOB_CHUNK_BYTES];
        try (FileInputStream input = new FileInputStream(payload)) {
            long offset = transfer.offset;
            long skipped = 0;
            while (skipped < offset) {
                long count = input.skip(offset - skipped);
                if (count <= 0) throw new java.io.IOException("角色卡附件续传位置无效");
                skipped += count;
            }
            // A pending native blob can survive a Worker process restart. Include the already
            // staged prefix in the digest before validating the completed attachment.
            if (offset > 0) {
                try (FileInputStream prefix = new FileInputStream(payload)) {
                    long remaining = offset;
                    while (remaining > 0) {
                        int count = prefix.read(buffer, 0, (int) Math.min(buffer.length, remaining));
                        if (count < 0) throw new java.io.IOException("角色卡附件续传前缀不完整");
                        digest.update(buffer, 0, count);
                        remaining -= count;
                    }
                }
            }
            int count;
            while ((count = input.read(buffer)) != -1) {
                digest.update(buffer, 0, count);
                offset = database.appendBlob(transfer.token, offset, java.util.Arrays.copyOf(buffer, count));
            }
            if (offset != size) throw new java.io.IOException("角色卡附件暂存不完整");
            JSONObject metadata = database.completeBlob(transfer.token);
            String calculated = hex(digest.digest());
            if (!calculated.equalsIgnoreCase(metadata.optString("sha256")))
                throw new java.io.IOException("角色卡附件 SHA-256 核验失败");
            return metadata;
        } catch (Exception error) {
            database.deleteBlob(store, encodedKey, BLOB_PATH);
            throw error;
        }
    }

    private static JSONObject putOperation(String store, String key, JSONObject value) throws Exception {
        JSONObject row = new JSONObject().put("key", key).put("value", value)
            .put("indexes", indexEntries(store, value));
        return new JSONObject().put("type", "put").put("store", store)
            .put("rows", new JSONArray().put(row));
    }

    private static JSONArray indexEntries(String store, JSONObject value) throws Exception {
        JSONArray result = new JSONArray();
        if ("assets".equals(store)) {
            for (String field : new String[] {"contentHash", "mimeType", "source", "createdAt"})
                addIndex(result, field, value.opt(field));
            return result;
        }
        if ("assetFiles".equals(store)) {
            addIndex(result, "updatedAt", value.opt("updatedAt"));
            return result;
        }
        if ("communitySources".equals(store)) {
            addIndex(result, "id", value.opt("id"));
            addIndex(result, "platform", value.opt("platform"));
            addIndex(result, "sourceKeyHash", value.opt("sourceKeyHash"));
            addIndex(result, "updatedAt", value.opt("updatedAt"));
            return result;
        }
        if ("resourceSourceBindings".equals(store)) {
            addIndex(result, "resourceId", value.opt("resourceId"));
            addIndex(result, "sourceId", value.opt("sourceId"));
            addIndex(result, "createdAt", value.opt("createdAt"));
            return result;
        }
        if ("communitySourceMessages".equals(store)) {
            for (String field : new String[]{"id", "sourceId", "messageKeyHash", "kind", "capturedAt"}) addIndex(result, field, value.opt(field));
            for (String field : new String[]{"kind", "messageKeyHash"}) result.put(new JSONObject().put("name", "[sourceId+" + field + "]")
                .put("keys", new JSONArray().put(new JSONArray().put(value.getString("sourceId")).put(value.getString(field)).toString())));
            return result;
        }
        if (!"resources".equals(store) && !"resourceSummaries".equals(store)
            && !"resourceListSummaries".equals(store)) return result;
        addIndex(result, "type", value.opt("type"));
        addIndex(result, "name", value.opt("name"));
        addIndex(result, "favorite", value.opt("favorite"));
        addIndex(result, "categoryId", value.opt("categoryId"));
        addMultiIndex(result, "categoryIds", value.optJSONArray("categoryIds"));
        addIndex(result, "createdAt", value.opt("createdAt"));
        addIndex(result, "updatedAt", value.opt("updatedAt"));
        addIndex(result, "contentHash", value.opt("contentHash"));
        addMultiIndex(result, "tags", value.optJSONArray("tags"));
        return result;
    }

    private static void addIndex(JSONArray result, String name, Object value) throws Exception {
        if (!(value instanceof String || value instanceof Number)) return;
        result.put(new JSONObject().put("name", name)
            .put("keys", new JSONArray().put(indexKey(value))));
    }

    private static void addMultiIndex(JSONArray result, String name, JSONArray values) throws Exception {
        if (values == null || values.length() == 0) return;
        JSONArray keys = new JSONArray();
        java.util.HashSet<String> distinct = new java.util.HashSet<>();
        for (int index = 0; index < values.length(); index++) {
            Object value = values.opt(index);
            if (!(value instanceof String || value instanceof Number)) continue;
            String key = indexKey(value);
            if (distinct.add(key)) keys.put(key);
        }
        if (keys.length() > 0) result.put(new JSONObject().put("name", name).put("keys", keys));
    }

    private static String indexKey(Object value) throws Exception {
        if (value instanceof String) return JSONObject.quote((String) value);
        return String.valueOf(value);
    }

    private static JSONObject listMetadata(JSONObject metadata) throws Exception {
        JSONObject result = new JSONObject();
        if (metadata == null) return result;
        JSONArray keys = metadata.names();
        if (keys == null) return result;
        for (int index = 0; index < keys.length(); index++) {
            String key = keys.optString(index);
            Object value = metadata.opt(key);
            if (value == null || value == JSONObject.NULL || value instanceof Boolean || value instanceof Number) result.put(key, value);
            else if (value instanceof String) result.put(key, ((String) value).substring(0, Math.min(2000, ((String) value).length())));
            else if (value instanceof JSONArray) {
                JSONArray source = (JSONArray) value;
                JSONArray copy = new JSONArray();
                boolean primitive = true;
                for (int item = 0; item < source.length(); item++) {
                    Object entry = source.opt(item);
                    if (!(entry instanceof String || entry instanceof Number || entry instanceof Boolean)) { primitive = false; break; }
                    if (item < 64) copy.put(entry);
                }
                if (primitive) result.put(key, "stitchedFrom".equals(key) ? new JSONArray() : copy);
            }
        }
        return result;
    }

    private static String versionLabel(JSONObject metadata, String fileName) {
        String explicit = metadata == null ? "" : metadata.optString("characterVersion", "").trim();
        if (!explicit.isEmpty()) return explicit;
        int dot = fileName.lastIndexOf('.');
        return dot > 0 ? fileName.substring(0, dot) : fileName.isBlank() ? "未命名版本" : fileName;
    }

    private static String normalizedMimeType(String fileName, String supplied) {
        if (supplied != null && supplied.contains("/") && !"application/octet-stream".equals(supplied)) return supplied;
        int dot = fileName.lastIndexOf('.');
        String guessed = dot < 0 ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(fileName.substring(dot + 1).toLowerCase(Locale.ROOT));
        return guessed == null ? "application/octet-stream" : guessed;
    }

    private static String hashFile(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[128 * 1024];
        try (FileInputStream input = new FileInputStream(file)) {
            int count;
            while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
        }
        return hex(digest.digest());
    }

    private static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) result.append(String.format(Locale.ROOT, "%02x", value & 255));
        return result.toString();
    }

    private static JSONObject outcome(String state, String message) throws Exception {
        return new JSONObject().put("state", state).put("message", message);
    }
}
