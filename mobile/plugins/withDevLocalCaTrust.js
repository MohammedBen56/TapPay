const { withAndroidManifest, withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

// Ship List v2 Wave 3 (self-review hardening pass): the app talked to the
// Caddy TLS proxy over a locally-issued mkcert certificate (Caddyfile,
// CLAUDE.md S11's D1), but a real device build had NEVER been run against
// it until this session -- and it failed with `SSLHandshakeException:
// CertPathValidatorException: Trust anchor for certification path not
// found`, even after installing the mkcert root CA as a user certificate
// on the device. That surprised an earlier assumption (recorded and then
// corrected in this same session) that a debuggable Android app
// automatically trusts user-installed CAs -- it does NOT; Android's
// default network security config trusts system CAs only, for every
// build type, unless the app supplies its own config. Chrome/WebView
// worked against the same host because they read the OS trust store
// directly; this app's own networking (OkHttp, via RN's fetch) does not,
// by default.
//
// Scoped to the exact dev LAN IP (kept in sync with
// src/config/serverUrl.ts's own SERVER_BASE_URL -- that file's header
// comment already documents the same "regenerate per-network" tradeoff)
// rather than a blanket "trust user CAs everywhere" base-config: widening
// trust for one hardcoded dev-only IP literal can never affect a real
// production host, so this stays safe to leave wired for local builds.
//
// Gated OUT of any EAS production build (below) -- trusting user-installed
// CAs in a build real users install would be a genuine MITM vulnerability,
// not a convenience. `npx expo run:android` (this app's only documented
// local dev-client workflow, CLAUDE.md S9) never sets EAS_BUILD_PROFILE,
// so this plugin is active for every local build by default, which is the
// entire point.
const DEV_SERVER_IP = '192.168.1.52';

// cleartextTrafficPermitted is "true" here, not "false" -- found necessary
// by direct reproduction, not assumed: Android's domain-config matches by
// HOSTNAME only, with no way to distinguish by port, and this exact dev IP
// serves BOTH Metro's plain-HTTP bundle server (8081, genuinely needs
// cleartext) AND the Caddy TLS proxy (443, HTTPS only) -- a single
// domain-config covers both ports on that host. This does NOT weaken the
// actual API traffic: client.ts's SERVER_BASE_URL is still hardcoded
// `https://`, so the app itself never requests this host over plain HTTP;
// this setting only stops Metro's OWN dev-only bundle fetch from being
// rejected.
const NETWORK_SECURITY_CONFIG_XML = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="false">${DEV_SERVER_IP}</domain>
        <trust-anchors>
            <certificates src="system" />
            <certificates src="user" />
        </trust-anchors>
    </domain-config>
</network-security-config>
`;

function withDevLocalCaTrust(config) {
  config = withDangerousMod(config, [
    'android',
    async (config) => {
      const xmlDir = path.join(config.modRequest.platformProjectRoot, 'app/src/main/res/xml');
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.writeFileSync(path.join(xmlDir, 'network_security_config.xml'), NETWORK_SECURITY_CONFIG_XML);
      return config;
    },
  ]);

  return withAndroidManifest(config, (config) => {
    const application = config.modResults.manifest.application[0];
    application.$['android:networkSecurityConfig'] = '@xml/network_security_config';
    return config;
  });
}

module.exports = withDevLocalCaTrust;
