package buzz.jixiangruyi1207.srl;

/** Geometry of the local page preview; does not resize or navigate the underlying WebView. */
final class BrowserPreviewBounds {
    record Frame(float left, float top, float width, float height) {}

    static Frame fit(float x, float y, float width, float height,
                     float left, float top, float right, float bottom,
                     float minWidth, float minHeight) {
        float availableWidth = Math.max(1, right - left);
        float availableHeight = Math.max(1, bottom - top);
        float w = clamp(width, Math.min(minWidth, availableWidth), availableWidth);
        float h = clamp(height, Math.min(minHeight, availableHeight), availableHeight);
        return new Frame(clamp(x, left, right - w), clamp(y, top, bottom - h), w, h);
    }

    private static float clamp(float value, float min, float max) {
        return Math.max(min, Math.min(max, value));
    }
}
