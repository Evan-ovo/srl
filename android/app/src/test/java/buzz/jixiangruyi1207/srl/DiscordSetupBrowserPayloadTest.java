package buzz.jixiangruyi1207.srl;

import static org.junit.Assert.*;
import com.getcapacitor.JSObject;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class DiscordSetupBrowserPayloadTest {
    @Test public void exitBackStopsTheNativeRunAndReturnsWithoutDiscardingTaskState() throws Exception {
        java.util.ArrayList<JSObject> events = new java.util.ArrayList<>();
        AssistantBrowserWindow window = new AssistantBrowserWindow(null, events::add);
        window.step = "github-sync"; window.agentRunId = "active-run"; window.paused = false;
        window.template = "retained-template";
        java.lang.reflect.Method back = AssistantBrowserWindow.class.getDeclaredMethod("back");
        back.setAccessible(true); back.invoke(window);
        assertTrue(window.paused); assertEquals("", window.agentRunId);
        assertEquals("github-sync", window.step); assertEquals("retained-template", window.template);
        assertEquals(2, events.size());
        assertEquals("visibility", events.get(0).optString("action"));
        assertFalse(events.get(0).optBoolean("visible"));
        assertEquals("return", events.get(1).optString("action"));
    }
    @Test public void previousPageWithoutHistoryDoesNotExitOrInterruptTheRun() throws Exception {
        java.util.ArrayList<JSObject> events = new java.util.ArrayList<>();
        AssistantBrowserWindow window = new AssistantBrowserWindow(null, events::add);
        window.agentRunId = "active-run"; window.paused = false;
        java.lang.reflect.Method previous = AssistantBrowserWindow.class.getDeclaredMethod("goBack");
        previous.setAccessible(true); previous.invoke(window);
        assertTrue(events.isEmpty()); assertFalse(window.paused);
        assertEquals("active-run", window.agentRunId);
    }
    @Test public void agentPetOpensExistingQuickChatWithoutResumingOrPausing() throws Exception {
        java.util.ArrayList<JSObject> events = new java.util.ArrayList<>();
        AssistantBrowserWindow window = new AssistantBrowserWindow(null, events::add);
        window.mode = "agent"; window.paused = false; window.agentRunId = "active-run";
        java.lang.reflect.Method talk = AssistantBrowserWindow.class.getDeclaredMethod("talk");
        talk.setAccessible(true); talk.invoke(window);
        assertEquals(1, events.size()); assertEquals("quick-chat", events.get(0).optString("action"));
        assertFalse(window.paused); assertEquals("active-run", window.agentRunId);
    }
    @Test public void keepsAcceptedInstallationForTheSameTaskAndAppButNeverRevivesTheAgent() {
        AssistantBrowserWindow window = new AssistantBrowserWindow(null, event -> {});
        String app = "1234567890123456789";
        window.conversation("task-one"); window.installation(app, "discord-install");
        window.installationStartedApp = app; window.installationCompleted = true;
        window.documentId++; window.installation(app, "discord-install");
        assertTrue(window.installationCompleted);
        assertTrue(window.paused); assertEquals("", window.agentRunId);
        window.conversation("task-two");
        assertFalse(window.installationCompleted); assertEquals("", window.installationStartedApp);
        window.installationStartedApp = app; window.installationCompleted = true;
        window.installation("2234567890123456789", "discord-install");
        assertFalse(window.installationCompleted);
    }
    @Test public void preservesEverySecretPhaseWithoutReturningTheTransferredValue() throws Exception {
        for (String phase : new String[] { "prepare", "input", "submit", "saved", "submitted" }) {
            JSObject result = NativeAssistantBrowserPlugin.sanitize(new JSONObject().put("ok", true).put("secretStage", phase).put("secret", "PRIVATE_TOKEN").put("value", "PRIVATE_TOKEN"), false);
            assertEquals(phase, result.getString("secretStage"));
            assertFalse(result.toString().contains("PRIVATE_TOKEN"));
        }
        assertFalse(NativeAssistantBrowserPlugin.sanitize(new JSONObject().put("secretStage", "PRIVATE_TOKEN"), false).has("secretStage"));
    }
    @Test public void preservesPublicWorkerSiteEvidenceWithoutTreatingItAsAuthentication() throws Exception {
        JSObject result = NativeAssistantBrowserPlugin.sanitize(new JSONObject().put("pageKind", "worker-site").put("pageAccess", "public"), false);
        assertEquals("worker-site", result.getString("pageKind"));
        assertEquals("public", result.getString("pageAccess"));
    }
    @Test public void carriesActualPasswordVerificationAccessWithoutPrivateFields() throws Exception {
        JSObject result = NativeAssistantBrowserPlugin.sanitize(new JSONObject().put("pageAccess", "authentication").put("value", "PRIVATE_PASSWORD"), false);
        assertEquals("authentication", result.getString("pageAccess"));
        assertFalse(result.toString().contains("PRIVATE_PASSWORD"));
        assertFalse(NativeAssistantBrowserPlugin.sanitize(new JSONObject().put("pageAccess", "PRIVATE_PASSWORD"), false).has("pageAccess"));
    }
    @Test public void preservesDispatchedNavigationWithoutClaimingSuccessOrReplayingCancelledActions() throws Exception {
        JSONObject receipt = new JSONObject().put("ok", true).put("dispatched", true).put("value", "PRIVATE_SECRET");
        for (String operation : new String[] { "click", "select" }) {
            JSObject result = NativeAssistantBrowserPlugin.navigationReceipt(operation, receipt, true, true);
            assertTrue(result.getBoolean("dispatched"));
            assertTrue(result.getBoolean("pageChanged"));
            assertFalse(result.getBoolean("verified"));
            assertFalse(result.toString().contains("PRIVATE_SECRET"));
            assertNull(NativeAssistantBrowserPlugin.navigationReceipt(operation, receipt, false, true));
            assertNull(NativeAssistantBrowserPlugin.navigationReceipt(operation, receipt, true, false));
        }
        assertNull(NativeAssistantBrowserPlugin.navigationReceipt("inspect", receipt, true, true));
        assertNull(NativeAssistantBrowserPlugin.navigationReceipt("click", new JSONObject().put("ok", false), true, true));
    }
    @Test public void keepsAppliedFillTemplateAndEndpointReceiptsAcrossNavigationWithoutInventingSuccess() throws Exception {
        for (String operation : new String[] { "fill", "template", "fill-endpoint" }) {
            JSONObject input = new JSONObject().put("ok", true).put("value", "PRIVATE_SECRET").put("verified", true)
                .put("template".equals(operation) ? "written" : "filled", true).put("waitingForUser", true);
            JSObject result = NativeAssistantBrowserPlugin.navigationReceipt(operation, input, true, true);
            assertTrue(result.getBoolean("dispatched"));
            assertFalse(result.getBoolean("verified"));
            assertTrue(result.getBoolean("waitingForUser"));
            assertFalse(result.toString().contains("PRIVATE_SECRET"));
            assertNull(NativeAssistantBrowserPlugin.navigationReceipt(operation, input, true, false));
        }
        JSONObject read = new JSONObject().put("ok", true).put("dispatched", true);
        for (String operation : new String[] { "inspect", "collect-config", "collect-worker", "validate", "verify-step", "guide" })
            assertNull(NativeAssistantBrowserPlugin.navigationReceipt(operation, read, true, true));
        assertNull(NativeAssistantBrowserPlugin.navigationReceipt("click", read.put("clickPoint", new JSONObject()), true, true));
    }
    @Test public void retainsOnlyBooleanSavedSecretAndRecoveryMetadata() throws Exception {
        JSONObject input = new JSONObject().put("secretSavedOnPage", true).put("waitingForPage", true).put("pageChanged", true).put("recovery", true).put("secret", "PRIVATE_SECRET");
        JSObject result = NativeAssistantBrowserPlugin.sanitize(input, false);
        assertTrue(result.getBoolean("secretSavedOnPage"));
        assertTrue(result.getBoolean("waitingForPage"));
        assertTrue(result.getBoolean("pageChanged"));
        assertTrue(result.getBoolean("recovery"));
        assertFalse(result.toString().contains("PRIVATE_SECRET"));
        input.put("secretSavedOnPage", "PRIVATE_SECRET");
        assertFalse(NativeAssistantBrowserPlugin.sanitize(input, false).has("secretSavedOnPage"));
    }
    @Test public void preservesOnlyBooleanSearchEvidenceWithoutPrivateValues() throws Exception {
        JSONObject input = new JSONObject().put("searchMatched", false).put("value", "PRIVATE_SECRET");
        JSObject receipt = NativeAssistantBrowserPlugin.sanitize(input, false);
        assertFalse(receipt.getBoolean("searchMatched"));
        assertFalse(receipt.toString().contains("PRIVATE_SECRET"));
        input.put("searchMatched", true);
        assertTrue(NativeAssistantBrowserPlugin.sanitize(input, false).getBoolean("searchMatched"));
        input.put("searchMatched", "PRIVATE_SECRET");
        assertFalse(NativeAssistantBrowserPlugin.sanitize(input, false).has("searchMatched"));
    }
    @Test public void deliversDisabledControlStateWithoutLeakingInputValues() throws Exception {
        JSONObject control = new JSONObject().put("target", "1").put("label", "Commit changes...")
            .put("kind", "button").put("sensitive", false).put("disabled", true).put("value", "PRIVATE_SECRET");
        JSObject receipt = NativeAssistantBrowserPlugin.sanitize(new JSONObject().put("controls", new JSONArray().put(control)), false);
        JSONObject field = receipt.getJSONArray("controls").getJSONObject(0);
        assertTrue(field.getBoolean("disabled"));
        assertEquals("Commit changes...", field.getString("label"));
        assertFalse(receipt.toString().contains("PRIVATE_SECRET"));
        control.put("disabled", false);
        assertFalse(NativeAssistantBrowserPlugin.sanitize(new JSONObject().put("controls", new JSONArray().put(control)), false)
            .getJSONArray("controls").getJSONObject(0).getBoolean("disabled"));
    }
    @Test public void deliversPublicValidationFeedbackSoTheAgentCanCorrectRejectedNames() throws Exception {
        JSONObject control = new JSONObject().put("target", "1").put("label", "Application name")
            .put("kind", "input").put("sensitive", false).put("invalid", true)
            .put("feedback", new JSONArray().put("Application name cannot contain discord"));
        JSObject receipt = NativeAssistantBrowserPlugin.sanitize(new JSONObject().put("controls", new JSONArray().put(control)), false);
        JSONObject field = receipt.getJSONArray("controls").getJSONObject(0);
        assertTrue(field.getBoolean("invalid"));
        assertEquals("Application name cannot contain discord", field.getJSONArray("feedback").getString(0));
    }
    @Test public void neverDeliversPrivateOrUnclassifiedFieldFeedback() throws Exception {
        for (Boolean sensitive : new Boolean[] { true, null }) {
            JSONObject control = new JSONObject().put("target", "1").put("label", "Bot Token").put("kind", "input")
                .put("invalid", true).put("feedback", new JSONArray().put("PRIVATE_SECRET"));
            if (sensitive != null) control.put("sensitive", sensitive);
            JSObject receipt = NativeAssistantBrowserPlugin.sanitize(new JSONObject().put("controls", new JSONArray().put(control)), false);
            assertFalse(receipt.toString().contains("PRIVATE_SECRET"));
            assertFalse(receipt.getJSONArray("controls").getJSONObject(0).has("feedback"));
        }
    }
    @Test public void retainsPublicIdentifiersButMasksCredentialShapesAndBoundsFeedback() throws Exception {
        String token = "a".repeat(24) + "." + "b".repeat(8) + "." + "c".repeat(28);
        JSONArray messages = new JSONArray().put("Invalid value: 1234567890123456789").put(token).put("ordinary").put("omitted");
        JSONObject control = new JSONObject().put("target", "1").put("sensitive", false).put("invalid", true).put("feedback", messages);
        JSObject receipt = NativeAssistantBrowserPlugin.sanitize(new JSONObject().put("controls", new JSONArray().put(control)), false);
        JSONArray feedback = receipt.getJSONArray("controls").getJSONObject(0).getJSONArray("feedback");
        assertEquals(3, feedback.length());
        assertTrue(receipt.toString().contains("1234567890123456789"));
        assertFalse(receipt.toString().contains(token));
        assertEquals("ordinary", feedback.getString(2));
    }
    @Test public void keepsTheWorkerNewRouteAndPublicNamesReadable() throws Exception {
        String route = "https://dash.cloudflare.com/" + "a".repeat(32) + "/workers/new";
        String name = "my-team-production-discord-source-worker";
        JSONObject input = new JSONObject().put("headings", new JSONArray().put(route))
            .put("controls", new JSONArray().put(new JSONObject().put("target", "1").put("label", name).put("sensitive", false).put("value", "PRIVATE_SECRET")));
        JSObject result = NativeAssistantBrowserPlugin.sanitize(input, false);
        assertEquals(route, result.getJSONArray("headings").getString(0));
        assertEquals(name, result.getJSONArray("controls").getJSONObject(0).getString("label"));
        assertFalse(result.toString().contains("PRIVATE_SECRET"));
        assertEquals(route + "?code=[已遮蔽]&tab=overview",
            AssistantBrowserPolicy.maskSecrets(route + "?code=PRIVATE_AUTH_CODE&tab=overview"));
    }

    @Test public void preservesConflictEvidenceWithoutReturningSecrets() throws Exception {
        String endpoint = "https://old.workers.dev/interactions";
        JSObject result = NativeAssistantBrowserPlugin.sanitize(new JSONObject().put("configurationConflict", true).put("previousEndpoint", endpoint).put("secret", "PRIVATE_TOKEN"), false);
        assertTrue(result.getBoolean("configurationConflict"));
        assertEquals(endpoint, result.getString("previousEndpoint"));
        assertFalse(result.toString().contains("PRIVATE_TOKEN"));
        String token = "a".repeat(24) + "." + "b".repeat(8) + "." + "c".repeat(28);
        assertFalse(NativeAssistantBrowserPlugin.sanitize(new JSONObject().put("configurationConflict", true).put("previousEndpoint", "https://old.workers.dev/" + token), false).has("previousEndpoint"));
        assertFalse(NativeAssistantBrowserPlugin.sanitize(new JSONObject().put("configurationConflict", true).put("previousEndpoint", "http://old.workers.dev/interactions"), false).has("previousEndpoint"));
    }
}
