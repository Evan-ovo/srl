package buzz.jixiangruyi1207.srl;
import static org.junit.Assert.*;
import org.junit.Test;
public class AssistantBrowserPolicyTest {
    @Test public void sharedBrowserAcceptsPublicHttpsPagesWithoutDiscordHostAllowlist() {
        assertTrue(AssistantBrowserPolicy.browseAllowed("https://example.org/articles?q=public"));
        assertTrue(AssistantBrowserPolicy.generalNavigationAllowed("https://example.org/", "https://docs.example.net/guide"));
        assertFalse(AssistantBrowserPolicy.browseAllowed("http://example.org/"));
        assertFalse(AssistantBrowserPolicy.browseAllowed("https://127.0.0.1/"));
        assertFalse(AssistantBrowserPolicy.browseAllowed("https://localhost/"));
        assertFalse(AssistantBrowserPolicy.browseAllowed("https://example.org:444/"));
        assertFalse(AssistantBrowserPolicy.browseAllowed("https://user@example.org/"));
    }
    @Test public void sharedBrowserNavigationRequiresCurrentActiveTaskAndPublicPage() {
        assertTrue(AssistantBrowserPolicy.generalAgentNavigationAllowed("run", false, false, false, "https://example.org/", "https://docs.example.net/"));
        assertFalse(AssistantBrowserPolicy.generalAgentNavigationAllowed("", false, false, false, "https://example.org/", "https://docs.example.net/"));
        assertFalse(AssistantBrowserPolicy.generalAgentNavigationAllowed("run", true, false, false, "https://example.org/", "https://docs.example.net/"));
        assertFalse(AssistantBrowserPolicy.generalAgentNavigationAllowed("run", false, true, false, "https://example.org/", "https://docs.example.net/"));
    }
    @Test public void githubConnectionEntryDoesNotReplaceRepositoryAuthorization() {
        assertTrue(AssistantBrowserPolicy.githubLogin("https://github.com/login"));
        assertTrue(AssistantBrowserPolicy.githubLogin("https://github.com/login/?return_to=%2Fown%2Frepo"));
        for (String url : new String[] { "https://github.com/login/oauth/authorize", "https://github.com/settings/installations", "https://example.com/login", "http://github.com/login", "https://example.com@github.com/login" })
            assertFalse(url, AssistantBrowserPolicy.githubLogin(url));
    }
    @Test public void publicInstallationReceiptRequiresTheSameAppOrAnAlreadyBoundRedirect() {
        String app = "1234567890123456789";
        assertTrue(AssistantBrowserPolicy.installationResultPage("https://discord.com/oauth2/authorize?client_id=" + app, app, false));
        assertFalse(AssistantBrowserPolicy.installationResultPage("https://discord.com/oauth2/authorize?client_id=2234567890123456789", app, true));
        assertFalse(AssistantBrowserPolicy.installationResultPage("https://discord.com/oauth2/authorized", app, false));
        assertTrue(AssistantBrowserPolicy.installationResultPage("https://discord.com/oauth2/authorized", app, true));
        assertFalse(AssistantBrowserPolicy.installationResultPage("https://discord.com/oauth2/authorize?client_id=" + app + "&client_id=" + app, app, true));
        assertFalse(AssistantBrowserPolicy.installationResultPage("https://example.com/oauth2/authorized", app, true));
        assertFalse(AssistantBrowserPolicy.installationResultPage("https://discord.com/login", app, true));
    }
    @Test public void failedPublicPageCanBeLeftOnlyByAnActiveAuthorizedAgent() {
        String preview = "https://preview.bridge.account.workers.dev/";
        String dashboard = "https://dash.cloudflare.com/account/workers/services/view/bridge/production";
        assertTrue(AssistantBrowserPolicy.agentNavigationAllowed("agent", "run", true, false, true, "cf-deploy", preview, dashboard));
        assertFalse(AssistantBrowserPolicy.agentNavigationAllowed("agent", "run", true, false, true, "cf-deploy", preview, preview));
        assertFalse(AssistantBrowserPolicy.agentNavigationAllowed("agent", "", true, false, true, "cf-deploy", preview, dashboard));
        assertFalse(AssistantBrowserPolicy.agentNavigationAllowed("economy", "run", true, false, true, "cf-deploy", preview, dashboard));
        assertFalse(AssistantBrowserPolicy.agentNavigationAllowed("agent", "run", true, true, true, "cf-deploy", preview, dashboard));
        assertFalse(AssistantBrowserPolicy.agentNavigationAllowed("agent", "run", true, false, false, "cf-deploy", preview, dashboard));
        assertFalse(AssistantBrowserPolicy.agentNavigationAllowed("agent", "run", true, false, true, "cf-deploy", "https://github.com/login", dashboard));
        assertTrue(AssistantBrowserPolicy.agentNavigationAllowed("agent", "run", true, false, true, "cf-secret", dashboard + "/settings/variables", dashboard));
        assertFalse(AssistantBrowserPolicy.agentNavigationAllowed("agent", "run", true, false, true, "cf-deploy", preview, "https://example.com/"));
        assertTrue(AssistantBrowserPolicy.agentNavigationAllowed("agent", "run", false, false, false, "cf-deploy", preview, dashboard));
    }
    @Test public void workerPreviewIsPublicAndCanReturnToTheDeploymentDashboard() {
        String dashboard = "https://dash.cloudflare.com/account/workers/services/view/bridge/production";
        for (String path : new String[] { "/", "/interactions", "/health" }) {
            String preview = "https://preview-abc.bridge.account.workers.dev" + path;
            assertTrue(AssistantBrowserPolicy.allowed(preview));
            assertFalse(AssistantBrowserPolicy.userOnly("cf-deploy", preview));
            assertEquals("public", AssistantBrowserPolicy.pageAccess("cf-deploy", preview));
            assertTrue(AssistantBrowserPolicy.navigationAllowed(preview, dashboard));
            assertTrue(AssistantBrowserPolicy.navigationAllowed(dashboard, preview));
            assertFalse(AssistantBrowserPolicy.successLocation("cf-deploy", preview));
        }
        for (String url : new String[] { "https://workers.dev/", "https://bridge.account.workers.dev.example/", "https://credential@bridge.account.workers.dev/", "http://bridge.account.workers.dev/", "https://bridge.account.workers.dev:444/" }) assertFalse(url, AssistantBrowserPolicy.allowed(url));
        assertEquals("authentication", AssistantBrowserPolicy.pageAccess("cf-deploy", "https://bridge.account.workers.dev/login"));
    }
    @Test public void handoffMessageMatchesActualAccessInsteadOfInventingLogin() {
        assertTrue(AssistantBrowserPolicy.handoffReason("cf-deploy", "https://github.com/login").contains("登录"));
        String google = "https://accounts.google.com/v3/signin/identifier";
        assertEquals("authentication", AssistantBrowserPolicy.pageAccess("cf-deploy", google));
        assertTrue(AssistantBrowserPolicy.handoffReason("cf-deploy", google).contains("登录"));
        assertFalse(AssistantBrowserPolicy.allowed(google));
        assertTrue(AssistantBrowserPolicy.handoffReason("cf-deploy", "https://discord.com/developers/applications/1234567890123456789/bot").contains("秘密"));
        String external = AssistantBrowserPolicy.handoffReason("cf-deploy", "https://example.com/");
        assertTrue(external.contains("外部网页"));
        assertFalse(external.contains("登录"));
        assertFalse(external.contains("授权"));
    }
    @Test public void cloudflareConnectionConsentCanBeInspectedButActualLoginRemainsHuman() {
        String url = "https://github.com/login/oauth/authorize?client_id=example";
        assertFalse(AssistantBrowserPolicy.authentication(url));
        assertFalse(AssistantBrowserPolicy.userOnly("cf-deploy", url));
        assertTrue(AssistantBrowserPolicy.authentication("https://github.com/login"));
        assertTrue(AssistantBrowserPolicy.authentication("https://accounts.google.com/o/oauth/authorize"));
        assertFalse(AssistantBrowserPolicy.connectionConsent("https://github.com.evil.example/login/oauth/authorize"));
    }

