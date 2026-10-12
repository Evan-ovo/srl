package buzz.jixiangruyi1207.srl;

import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.SecureRandom;
import java.security.spec.MGF1ParameterSpec;
import java.security.spec.X509EncodedKeySpec;
import android.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.OAEPParameterSpec;
import javax.crypto.spec.PSource;
import javax.crypto.spec.SecretKeySpec;

/** Transport primitive, not a credential store. Plaintext never crosses the Capacitor reply. */
final class DiscordSetupSecretTransfer {
    static Map<String, String> seal(String secret, String publicKey) throws Exception {
        if (secret == null || secret.length() > 512 || !secret.matches("[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{20,}")) throw new IllegalArgumentException("Bot Token unavailable");
        if (publicKey == null || publicKey.length() > 1024) throw new IllegalArgumentException("Transfer key invalid");
        byte[] key = new byte[32], iv = new byte[12], plain = secret.getBytes(StandardCharsets.UTF_8);
        SecureRandom random = new SecureRandom(); random.nextBytes(key); random.nextBytes(iv);
        try {
            Cipher aes = Cipher.getInstance("AES/GCM/NoPadding");
            aes.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv));
            aes.updateAAD("srl-discord-bot-transfer-v1".getBytes(StandardCharsets.UTF_8));
            byte[] encrypted = aes.doFinal(plain);
            Cipher rsa = Cipher.getInstance("RSA/ECB/OAEPWithSHA-256AndMGF1Padding");
            rsa.init(Cipher.ENCRYPT_MODE, KeyFactory.getInstance("RSA").generatePublic(new X509EncodedKeySpec(Base64.decode(publicKey, Base64.NO_WRAP))), new OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA256, PSource.PSpecified.DEFAULT));
            Map<String, String> result = new LinkedHashMap<>();
            result.put("key", Base64.encodeToString(rsa.doFinal(key), Base64.NO_WRAP));
            result.put("iv", Base64.encodeToString(iv, Base64.NO_WRAP));
            result.put("data", Base64.encodeToString(encrypted, Base64.NO_WRAP));
            return result;
        } finally { java.util.Arrays.fill(key, (byte) 0); java.util.Arrays.fill(plain, (byte) 0); }
    }
}
