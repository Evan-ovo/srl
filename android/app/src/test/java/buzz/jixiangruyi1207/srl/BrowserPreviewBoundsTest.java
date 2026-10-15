package buzz.jixiangruyi1207.srl;

import static org.junit.Assert.*;
import org.junit.Test;

public class BrowserPreviewBoundsTest {
    private BrowserPreviewBounds.Frame fit(float x, float y, float w, float h) {
        return BrowserPreviewBounds.fit(x, y, w, h, 12, 24, 388, 760, 160, 110);
    }

    @Test public void keepsDraggedPreviewInsideAllFourEdges() {
        assertEquals(new BrowserPreviewBounds.Frame(12, 24, 180, 150), fit(-100, -100, 180, 150));
        assertEquals(new BrowserPreviewBounds.Frame(208, 610, 180, 150), fit(900, 900, 180, 150));
    }
    @Test public void limitsResizeWithoutChangingPositionWhenItFits() {
        assertEquals(new BrowserPreviewBounds.Frame(24, 80, 220, 180), fit(24, 80, 220, 180));
        assertEquals(new BrowserPreviewBounds.Frame(12, 24, 376, 736), fit(24, 80, 1200, 1500));
        assertEquals(new BrowserPreviewBounds.Frame(24, 80, 160, 110), fit(24, 80, 1, 1));
    }
    @Test public void reclampsWhenKeyboardOrRotationReducesTheAvailableViewport() {
        var frame = BrowserPreviewBounds.fit(208, 610, 180, 150, 12, 24, 308, 360, 160, 110);
        assertEquals(new BrowserPreviewBounds.Frame(128, 210, 180, 150), frame);
    }
    @Test public void minimumSizeNeverPushesThePreviewOutsideATinyViewport() {
        assertEquals(new BrowserPreviewBounds.Frame(12, 24, 88, 76),
            BrowserPreviewBounds.fit(50, 50, 180, 150, 12, 24, 100, 100, 160, 110));
    }
}
