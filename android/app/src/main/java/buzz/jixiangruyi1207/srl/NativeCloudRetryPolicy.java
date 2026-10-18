package buzz.jixiangruyi1207.srl;

/** Bounds WorkManager rescheduling after an upload run ends with a transient failure. */
final class NativeCloudRetryPolicy {
    static final int MAX_RUN_ATTEMPTS = 3;

    private NativeCloudRetryPolicy() {}

    static boolean shouldRetry(int completedRunAttempts) {
        return completedRunAttempts >= 0 && completedRunAttempts < MAX_RUN_ATTEMPTS - 1;
    }
}
