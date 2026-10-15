package buzz.jixiangruyi1207.srl;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.util.Base64;
import android.view.MotionEvent;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONObject;

/** Same local pet artwork, hosted above the external WebView without overlay permission. */
final class DiscordSetupPetOverlay {
    private final FrameLayout host;
    private final LinearLayout pet;
    private final TextView bubble;
    private final ImageView image;
    private Bitmap bitmap;
    private final int size;
    private float startX, startY, originX, originY;
    private boolean moved;
    DiscordSetupPetOverlay(FrameLayout host, Runnable talk) {
        this.host = host;
        Context context = host.getContext();
        size = Math.round(88 * context.getResources().getDisplayMetrics().density);
        pet = new LinearLayout(context); pet.setOrientation(LinearLayout.VERTICAL);
        bubble = new TextView(context); bubble.setTextColor(Color.BLACK); bubble.setTextSize(14);
        int padding = Math.round(8 * context.getResources().getDisplayMetrics().density);
        bubble.setPadding(padding, padding, padding, padding);
        bubble.setMaxLines(3); bubble.setEllipsize(android.text.TextUtils.TruncateAt.END);
        bubble.setVisibility(android.view.View.GONE);
        bubble.setOnClickListener(view -> talk.run());
        theme(false);
        pet.addView(bubble, new LinearLayout.LayoutParams(size * 2, -2));
        image = new ImageView(context); image.setContentDescription("蒜惹菈，点击对话，拖动移动");
        image.setImageResource(android.R.drawable.ic_dialog_info); image.setScaleType(ImageView.ScaleType.FIT_CENTER);
        pet.addView(image, new LinearLayout.LayoutParams(size, size));
        host.addView(pet, new FrameLayout.LayoutParams(size * 2, -2));
        host.addOnLayoutChangeListener((view, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom) -> {
            if (right - left != oldRight - oldLeft || bottom - top != oldBottom - oldTop) place(pet.getX(), pet.getY());
        });
        rest();
        image.setOnClickListener(view -> talk.run());
        image.setOnTouchListener((view, event) -> {
            if (event.getActionMasked() == MotionEvent.ACTION_DOWN) {
                startX = event.getRawX(); startY = event.getRawY(); originX = pet.getX(); originY = pet.getY(); moved = false; return true;
            }
            if (event.getActionMasked() == MotionEvent.ACTION_MOVE) {
                float dx = event.getRawX() - startX, dy = event.getRawY() - startY;
                if (Math.abs(dx) + Math.abs(dy) > android.view.ViewConfiguration.get(context).getScaledTouchSlop()) moved = true;
                if (moved) place(originX + dx, originY + dy); return true;
            }
            if (event.getActionMasked() == MotionEvent.ACTION_UP) { if (!moved) view.performClick(); return true; }
            return event.getActionMasked() == MotionEvent.ACTION_CANCEL;
        });
    }
    void say(String text) { bubble.setText(text.substring(0, Math.min(160, text.length()))); bubble.setVisibility(text.isEmpty() ? android.view.View.GONE : android.view.View.VISIBLE); pet.post(() -> place(pet.getX(), pet.getY())); }
    void visible(boolean value) { pet.setVisibility(value ? android.view.View.VISIBLE : android.view.View.GONE); }
    void constrain() { pet.post(() -> place(pet.getX(), pet.getY())); }
    JSONObject bounds(android.webkit.WebView app) {
        int[] at = new int[2], origin = new int[2]; image.getLocationOnScreen(at); app.getLocationOnScreen(origin);
        float density = host.getResources().getDisplayMetrics().density;
        try { return new JSONObject().put("left", (at[0] - origin[0]) / density).put("top", (at[1] - origin[1]) / density).put("viewportWidth", app.getWidth() / density); }
        catch (org.json.JSONException impossible) { throw new IllegalStateException(impossible); }
    }
    void rest() {
        pet.post(() -> place(8, host.getHeight() - host.getPaddingBottom() - pet.getHeight() - Math.round(56 * host.getResources().getDisplayMetrics().density)));
    }
    void theme(boolean dark) {
        bubble.setTextColor(Color.parseColor(dark ? "#eef8f8" : "#183842"));
        android.graphics.drawable.GradientDrawable background = new android.graphics.drawable.GradientDrawable();
        background.setColor(Color.parseColor(dark ? "#293f48" : "#fbfefe"));
        background.setCornerRadius(8 * host.getResources().getDisplayMetrics().density);
        background.setStroke(1, Color.parseColor(dark ? "#48636c" : "#bad0d5"));
        bubble.setBackground(background);
    }
    private void place(float x, float y) {
        pet.setX(Math.max(host.getPaddingLeft(), Math.min(x, host.getWidth() - host.getPaddingRight() - pet.getWidth())));
        pet.setY(Math.max(host.getPaddingTop(), Math.min(y, host.getHeight() - host.getPaddingBottom() - pet.getHeight() - Math.round(56 * host.getResources().getDisplayMetrics().density))));
    }
    void frame(String data) {
        if (data == null || !data.startsWith("data:image/png;base64,") || data.length() > 262144) return;
        try {
            byte[] bytes = Base64.decode(data.substring(22), Base64.DEFAULT);
            BitmapFactory.Options bounds = new BitmapFactory.Options(); bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0 || bounds.outWidth > 192 || bounds.outHeight > 192) return;
            Bitmap next = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
            if (next == null) return;
            image.setImageBitmap(next); if (bitmap != null) bitmap.recycle(); bitmap = next;
        } catch (IllegalArgumentException ignored) { /* Only a bounded local PNG is accepted. */ }
    }
    void point(android.webkit.WebView web, JSONObject anchor, String text) {
        int[] browser = new int[2], container = new int[2]; web.getLocationInWindow(browser); host.getLocationInWindow(container);
        float left = browser[0] - container[0] + (float) anchor.optDouble("left") * web.getWidth();
        float right = browser[0] - container[0] + (float) anchor.optDouble("right") * web.getWidth();
        float top = browser[1] - container[1] + (float) anchor.optDouble("top") * web.getHeight();
        float bottom = browser[1] - container[1] + (float) anchor.optDouble("bottom") * web.getHeight();
        say(text);
        pet.post(() -> {
            float x = right + 8;
            float y = top;
            if (x + pet.getWidth() > host.getWidth()) x = left - pet.getWidth() - 8;
            if (x < 0) { x = 8; y = bottom + 8; if (y + pet.getHeight() > host.getHeight()) y = top - pet.getHeight() - 8; }
            place(x, y);
        });
    }
    void destroy() { image.setImageDrawable(null); if (bitmap != null) { bitmap.recycle(); bitmap = null; } }
}