    @Test public void reopeningTheSameTaskPreservesActualPageInsteadOfRestartingTheTutorial() {
        String root = "https://dash.cloudflare.com/";
        for (String current : new String[] {
            "https://dash.cloudflare.com/account/workers-and-pages/create",
            "https://dash.cloudflare.com/account/workers/services/view/srl-discord-source-bridge/production",
            "https://github.com/apps/cloudflare-workers-and-pages/installations/new",
            "https://github.com/test-user/SRL-Discord-Bridge/edit/main/wrangler.jsonc",
            "https://discord.com/developers/applications/1234567890123456789/information",
            "https://accounts.google.com/signin"
        }) assertNull(current, AssistantBrowserPolicy.openingUrl(root, current, true, true, root));
        assertEquals(root, AssistantBrowserPolicy.openingUrl(root, "https://github.com/test/repo", true, false, root));
        assertEquals(root, AssistantBrowserPolicy.openingUrl(root, "https://github.com/test/repo", false, true, root));
        assertEquals(root, AssistantBrowserPolicy.openingUrl(null, "https://github.com/test/repo", false, true, root));
        assertNull(AssistantBrowserPolicy.openingUrl(null, root + "account/home", false, true, root));
        assertEquals(root, AssistantBrowserPolicy.openingUrl(root, "about:blank", true, true, root));
    }
    @Test public void explicitResumePreservesClosedFormsAndLoginWithoutPreservingOtherSteps() {
        String root = "https://dash.cloudflare.com/";
        for (String current : new String[] {
            root + "account/workers-and-pages/create/workers/new",
            "https://github.com/apps/cloudflare-workers-and-pages/installations/new",
            "https://accounts.google.com/signin"
        }) assertNull(current, AssistantBrowserPolicy.openingUrl(root, current, true, true, root));
        assertEquals(root, AssistantBrowserPolicy.openingUrl(root, root + "account/home", true, false, root));
        assertEquals(root, AssistantBrowserPolicy.openingUrl(root, "about:blank", true, true, root));
        assertEquals(root, AssistantBrowserPolicy.openingUrl(root, null, true, true, root));
        assertEquals(root, AssistantBrowserPolicy.openingUrl(root, "http://example.com", true, true, root));
        assertEquals(root, AssistantBrowserPolicy.openingUrl(null, null, true, true, root));
        assertEquals(root, AssistantBrowserPolicy.openingUrl(null, "about:blank", true, true, root));
    }
    @Test public void permitsRepositoryInstallationPagesWhileKeepingAccountLoginHumanOwned() {
        for (String path : new String[] { "/apps/cloudflare-workers-and-pages/installations/new", "/settings/installations/123", "/organizations/example/settings/installations/123" }) {
            assertTrue(AssistantBrowserPolicy.repositoryAuthorization("https://github.com" + path));
            assertFalse(AssistantBrowserPolicy.userOnly("cf-deploy", "https://github.com" + path));
        }
        assertFalse(AssistantBrowserPolicy.authentication("https://github.com/login/oauth/authorize"));
        assertTrue(AssistantBrowserPolicy.authentication("https://github.com/login"));
        assertFalse(AssistantBrowserPolicy.repositoryAuthorization("https://example.com/apps/cloudflare-workers-and-pages/installations/new"));
    }
    @Test public void classifiesActualLocationWithoutTreatingTheDeploymentStepAsAuthorization() {
        assertEquals("public", AssistantBrowserPolicy.pageAccess("cf-deploy", "https://dash.cloudflare.com/account/home"));
        assertEquals("public", AssistantBrowserPolicy.pageAccess("cf-deploy", "https://dash.cloudflare.com/account/workers-and-pages/create"));
        assertEquals("authentication", AssistantBrowserPolicy.pageAccess("cf-deploy", "https://github.com/login"));
        assertEquals("public", AssistantBrowserPolicy.pageAccess("cf-deploy", "https://github.com/apps/cloudflare-workers-and-pages/installations/new/permissions/authorize"));
        assertEquals("protected", AssistantBrowserPolicy.pageAccess("cf-deploy", "https://discord.com/developers/applications/1234567890123456789/bot"));
        assertEquals("external", AssistantBrowserPolicy.pageAccess("cf-deploy", "https://accounts.google.com/"));
    }
    @Test public void publicConfigurationAuthorityCoversTheEntirePathIncludingGithubAndWorkerDeployment() {
        String[][] pages = {
            { "discord-app", "https://discord.com/developers/applications" },
            { "discord-app", "https://discord.com/developers/applications/1234567890123456789/information" },
            { "d1-create", "https://dash.cloudflare.com/account/d1/create" },
            { "d1-uuid", "https://dash.cloudflare.com/account/d1/databases/12345678-1234-5678-9abc-123456789abc/settings" },
            { "github-fork", "https://github.com/jixiangruyi117/SRL-Discord-Bridge/fork" },
            { "wrangler-edit", "https://github.com/test-user/SRL-Discord-Bridge/edit/main/wrangler.jsonc" },
            { "wrangler-check", "https://github.com/test-user/SRL-Discord-Bridge/edit/main/wrangler.jsonc" },
            { "github-save", "https://github.com/test-user/SRL-Discord-Bridge/blob/main/wrangler.jsonc" },
            { "github-sync", "https://github.com/test-user/SRL-Discord-Bridge" },
            { "cf-deploy", "https://dash.cloudflare.com/account/workers-and-pages/create" },
            { "cf-deploy", "https://dash.cloudflare.com/account/workers/services/view/srl-discord-source-bridge/settings/builds" },
            { "d1-create", "https://dash.cloudflare.com/account/workers/services/view/srl-discord-source-bridge/settings" },
            { "github-fork", "https://dash.cloudflare.com/account/workers/services/view/srl-discord-source-bridge/production/settings" },
            { "cf-deploy", "https://dash.cloudflare.com/account/workers/services/view/srl-discord-source-bridge/settings/bindings" },
            { "cf-deploy", "https://dash.cloudflare.com/account/workers/services/view/srl-discord-source-bridge/settings/triggers" },
            { "cf-deploy", "https://dash.cloudflare.com/account/workers/services/view/srl-discord-source-bridge/production/settings/builds" },
            { "cf-deploy", "https://dash.cloudflare.com/account/workers/services/view/srl-discord-source-bridge/production" },
            { "worker-url", "https://dash.cloudflare.com/account/workers/services/view/srl-discord-source-bridge/production" },
            { "discord-endpoint", "https://discord.com/developers/applications/1234567890123456789/information" },
            { "discord-install", "https://discord.com/developers/applications/1234567890123456789/installation" }
        };
        for (String[] page : pages) {
            assertTrue(page[1], AssistantBrowserPolicy.allowed(page[1]));
            assertFalse(page[1], AssistantBrowserPolicy.userOnly(page[0], page[1]));
            assertTrue(page[1], AssistantBrowserPolicy.blocksUserInput("agent", "run", false, false, false, page[0], page[1]));
            assertFalse(page[1], AssistantBrowserPolicy.blocksUserInput("agent", "", true, false, false, page[0], page[1]));
        }
        assertTrue(AssistantBrowserPolicy.userOnly("d1-uuid", "https://dash.cloudflare.com/account/d1/databases/db/api-tokens"));
        assertFalse(AssistantBrowserPolicy.userOnly("cf-deploy", "https://dash.cloudflare.com/account/workers/services/view/srl-discord-source-bridge/settings/variables"));
    }
    @Test public void allowsPublicHttpsLoginBrowsingWithoutGrantingAgentAuthority() {
        String google = "https://accounts.google.com/v3/signin/identifier?code=PRIVATE";
        assertTrue(AssistantBrowserPolicy.browseAllowed(google));
        assertFalse(AssistantBrowserPolicy.allowed(google));
        assertTrue(AssistantBrowserPolicy.userOnly("discord-app", google));
        assertEquals("https://accounts.google.com/", AssistantBrowserPolicy.publicUrl(google));
        for (String url : new String[] { "http://accounts.google.com/", "https://user@accounts.google.com/", "https://127.0.0.1/", "https://app.local/", "file:///foo", "javascript:alert(1)" }) assertFalse(url, AssistantBrowserPolicy.browseAllowed(url));
    }
    @Test public void locksOnlyActivePublicAgentWorkAndAllowsExplicitUserHandoffs() {
        String publicPage = "https://discord.com/developers/applications/1234567890123456789/information";
        assertTrue(AssistantBrowserPolicy.blocksUserInput("agent", "run", false, false, false, "discord-app", publicPage));
        assertFalse(AssistantBrowserPolicy.blocksUserInput("agent", "run", true, false, false, "discord-app", publicPage));
        assertFalse(AssistantBrowserPolicy.blocksUserInput("agent", "", false, false, false, "discord-app", publicPage));
        assertFalse(AssistantBrowserPolicy.blocksUserInput("agent", "run", false, false, false, "discord-app", "https://accounts.google.com/signin"));
        assertFalse(AssistantBrowserPolicy.blocksUserInput("agent", "run", false, false, false, "discord-token", publicPage.replace("information", "bot")));
        assertFalse(AssistantBrowserPolicy.blocksUserInput("economy", "run", false, false, false, "discord-app", publicPage));
    }
    @Test public void navigationAllowsAllThreeAuthorizedHttpsSites() {
        String current = "https://discord.com/developers/applications";
        assertTrue(AssistantBrowserPolicy.navigationAllowed(current, current + "/1234567890123456789/information"));
        assertTrue(AssistantBrowserPolicy.navigationAllowed(current, "https://github.com/test/repo"));
        assertTrue(AssistantBrowserPolicy.navigationAllowed(current, "https://dash.cloudflare.com/account/d1"));
        for (String url : new String[] { "https://discord.com.example/", "http://discord.com/", "https://user:pass@discord.com/", "https://discord.com:8443/", "javascript:alert(1)" }) assertFalse(AssistantBrowserPolicy.navigationAllowed(current, url));
    }
    @Test public void tokenCaptureErrorsDistinguishVerificationFromPageRecognitionAndPreserveOldSecret() {
        assertTrue(AssistantBrowserPolicy.botSecretCaptureError("verification-required").contains("密码验证"));
        assertTrue(AssistantBrowserPolicy.botSecretCaptureError("ambiguous-token").contains("未覆盖原密钥"));
        assertFalse(AssistantBrowserPolicy.botSecretCaptureError("token-not-displayed").contains("完成网站验证"));
        assertTrue(AssistantBrowserPolicy.botSecretCaptureError("wrong-app").contains("本次 App"));
        assertEquals(AssistantBrowserPolicy.botSecretCaptureError("token-not-displayed"), AssistantBrowserPolicy.botSecretCaptureError("untrusted-page-reason"));
    }
    @Test public void installationIsSameAppWithoutCustomRedirectOrAccountAccess() {
        String id = "1234567890123456789";
        String url = "https://discord.com/oauth2/authorize?client_id=" + id;
        assertTrue(AssistantBrowserPolicy.installLink(url, id));
        assertTrue(AssistantBrowserPolicy.installLink(url + "&scope=applications.commands+bot&integration_type=1", id));
        for (String suffix : new String[] { "&client_id=" + id, "&redirect_uri=https://example.com", "&scope=identify", "&response_type=code", "#token" }) assertFalse(AssistantBrowserPolicy.installLink(url + suffix, id));
        assertFalse(AssistantBrowserPolicy.installLink(url, "9876543210123456789"));
        assertFalse(AssistantBrowserPolicy.installLink(url.replace("discord.com", "discord.com.example"), id));
    }
    @Test public void secretExceptionRequiresScopedPreparationOrUserHandoff() {
        String url = "https://dash.cloudflare.com/account/workers/services/view/srl-discord-source-bridge/production/settings";
        assertTrue(AssistantBrowserPolicy.secretOperationAllowed("prepare-secret", "agent", "cf-secret", url, "prepare"));
        assertTrue(AssistantBrowserPolicy.secretOperationAllowed("prepare-secret", "agent", "cf-secret", url, "submit"));
        assertFalse(AssistantBrowserPolicy.secretOperationAllowed("prepare-secret", "agent", "cf-secret", url, "input"));
        assertTrue(AssistantBrowserPolicy.secretOperationAllowed("submit-secret", "agent", "cf-secret", url, "submit"));
        assertTrue(AssistantBrowserPolicy.secretOperationAllowed("submit-secret", "agent", "cf-secret", url, "saved"));
        for (String stage : new String[] { "", "prepare", "input", "submitted" }) assertFalse(AssistantBrowserPolicy.secretOperationAllowed("submit-secret", "agent", "cf-secret", url, stage));
        assertFalse(AssistantBrowserPolicy.secretOperationAllowed("inspect", "agent", "cf-secret", url, "prepare"));
        assertFalse(AssistantBrowserPolicy.secretOperationAllowed("prepare-secret", "economy", "cf-secret", url, "prepare"));
        assertEquals("/account/workers/services/view/other", AssistantBrowserPolicy.secretScope(url.replace("srl-discord-source-bridge", "other")));
        assertNull(AssistantBrowserPolicy.secretScope(url.replace("production", "staging")));
        assertNull(AssistantBrowserPolicy.secretScope("https://dash.cloudflare.com/login"));
        assertFalse(AssistantBrowserPolicy.userOnly("cf-secret", url));
    }
    @Test public void checksSpecificOutcomesRatherThanButtonClicks() {
        assertTrue(AssistantBrowserPolicy.successChecklist("github-sync").contains("up to date"));
        assertTrue(AssistantBrowserPolicy.successChecklist("github-save").contains("最新提交"));
        assertTrue(AssistantBrowserPolicy.successChecklist("cf-deploy").contains("当前生产部署"));
        assertTrue(AssistantBrowserPolicy.successChecklist("discord-install").contains("安装成功不等于指令注册成功"));
        assertNull(AssistantBrowserPolicy.successChecklist("done"));
        assertNull(AssistantBrowserPolicy.successChecklist("arbitrary-web-step"));
    }
    @Test public void cannotConfirmSuccessOnLoginAuthorizationOrOverviewPages() {
        assertFalse(AssistantBrowserPolicy.successLocation("cf-deploy", "https://dash.cloudflare.com/login"));
        assertFalse(AssistantBrowserPolicy.successLocation("cf-deploy", "https://dash.cloudflare.com/account/workers"));
        assertTrue(AssistantBrowserPolicy.successLocation("cf-deploy", "https://dash.cloudflare.com/account/workers/services/view/example/production"));
        assertFalse(AssistantBrowserPolicy.successLocation("discord-install", "https://discord.com/oauth2/authorize"));
        assertFalse(AssistantBrowserPolicy.successLocation("discord-install", "https://discord.com/developers/applications/1234567890123456789/bot"));
        assertTrue(AssistantBrowserPolicy.successLocation("discord-install", "https://discord.com/developers/applications/1234567890123456789/installation"));
        assertTrue(AssistantBrowserPolicy.successLocation("discord-install", "https://discord.com/developers/applications/1234567890123456789/install"));
        assertTrue(AssistantBrowserPolicy.successLocation("discord-endpoint", "https://discord.com/developers/applications/1234567890123456789/general-information"));
    }
    @Test public void admitsOnlyExactOfficialHttpsHosts() {
        assertTrue(AssistantBrowserPolicy.allowed("https://github.com/test/repo"));
        assertTrue(AssistantBrowserPolicy.allowed("https://dash.cloudflare.com/login"));
        assertTrue(AssistantBrowserPolicy.allowed("https://discord.com/developers/applications"));
        assertTrue(AssistantBrowserPolicy.allowed("https://github.com:443/"));
        for (String url : new String[] { "http://github.com/", "https://github.com.evil.example/", "https://token@github.com/", "https://github.com:8443/", "file:///storage/file", "javascript:alert(1)", "https://127.0.0.1/" }) assertFalse(url, AssistantBrowserPolicy.allowed(url));
    }
    @Test public void hidesOauthCodesAndLoginSecrets() {
        assertEquals("https://github.com/login", AssistantBrowserPolicy.publicUrl("https://github.com/login?code=PRIVATE#token"));
        assertTrue(AssistantBrowserPolicy.authentication("https://github.com/login/device"));
        assertTrue(AssistantBrowserPolicy.authentication("https://discord.com/oauth2/authorize?client_id=123"));
        assertFalse(AssistantBrowserPolicy.userOnly("cf-secret", "https://dash.cloudflare.com/account/workers"));
        assertFalse(AssistantBrowserPolicy.userOnly("cf-secret", "https://dash.cloudflare.com/account/d1/databases/12345678-1234-5678-9abc-123456789abc/settings"));
        assertFalse(AssistantBrowserPolicy.userOnly("cf-secret", "https://github.com/test/repo"));
        assertTrue(AssistantBrowserPolicy.userOnly("discord-app", "https://discord.com/developers/applications/1234567890123456789/bot"));
        assertTrue(AssistantBrowserPolicy.userOnly("discord-app", "https://discord.com/developers/applications/1234567890123456789/bot?view=token"));
        assertFalse(AssistantBrowserPolicy.userOnly("cf-deploy", "https://dash.cloudflare.com/account/workers/services/view/another-worker/settings/variables"));
        assertFalse(AssistantBrowserPolicy.userOnly("wrangler-edit", "https://github.com/test/repo/edit/main/wrangler.jsonc"));
    }
    @Test public void permitsSecretPublicControlsUntilActualSecretInputOrTaskStop() {
        String url = "https://dash.cloudflare.com/account/workers/services/view/bridge/production/settings";
        String scope = AssistantBrowserPolicy.secretScope(url);
        for (String stage : new String[] { "prepare", "submit", "saved" }) {
            assertTrue(AssistantBrowserPolicy.secretPublicControlsAllowed("agent", "run", "cf-secret", url, scope, stage));
            assertFalse(AssistantBrowserPolicy.secretPublicControlsAllowed("agent", "", "cf-secret", url, scope, stage));
            assertFalse(AssistantBrowserPolicy.secretPublicControlsAllowed("economy", "run", "cf-secret", url, scope, stage));
            assertFalse(AssistantBrowserPolicy.secretPublicControlsAllowed("agent", "run", "cf-secret", url.replace("/bridge/", "/other/"), scope, stage));
        }
        assertFalse(AssistantBrowserPolicy.secretPublicControlsAllowed("agent", "run", "cf-secret", url, scope, "input"));
        assertFalse(AssistantBrowserPolicy.secretPublicControlsAllowed("agent", "run", "cf-secret", url, scope, "submitted"));
    }
    @Test public void preservesTheInFlightSecretSubmitOnSameWorkerNavigationOnly() {
        String url = "https://dash.cloudflare.com/account/workers/services/view/bridge/production/settings";
        String scope = AssistantBrowserPolicy.secretScope(url);
        for (String stage : new String[] { "prepare", "submit", "saved", "submitted" }) {
            assertTrue(AssistantBrowserPolicy.retainSecretStageOnNavigation(scope, url.replace("/settings", ""), stage));
            assertFalse(AssistantBrowserPolicy.retainSecretStageOnNavigation(scope, url.replace("/bridge/", "/other/"), stage));
            assertFalse(AssistantBrowserPolicy.retainSecretStageOnNavigation(scope, "https://dash.cloudflare.com/login", stage));
        }
        assertFalse(AssistantBrowserPolicy.retainSecretStageOnNavigation(scope, url, "input"));
        assertTrue(AssistantBrowserPolicy.secretMetadataAllowed("agent", "run", "cf-secret", url, scope, "input"));
        assertFalse(AssistantBrowserPolicy.secretPublicControlsAllowed("agent", "run", "cf-secret", url, scope, "input"));
        assertFalse(AssistantBrowserPolicy.secretMetadataAllowed("agent", "", "cf-secret", url, scope, "input"));
    }
    @Test public void publicEndpointFillingDoesNotBecomeAnUnauthorizedManualPause() {
        assertFalse(AssistantBrowserPolicy.userHandoffRequired("fill-endpoint", true, "run"));
        assertTrue(AssistantBrowserPolicy.userHandoffRequired("fill-endpoint", true, ""));
        assertTrue(AssistantBrowserPolicy.userHandoffRequired("open-install", true, "run"));
        assertTrue(AssistantBrowserPolicy.userHandoffRequired("inspect", true, "run"));
        assertTrue(AssistantBrowserPolicy.userHandoffRequired("guide", true, "run"));
    }
    @Test public void asksBeforeStateChangingActions() {
        assertTrue(AssistantBrowserPolicy.requiresConfirmation("template", ""));
        assertTrue(AssistantBrowserPolicy.requiresConfirmation("click", "Commit changes"));
        assertTrue(AssistantBrowserPolicy.requiresConfirmation("click", "Update branch"));
        assertFalse(AssistantBrowserPolicy.requiresConfirmation("fill", "Database name"));
        assertFalse(AssistantBrowserPolicy.requiresConfirmation("click", "Settings"));
    }
    @Test public void waitsForPublicStatusAtAnyTaskPhaseButNeverAfterHandoffOrStop() {
        String url = "https://dash.cloudflare.com/account/workers/services/view/bridge/production";
        for (String step : new String[] { "discord-app", "discord-token", "d1-create", "d1-uuid", "github-fork", "github-sync", "wrangler-edit", "wrangler-check", "github-save", "cf-deploy", "cf-secret", "worker-url", "discord-endpoint", "discord-install", "local-settings", "register", "verify", "diagnose" }) {
            assertTrue(step, AssistantBrowserPolicy.statusWaitAllowed("agent", "run", false, false, false, step, url));
        }
        assertFalse(AssistantBrowserPolicy.statusWaitAllowed("economy", "run", false, false, false, "cf-deploy", url));
        assertFalse(AssistantBrowserPolicy.statusWaitAllowed("agent", "", false, false, false, "cf-deploy", url));
        assertFalse(AssistantBrowserPolicy.statusWaitAllowed("agent", "run", true, false, false, "cf-deploy", url));
        assertFalse(AssistantBrowserPolicy.statusWaitAllowed("agent", "run", false, true, false, "cf-deploy", url));
        assertFalse(AssistantBrowserPolicy.statusWaitAllowed("agent", "run", false, false, true, "cf-deploy", url));
        assertFalse(AssistantBrowserPolicy.statusWaitAllowed("agent", "run", false, false, false, "cf-deploy", "https://dash.cloudflare.com/login"));
        assertTrue(AssistantBrowserPolicy.statusWaitAllowed("agent", "run", false, false, false, "cf-deploy", url + "/settings/variables"));
        assertTrue(AssistantBrowserPolicy.userOnly("cf-deploy", "https://dash.cloudflare.com/account/settings"));
    }
}
