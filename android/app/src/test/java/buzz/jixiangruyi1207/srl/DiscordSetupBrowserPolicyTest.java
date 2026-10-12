package buzz.jixiangruyi1207.srl;
import static org.junit.Assert.*;
import org.junit.Test;
public class DiscordSetupBrowserPolicyTest {
    @Test public void publicInstallationReceiptRequiresTheSameAppOrAnAlreadyBoundRedirect() {
        String app = "1234567890123456789";
        assertTrue(DiscordSetupBrowserPolicy.installationResultPage("https://discord.com/oauth2/authorize?client_id=" + app, app, false));
        assertFalse(DiscordSetupBrowserPolicy.installationResultPage("https://discord.com/oauth2/authorize?client_id=2234567890123456789", app, true));
        assertFalse(DiscordSetupBrowserPolicy.installationResultPage("https://discord.com/oauth2/authorized", app, false));
        assertTrue(DiscordSetupBrowserPolicy.installationResultPage("https://discord.com/oauth2/authorized", app, true));
        assertFalse(DiscordSetupBrowserPolicy.installationResultPage("https://discord.com/oauth2/authorize?client_id=" + app + "&client_id=" + app, app, true));
        assertFalse(DiscordSetupBrowserPolicy.installationResultPage("https://example.com/oauth2/authorized", app, true));
        assertFalse(DiscordSetupBrowserPolicy.installationResultPage("https://discord.com/login", app, true));
    }
    @Test public void failedPublicPageCanBeLeftOnlyByAnActiveAuthorizedAgent() {
        String preview = "https://preview.bridge.account.workers.dev/";
        String dashboard = "https://dash.cloudflare.com/account/workers/services/view/bridge/production";
        assertTrue(DiscordSetupBrowserPolicy.agentNavigationAllowed("agent", "run", true, false, true, "cf-deploy", preview, dashboard));
        assertFalse(DiscordSetupBrowserPolicy.agentNavigationAllowed("agent", "run", true, false, true, "cf-deploy", preview, preview));
        assertFalse(DiscordSetupBrowserPolicy.agentNavigationAllowed("agent", "", true, false, true, "cf-deploy", preview, dashboard));
        assertFalse(DiscordSetupBrowserPolicy.agentNavigationAllowed("economy", "run", true, false, true, "cf-deploy", preview, dashboard));
        assertFalse(DiscordSetupBrowserPolicy.agentNavigationAllowed("agent", "run", true, true, true, "cf-deploy", preview, dashboard));
        assertFalse(DiscordSetupBrowserPolicy.agentNavigationAllowed("agent", "run", true, false, false, "cf-deploy", preview, dashboard));
        assertFalse(DiscordSetupBrowserPolicy.agentNavigationAllowed("agent", "run", true, false, true, "cf-deploy", "https://github.com/login", dashboard));
        assertTrue(DiscordSetupBrowserPolicy.agentNavigationAllowed("agent", "run", true, false, true, "cf-secret", dashboard + "/settings/variables", dashboard));
        assertFalse(DiscordSetupBrowserPolicy.agentNavigationAllowed("agent", "run", true, false, true, "cf-deploy", preview, "https://example.com/"));
        assertTrue(DiscordSetupBrowserPolicy.agentNavigationAllowed("agent", "run", false, false, false, "cf-deploy", preview, dashboard));
    }
    @Test public void workerPreviewIsPublicAndCanReturnToTheDeploymentDashboard() {
        String dashboard = "https://dash.cloudflare.com/account/workers/services/view/bridge/production";
        for (String path : new String[] { "/", "/interactions", "/health" }) {
            String preview = "https://preview-abc.bridge.account.workers.dev" + path;
            assertTrue(DiscordSetupBrowserPolicy.allowed(preview));
            assertFalse(DiscordSetupBrowserPolicy.userOnly("cf-deploy", preview));
            assertEquals("public", DiscordSetupBrowserPolicy.pageAccess("cf-deploy", preview));
            assertTrue(DiscordSetupBrowserPolicy.navigationAllowed(preview, dashboard));
            assertTrue(DiscordSetupBrowserPolicy.navigationAllowed(dashboard, preview));
            assertFalse(DiscordSetupBrowserPolicy.successLocation("cf-deploy", preview));
        }
        for (String url : new String[] { "https://workers.dev/", "https://bridge.account.workers.dev.example/", "https://credential@bridge.account.workers.dev/", "http://bridge.account.workers.dev/", "https://bridge.account.workers.dev:444/" }) assertFalse(url, DiscordSetupBrowserPolicy.allowed(url));
        assertEquals("authentication", DiscordSetupBrowserPolicy.pageAccess("cf-deploy", "https://bridge.account.workers.dev/login"));
    }
    @Test public void handoffMessageMatchesActualAccessInsteadOfInventingLogin() {
        assertTrue(DiscordSetupBrowserPolicy.handoffReason("cf-deploy", "https://github.com/login").contains("登录"));
        String google = "https://accounts.google.com/v3/signin/identifier";
        assertEquals("authentication", DiscordSetupBrowserPolicy.pageAccess("cf-deploy", google));
        assertTrue(DiscordSetupBrowserPolicy.handoffReason("cf-deploy", google).contains("登录"));
        assertFalse(DiscordSetupBrowserPolicy.allowed(google));
        assertTrue(DiscordSetupBrowserPolicy.handoffReason("cf-deploy", "https://discord.com/developers/applications/1234567890123456789/bot").contains("秘密"));
        String external = DiscordSetupBrowserPolicy.handoffReason("cf-deploy", "https://example.com/");
        assertTrue(external.contains("外部网页"));
        assertFalse(external.contains("登录"));
        assertFalse(external.contains("授权"));
    }
    @Test public void cloudflareConnectionConsentCanBeInspectedButActualLoginRemainsHuman() {
        String url = "https://github.com/login/oauth/authorize?client_id=example";
        assertFalse(DiscordSetupBrowserPolicy.authentication(url));
        assertFalse(DiscordSetupBrowserPolicy.userOnly("cf-deploy", url));
        assertTrue(DiscordSetupBrowserPolicy.authentication("https://github.com/login"));
        assertTrue(DiscordSetupBrowserPolicy.authentication("https://accounts.google.com/o/oauth/authorize"));
        assertFalse(DiscordSetupBrowserPolicy.connectionConsent("https://github.com.evil.example/login/oauth/authorize"));
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
        }) assertNull(current, DiscordSetupBrowserPolicy.openingUrl(root, current, true, true, root));
        assertEquals(root, DiscordSetupBrowserPolicy.openingUrl(root, "https://github.com/test/repo", true, false, root));
        assertEquals(root, DiscordSetupBrowserPolicy.openingUrl(root, "https://github.com/test/repo", false, true, root));
        assertEquals(root, DiscordSetupBrowserPolicy.openingUrl(null, "https://github.com/test/repo", false, true, root));
        assertNull(DiscordSetupBrowserPolicy.openingUrl(null, root + "account/home", false, true, root));
        assertEquals(root, DiscordSetupBrowserPolicy.openingUrl(root, "about:blank", true, true, root));
    }
    @Test public void explicitResumePreservesClosedFormsAndLoginWithoutPreservingOtherSteps() {
        String root = "https://dash.cloudflare.com/";
        for (String current : new String[] {
            root + "account/workers-and-pages/create/workers/new",
            "https://github.com/apps/cloudflare-workers-and-pages/installations/new",
            "https://accounts.google.com/signin"
        }) assertNull(current, DiscordSetupBrowserPolicy.openingUrl(root, current, true, true, root));
        assertEquals(root, DiscordSetupBrowserPolicy.openingUrl(root, root + "account/home", true, false, root));
        assertEquals(root, DiscordSetupBrowserPolicy.openingUrl(root, "about:blank", true, true, root));
        assertEquals(root, DiscordSetupBrowserPolicy.openingUrl(root, null, true, true, root));
        assertEquals(root, DiscordSetupBrowserPolicy.openingUrl(root, "http://example.com", true, true, root));
        assertEquals(root, DiscordSetupBrowserPolicy.openingUrl(null, null, true, true, root));
        assertEquals(root, DiscordSetupBrowserPolicy.openingUrl(null, "about:blank", true, true, root));
    }
    @Test public void permitsRepositoryInstallationPagesWhileKeepingAccountLoginHumanOwned() {
        for (String path : new String[] { "/apps/cloudflare-workers-and-pages/installations/new", "/settings/installations/123", "/organizations/example/settings/installations/123" }) {
            assertTrue(DiscordSetupBrowserPolicy.repositoryAuthorization("https://github.com" + path));
            assertFalse(DiscordSetupBrowserPolicy.userOnly("cf-deploy", "https://github.com" + path));
        }
        assertFalse(DiscordSetupBrowserPolicy.authentication("https://github.com/login/oauth/authorize"));
        assertTrue(DiscordSetupBrowserPolicy.authentication("https://github.com/login"));
        assertFalse(DiscordSetupBrowserPolicy.repositoryAuthorization("https://example.com/apps/cloudflare-workers-and-pages/installations/new"));
    }
    @Test public void classifiesActualLocationWithoutTreatingTheDeploymentStepAsAuthorization() {
        assertEquals("public", DiscordSetupBrowserPolicy.pageAccess("cf-deploy", "https://dash.cloudflare.com/account/home"));
        assertEquals("public", DiscordSetupBrowserPolicy.pageAccess("cf-deploy", "https://dash.cloudflare.com/account/workers-and-pages/create"));
        assertEquals("authentication", DiscordSetupBrowserPolicy.pageAccess("cf-deploy", "https://github.com/login"));
        assertEquals("public", DiscordSetupBrowserPolicy.pageAccess("cf-deploy", "https://github.com/apps/cloudflare-workers-and-pages/installations/new/permissions/authorize"));
        assertEquals("protected", DiscordSetupBrowserPolicy.pageAccess("cf-deploy", "https://discord.com/developers/applications/1234567890123456789/bot"));
        assertEquals("external", DiscordSetupBrowserPolicy.pageAccess("cf-deploy", "https://accounts.google.com/"));
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
            assertTrue(page[1], DiscordSetupBrowserPolicy.allowed(page[1]));
            assertFalse(page[1], DiscordSetupBrowserPolicy.userOnly(page[0], page[1]));
            assertTrue(page[1], DiscordSetupBrowserPolicy.blocksUserInput("agent", "run", false, false, false, page[0], page[1]));
            assertFalse(page[1], DiscordSetupBrowserPolicy.blocksUserInput("agent", "", true, false, false, page[0], page[1]));
        }
        assertTrue(DiscordSetupBrowserPolicy.userOnly("d1-uuid", "https://dash.cloudflare.com/account/d1/databases/db/api-tokens"));
        assertFalse(DiscordSetupBrowserPolicy.userOnly("cf-deploy", "https://dash.cloudflare.com/account/workers/services/view/srl-discord-source-bridge/settings/variables"));
    }
    @Test public void allowsPublicHttpsLoginBrowsingWithoutGrantingAgentAuthority() {
        String google = "https://accounts.google.com/v3/signin/identifier?code=PRIVATE";
        assertTrue(DiscordSetupBrowserPolicy.browseAllowed(google));
        assertFalse(DiscordSetupBrowserPolicy.allowed(google));
        assertTrue(DiscordSetupBrowserPolicy.userOnly("discord-app", google));
        assertEquals("https://accounts.google.com/", DiscordSetupBrowserPolicy.publicUrl(google));
        for (String url : new String[] { "http://accounts.google.com/", "https://user@accounts.google.com/", "https://127.0.0.1/", "https://app.local/", "file:///foo", "javascript:alert(1)" }) assertFalse(url, DiscordSetupBrowserPolicy.browseAllowed(url));
    }
    @Test public void locksOnlyActivePublicAgentWorkAndAllowsExplicitUserHandoffs() {
        String publicPage = "https://discord.com/developers/applications/1234567890123456789/information";
        assertTrue(DiscordSetupBrowserPolicy.blocksUserInput("agent", "run", false, false, false, "discord-app", publicPage));
        assertFalse(DiscordSetupBrowserPolicy.blocksUserInput("agent", "run", true, false, false, "discord-app", publicPage));
        assertFalse(DiscordSetupBrowserPolicy.blocksUserInput("agent", "", false, false, false, "discord-app", publicPage));
        assertFalse(DiscordSetupBrowserPolicy.blocksUserInput("agent", "run", false, false, false, "discord-app", "https://accounts.google.com/signin"));
        assertFalse(DiscordSetupBrowserPolicy.blocksUserInput("agent", "run", false, false, false, "discord-token", publicPage.replace("information", "bot")));
        assertFalse(DiscordSetupBrowserPolicy.blocksUserInput("economy", "run", false, false, false, "discord-app", publicPage));
    }
    @Test public void navigationAllowsAllThreeAuthorizedHttpsSites() {
        String current = "https://discord.com/developers/applications";
        assertTrue(DiscordSetupBrowserPolicy.navigationAllowed(current, current + "/1234567890123456789/information"));
        assertTrue(DiscordSetupBrowserPolicy.navigationAllowed(current, "https://github.com/test/repo"));
        assertTrue(DiscordSetupBrowserPolicy.navigationAllowed(current, "https://dash.cloudflare.com/account/d1"));
        for (String url : new String[] { "https://discord.com.example/", "http://discord.com/", "https://user:pass@discord.com/", "https://discord.com:8443/", "javascript:alert(1)" }) assertFalse(DiscordSetupBrowserPolicy.navigationAllowed(current, url));
    }
    @Test public void tokenCaptureErrorsDistinguishVerificationFromPageRecognitionAndPreserveOldSecret() {
        assertTrue(DiscordSetupBrowserPolicy.botSecretCaptureError("verification-required").contains("密码验证"));
        assertTrue(DiscordSetupBrowserPolicy.botSecretCaptureError("ambiguous-token").contains("未覆盖原密钥"));
        assertFalse(DiscordSetupBrowserPolicy.botSecretCaptureError("token-not-displayed").contains("完成网站验证"));
        assertTrue(DiscordSetupBrowserPolicy.botSecretCaptureError("wrong-app").contains("本次 App"));
        assertEquals(DiscordSetupBrowserPolicy.botSecretCaptureError("token-not-displayed"), DiscordSetupBrowserPolicy.botSecretCaptureError("untrusted-page-reason"));
    }
    @Test public void installationIsSameAppWithoutCustomRedirectOrAccountAccess() {
        String id = "1234567890123456789";
        String url = "https://discord.com/oauth2/authorize?client_id=" + id;
        assertTrue(DiscordSetupBrowserPolicy.installLink(url, id));
        assertTrue(DiscordSetupBrowserPolicy.installLink(url + "&scope=applications.commands+bot&integration_type=1", id));
        for (String suffix : new String[] { "&client_id=" + id, "&redirect_uri=https://example.com", "&scope=identify", "&response_type=code", "#token" }) assertFalse(DiscordSetupBrowserPolicy.installLink(url + suffix, id));
        assertFalse(DiscordSetupBrowserPolicy.installLink(url, "9876543210123456789"));
        assertFalse(DiscordSetupBrowserPolicy.installLink(url.replace("discord.com", "discord.com.example"), id));
    }
    @Test public void secretExceptionRequiresScopedPreparationOrUserHandoff() {
        String url = "https://dash.cloudflare.com/account/workers/services/view/srl-discord-source-bridge/production/settings";
        assertTrue(DiscordSetupBrowserPolicy.secretOperationAllowed("prepare-secret", "agent", "cf-secret", url, "prepare"));
        assertTrue(DiscordSetupBrowserPolicy.secretOperationAllowed("prepare-secret", "agent", "cf-secret", url, "submit"));
        assertFalse(DiscordSetupBrowserPolicy.secretOperationAllowed("prepare-secret", "agent", "cf-secret", url, "input"));
        assertTrue(DiscordSetupBrowserPolicy.secretOperationAllowed("submit-secret", "agent", "cf-secret", url, "submit"));
        assertTrue(DiscordSetupBrowserPolicy.secretOperationAllowed("submit-secret", "agent", "cf-secret", url, "saved"));
        for (String stage : new String[] { "", "prepare", "input", "submitted" }) assertFalse(DiscordSetupBrowserPolicy.secretOperationAllowed("submit-secret", "agent", "cf-secret", url, stage));
        assertFalse(DiscordSetupBrowserPolicy.secretOperationAllowed("inspect", "agent", "cf-secret", url, "prepare"));
        assertFalse(DiscordSetupBrowserPolicy.secretOperationAllowed("prepare-secret", "economy", "cf-secret", url, "prepare"));
        assertEquals("/account/workers/services/view/other", DiscordSetupBrowserPolicy.secretScope(url.replace("srl-discord-source-bridge", "other")));
        assertNull(DiscordSetupBrowserPolicy.secretScope(url.replace("production", "staging")));
        assertNull(DiscordSetupBrowserPolicy.secretScope("https://dash.cloudflare.com/login"));
        assertFalse(DiscordSetupBrowserPolicy.userOnly("cf-secret", url));
    }
    @Test public void checksSpecificOutcomesRatherThanButtonClicks() {
        assertTrue(DiscordSetupBrowserPolicy.successChecklist("github-sync").contains("up to date"));
        assertTrue(DiscordSetupBrowserPolicy.successChecklist("github-save").contains("最新提交"));
        assertTrue(DiscordSetupBrowserPolicy.successChecklist("cf-deploy").contains("当前生产部署"));
        assertTrue(DiscordSetupBrowserPolicy.successChecklist("discord-install").contains("安装成功不等于指令注册成功"));
        assertNull(DiscordSetupBrowserPolicy.successChecklist("done"));
        assertNull(DiscordSetupBrowserPolicy.successChecklist("arbitrary-web-step"));
    }
    @Test public void cannotConfirmSuccessOnLoginAuthorizationOrOverviewPages() {
        assertFalse(DiscordSetupBrowserPolicy.successLocation("cf-deploy", "https://dash.cloudflare.com/login"));
        assertFalse(DiscordSetupBrowserPolicy.successLocation("cf-deploy", "https://dash.cloudflare.com/account/workers"));
        assertTrue(DiscordSetupBrowserPolicy.successLocation("cf-deploy", "https://dash.cloudflare.com/account/workers/services/view/example/production"));
        assertFalse(DiscordSetupBrowserPolicy.successLocation("discord-install", "https://discord.com/oauth2/authorize"));
        assertFalse(DiscordSetupBrowserPolicy.successLocation("discord-install", "https://discord.com/developers/applications/1234567890123456789/bot"));
        assertTrue(DiscordSetupBrowserPolicy.successLocation("discord-install", "https://discord.com/developers/applications/1234567890123456789/installation"));
        assertTrue(DiscordSetupBrowserPolicy.successLocation("discord-install", "https://discord.com/developers/applications/1234567890123456789/install"));
        assertTrue(DiscordSetupBrowserPolicy.successLocation("discord-endpoint", "https://discord.com/developers/applications/1234567890123456789/general-information"));
    }
    @Test public void admitsOnlyExactOfficialHttpsHosts() {
        assertTrue(DiscordSetupBrowserPolicy.allowed("https://github.com/test/repo"));
        assertTrue(DiscordSetupBrowserPolicy.allowed("https://dash.cloudflare.com/login"));
        assertTrue(DiscordSetupBrowserPolicy.allowed("https://discord.com/developers/applications"));
        assertTrue(DiscordSetupBrowserPolicy.allowed("https://github.com:443/"));
        for (String url : new String[] { "http://github.com/", "https://github.com.evil.example/", "https://token@github.com/", "https://github.com:8443/", "file:///storage/file", "javascript:alert(1)", "https://127.0.0.1/" }) assertFalse(url, DiscordSetupBrowserPolicy.allowed(url));
    }
    @Test public void hidesOauthCodesAndLoginSecrets() {
        assertEquals("https://github.com/login", DiscordSetupBrowserPolicy.publicUrl("https://github.com/login?code=PRIVATE#token"));
        assertTrue(DiscordSetupBrowserPolicy.authentication("https://github.com/login/device"));
        assertTrue(DiscordSetupBrowserPolicy.authentication("https://discord.com/oauth2/authorize?client_id=123"));
        assertFalse(DiscordSetupBrowserPolicy.userOnly("cf-secret", "https://dash.cloudflare.com/account/workers"));
        assertFalse(DiscordSetupBrowserPolicy.userOnly("cf-secret", "https://dash.cloudflare.com/account/d1/databases/12345678-1234-5678-9abc-123456789abc/settings"));
        assertFalse(DiscordSetupBrowserPolicy.userOnly("cf-secret", "https://github.com/test/repo"));
        assertTrue(DiscordSetupBrowserPolicy.userOnly("discord-app", "https://discord.com/developers/applications/1234567890123456789/bot"));
        assertTrue(DiscordSetupBrowserPolicy.userOnly("discord-app", "https://discord.com/developers/applications/1234567890123456789/bot?view=token"));
        assertFalse(DiscordSetupBrowserPolicy.userOnly("cf-deploy", "https://dash.cloudflare.com/account/workers/services/view/another-worker/settings/variables"));
        assertFalse(DiscordSetupBrowserPolicy.userOnly("wrangler-edit", "https://github.com/test/repo/edit/main/wrangler.jsonc"));
    }
    @Test public void permitsSecretPublicControlsUntilActualSecretInputOrTaskStop() {
        String url = "https://dash.cloudflare.com/account/workers/services/view/bridge/production/settings";
        String scope = DiscordSetupBrowserPolicy.secretScope(url);
        for (String stage : new String[] { "prepare", "submit", "saved" }) {
            assertTrue(DiscordSetupBrowserPolicy.secretPublicControlsAllowed("agent", "run", "cf-secret", url, scope, stage));
            assertFalse(DiscordSetupBrowserPolicy.secretPublicControlsAllowed("agent", "", "cf-secret", url, scope, stage));
            assertFalse(DiscordSetupBrowserPolicy.secretPublicControlsAllowed("economy", "run", "cf-secret", url, scope, stage));
            assertFalse(DiscordSetupBrowserPolicy.secretPublicControlsAllowed("agent", "run", "cf-secret", url.replace("/bridge/", "/other/"), scope, stage));
        }
        assertFalse(DiscordSetupBrowserPolicy.secretPublicControlsAllowed("agent", "run", "cf-secret", url, scope, "input"));
        assertFalse(DiscordSetupBrowserPolicy.secretPublicControlsAllowed("agent", "run", "cf-secret", url, scope, "submitted"));
    }
    @Test public void preservesTheInFlightSecretSubmitOnSameWorkerNavigationOnly() {
        String url = "https://dash.cloudflare.com/account/workers/services/view/bridge/production/settings";
        String scope = DiscordSetupBrowserPolicy.secretScope(url);
        for (String stage : new String[] { "prepare", "submit", "saved", "submitted" }) {
            assertTrue(DiscordSetupBrowserPolicy.retainSecretStageOnNavigation(scope, url.replace("/settings", ""), stage));
            assertFalse(DiscordSetupBrowserPolicy.retainSecretStageOnNavigation(scope, url.replace("/bridge/", "/other/"), stage));
            assertFalse(DiscordSetupBrowserPolicy.retainSecretStageOnNavigation(scope, "https://dash.cloudflare.com/login", stage));
        }
        assertFalse(DiscordSetupBrowserPolicy.retainSecretStageOnNavigation(scope, url, "input"));
        assertTrue(DiscordSetupBrowserPolicy.secretMetadataAllowed("agent", "run", "cf-secret", url, scope, "input"));
        assertFalse(DiscordSetupBrowserPolicy.secretPublicControlsAllowed("agent", "run", "cf-secret", url, scope, "input"));
        assertFalse(DiscordSetupBrowserPolicy.secretMetadataAllowed("agent", "", "cf-secret", url, scope, "input"));
    }
    @Test public void publicEndpointFillingDoesNotBecomeAnUnauthorizedManualPause() {
        assertFalse(DiscordSetupBrowserPolicy.userHandoffRequired("fill-endpoint", true, "run"));
        assertTrue(DiscordSetupBrowserPolicy.userHandoffRequired("fill-endpoint", true, ""));
        assertTrue(DiscordSetupBrowserPolicy.userHandoffRequired("open-install", true, "run"));
        assertTrue(DiscordSetupBrowserPolicy.userHandoffRequired("inspect", true, "run"));
        assertTrue(DiscordSetupBrowserPolicy.userHandoffRequired("guide", true, "run"));
    }
    @Test public void asksBeforeStateChangingActions() {
        assertTrue(DiscordSetupBrowserPolicy.requiresConfirmation("template", ""));
        assertTrue(DiscordSetupBrowserPolicy.requiresConfirmation("click", "Commit changes"));
        assertTrue(DiscordSetupBrowserPolicy.requiresConfirmation("click", "Update branch"));
        assertFalse(DiscordSetupBrowserPolicy.requiresConfirmation("fill", "Database name"));
        assertFalse(DiscordSetupBrowserPolicy.requiresConfirmation("click", "Settings"));
    }
    @Test public void waitsForPublicStatusAtAnyTaskPhaseButNeverAfterHandoffOrStop() {
        String url = "https://dash.cloudflare.com/account/workers/services/view/bridge/production";
        for (String step : new String[] { "discord-app", "discord-token", "d1-create", "d1-uuid", "github-fork", "github-sync", "wrangler-edit", "wrangler-check", "github-save", "cf-deploy", "cf-secret", "worker-url", "discord-endpoint", "discord-install", "local-settings", "register", "verify", "diagnose" }) {
            assertTrue(step, DiscordSetupBrowserPolicy.statusWaitAllowed("agent", "run", false, false, false, step, url));
        }
        assertFalse(DiscordSetupBrowserPolicy.statusWaitAllowed("economy", "run", false, false, false, "cf-deploy", url));
        assertFalse(DiscordSetupBrowserPolicy.statusWaitAllowed("agent", "", false, false, false, "cf-deploy", url));
        assertFalse(DiscordSetupBrowserPolicy.statusWaitAllowed("agent", "run", true, false, false, "cf-deploy", url));
        assertFalse(DiscordSetupBrowserPolicy.statusWaitAllowed("agent", "run", false, true, false, "cf-deploy", url));
        assertFalse(DiscordSetupBrowserPolicy.statusWaitAllowed("agent", "run", false, false, true, "cf-deploy", url));
        assertFalse(DiscordSetupBrowserPolicy.statusWaitAllowed("agent", "run", false, false, false, "cf-deploy", "https://dash.cloudflare.com/login"));
        assertTrue(DiscordSetupBrowserPolicy.statusWaitAllowed("agent", "run", false, false, false, "cf-deploy", url + "/settings/variables"));
        assertTrue(DiscordSetupBrowserPolicy.userOnly("cf-deploy", "https://dash.cloudflare.com/account/settings"));
    }
}
