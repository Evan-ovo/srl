package buzz.jixiangruyi1207.srl;

import static org.junit.Assert.*;
import org.junit.Test;

public class DiscordSetupSecretTransferTest {
    @Test public void refusesInvalidTransferKeysBeforeAccessingAndroidEncoding() {
        String token = "TEST_DISCORD_TOKEN_PLACEHOLDER";
        assertThrows(IllegalArgumentException.class, () -> DiscordSetupSecretTransfer.seal(token, null));
        assertThrows(IllegalArgumentException.class, () -> DiscordSetupSecretTransfer.seal(token, new String(new char[1025])));
    }
    @Test public void refusesMaskedOrInvalidTokens() {
        assertThrows(IllegalArgumentException.class, () -> DiscordSetupSecretTransfer.seal("********", "key"));
        assertThrows(IllegalArgumentException.class, () -> DiscordSetupSecretTransfer.seal("password", "key"));
    }
}
