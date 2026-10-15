package buzz.jixiangruyi1207.srl;
import org.junit.Test;
import static org.junit.Assert.*;

public class GitHubAssistantPolicyTest {
    @Test public void onlyTheAuthenticatedUsersForkCanBeWritten() {
        assertTrue(GitHubAssistantPolicy.repository("tester/renamed-bridge", "tester"));
        assertTrue(GitHubAssistantPolicy.repository("TeStEr/renamed-bridge", "tester"));
        for (String name : new String[] { GitHubAssistantPolicy.UPSTREAM, "another/bridge", "tester/../other", "tester/a?token=value", "tester/a/b", "tester/" })
            assertFalse(name, GitHubAssistantPolicy.repository(name, "tester"));
        assertTrue(GitHubAssistantPolicy.repository(GitHubAssistantPolicy.UPSTREAM, "jixiangruyi117"));
    }
    @Test public void pollingHonorsServerIntervalAndStopsOnTerminalErrors() {
        assertEquals(5, GitHubAssistantPolicy.pollInterval("authorization_pending", 5, 0));
        assertEquals(12, GitHubAssistantPolicy.pollInterval("authorization_pending", 5, 12));
        assertEquals(10, GitHubAssistantPolicy.pollInterval("slow_down", 5, 0));
        assertEquals(25, GitHubAssistantPolicy.pollInterval("slow_down", 10, 25));
        for (String error : new String[] { "access_denied", "expired_token", "device_flow_disabled", "incorrect_client_credentials", "unknown" })
            assertEquals(error, -1, GitHubAssistantPolicy.pollInterval(error, 5, 0));
    }
    @Test public void writesNeedARealGitBlobIdentity() {
        assertTrue(GitHubAssistantPolicy.sha("a".repeat(40)));
        assertFalse(GitHubAssistantPolicy.sha("main"));
        assertFalse(GitHubAssistantPolicy.sha(""));
    }
    @Test public void actualDeploymentBranchesAreAcceptedWithoutChangingTheRepositoryScope() {
        for (String branch : new String[] { "main", "production", "release/stable", "2026-config" }) assertTrue(branch, GitHubAssistantPolicy.branch(branch));
        for (String branch : new String[] { "", "../main", "release//stable", "main?token=bad", "name.lock", ".private", "refs@{1}", "main\nother", "main\nother\nbad" }) assertFalse(branch, GitHubAssistantPolicy.branch(branch));
        assertFalse(GitHubAssistantPolicy.repository(GitHubAssistantPolicy.UPSTREAM, "another-user"));
    }
}
