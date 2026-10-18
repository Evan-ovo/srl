package buzz.jixiangruyi1207.srl;

import java.util.function.BooleanSupplier;

/** Guard the destructive OS call; no manual traversal of app or user-selected directories. */
final class NativeLocalDataReset {
    static final String CONFIRMATION = "我已了解到该操作会清除srl的数据，并确保我的确想这么做。";

    static void clear(String confirmation, BooleanSupplier clearApplicationUserData) {
        if (!CONFIRMATION.equals(confirmation)) {
            throw new IllegalArgumentException("必须完整输入本机数据清理确认句子");
        }
        if (!clearApplicationUserData.getAsBoolean()) {
            throw new IllegalStateException("Android 未接受清除应用数据请求；请在系统应用存储设置中清理");
        }
    }

    private NativeLocalDataReset() {}
}
