package buzz.jixiangruyi1207.srl;

import android.net.Uri;
import android.content.res.AssetManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FilterInputStream;
import java.io.InputStream;
import java.io.IOException;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.net.HttpURLConnection;
import java.net.URL;

/** Installed official modules share the packaged shell's origin and Vue runtime. */
final class OfficialAppWebViewClient extends BridgeWebViewClient {
    private final File root;
    private final Uri origin;
    private final AssetManager assets;

    OfficialAppWebViewClient(Bridge bridge) {
        super(bridge);
        root = new File(bridge.getContext().getFilesDir(), "official-apps/assets");
        origin = Uri.parse(bridge.getLocalUrl());
        assets = bridge.getContext().getAssets();
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri url = request.getUrl();
        if ("GET".equals(request.getMethod()) && origin.getScheme().equals(url.getScheme())
                && origin.getAuthority().equals(url.getAuthority())) {
            String path = url.getPath();
            // Test APKs can carry official APP catalogs and archives for offline install.
            // Release APKs omit optional archives, so fetch those from the hosted origin.
            if (path != null && path.startsWith("/official-apps/") && !path.contains("..")) {
                try {
                    InputStream stream = assets.open("public" + path);
                    String mime = path.endsWith(".json") ? "application/json"
                        : path.endsWith(".srlapp") ? "application/zip" : "application/octet-stream";
                    return new WebResourceResponse(mime, null, 200, "OK",
                        Collections.singletonMap("Cache-Control", "no-store"), stream);
                } catch (IOException ignored) {
                    if (isHostedDownloadPath(path)) {
                        return fetchHostedPackage(url);
                    }
                    // Catalogs and shell assets are expected to be bundled in the APK.
                }
            }
            if (path != null && path.matches("/assets/[A-Za-z0-9_.-]+") && !path.contains("..")) {
                File file = new File(root, path.substring("/assets/".length()));
                try {
                    if (file.isFile() && file.getCanonicalFile().getParentFile().equals(root.getCanonicalFile())) {
                        String mime = path.endsWith(".js") ? "text/javascript"
                            : path.endsWith(".css") ? "text/css"
                            : path.endsWith(".wasm") ? "application/wasm"
                            : path.endsWith(".woff2") ? "font/woff2" : "application/octet-stream";
                        return new WebResourceResponse(mime, null, 200, "OK",
                            Collections.singletonMap("Cache-Control", "no-store"), new FileInputStream(file));
                    }
                } catch (IOException ignored) {
                    return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", Collections.emptyMap(), null);
                }
                // Prefer packaged shared modules; fetch only missing optional program files.
                try (InputStream packaged = assets.open("public" + path)) {
                    return super.shouldInterceptRequest(view, request);
                } catch (IOException missing) {
                    if (isHostedDownloadPath(path)) return fetchHostedPackage(url);
                }
            }
        }
        if (!origin.getScheme().equals(url.getScheme()) || !origin.getAuthority().equals(url.getAuthority())) {
            WebResourceResponse preview = NativePreviewAssetPlugin.intercept(request);
            if (preview != null) return preview;
        }
        return super.shouldInterceptRequest(view, request);
    }

    static boolean isHostedDownloadPath(String path) {
        return path != null && !path.contains("..") && (
            path.matches("/official-apps/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\\.srlapp") ||
            path.matches("/official-apps/[A-Za-z0-9_.-]+/[A-Za-z0-9_-]+-[a-f0-9]{16}\\.json") ||
            path.matches("/assets/[A-Za-z0-9_.-]+\\.(?:js|css|wasm|woff2)")
        );
    }

    private WebResourceResponse fetchHostedPackage(Uri uri) {
        HttpURLConnection connection = null;
        try {
            // SRL-PUBLIC-SYNC: BEGIN REPLACE id=official-app-download-origin
            connection = (HttpURLConnection) buildHostedAssetUrl(new URL(uri.toString()), BuildConfig.SRL_PUBLIC_ASSET_ORIGIN).openConnection();
            // SRL-PUBLIC-SYNC: END REPLACE id=official-app-download-origin
            connection.setRequestMethod("GET");
            connection.setInstanceFollowRedirects(true);
            connection.setRequestProperty("Accept", "application/zip, application/octet-stream;q=0.9, */*;q=0.8");
            connection.connect();

            int status = connection.getResponseCode();
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            if (stream == null) stream = new ByteArrayInputStream(new byte[0]);

            final HttpURLConnection ownedConnection = connection;
            InputStream managedStream = new FilterInputStream(stream) {
                @Override
                public void close() throws IOException {
                    try {
                        super.close();
                    } finally {
                        ownedConnection.disconnect();
                    }
                }
            };

            String contentType = connection.getContentType();
            String mimeType = contentType == null ? "application/zip" : contentType.split(";", 2)[0].trim();
            Map<String, String> headers = new HashMap<>();
            for (String name : new String[] { "Content-Length", "Content-Disposition", "Cache-Control", "ETag" }) {
                String value = connection.getHeaderField(name);
                if (value != null) headers.put(name, value);
            }
            headers.put("Cache-Control", "no-store");
            String reason = connection.getResponseMessage();
            if (reason == null || reason.isEmpty()) reason = status == 200 ? "OK" : "HTTP Response";
            return new WebResourceResponse(mimeType, null, status, reason, headers, managedStream);
        } catch (IOException error) {
            if (connection != null) connection.disconnect();
            byte[] message = "Unable to download official APP package".getBytes(java.nio.charset.StandardCharsets.UTF_8);
            return new WebResourceResponse("text/plain", "UTF-8", 502, "Bad Gateway",
                Collections.emptyMap(), new ByteArrayInputStream(message));
        }
    }
    // SRL-PUBLIC-SYNC: BEGIN PUBLIC-ONLY id=public-hosted-asset-origin
    static URL buildHostedAssetUrl(URL localUrl, String assetOrigin) throws IOException {
        if (assetOrigin == null || assetOrigin.isEmpty()) throw new IOException("APP asset origin is not configured");
        String assetPath = localUrl.getPath();
        if (!isHostedDownloadPath(assetPath)) throw new IOException("Invalid APP asset path");
        java.net.URI origin;
        try { origin = java.net.URI.create(assetOrigin); }
        catch (IllegalArgumentException invalid) { throw new IOException("Invalid APP asset origin", invalid); }
        if (!"https".equals(origin.getScheme()) || origin.getHost() == null || origin.getUserInfo() != null
                || origin.getPort() != -1 || (origin.getPath() != null && !origin.getPath().isEmpty()
                && !"/".equals(origin.getPath())) || origin.getQuery() != null || origin.getFragment() != null)
            throw new IOException("Invalid APP asset origin");
        return new URL(origin.toString().replaceAll("/+$", "") + assetPath);
    }
    // SRL-PUBLIC-SYNC: END PUBLIC-ONLY id=public-hosted-asset-origin
}
