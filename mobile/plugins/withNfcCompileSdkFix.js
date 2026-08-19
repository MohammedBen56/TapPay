const { withProjectBuildGradle } = require('expo/config-plugins');

// react-native-nfc-manager's android/build.gradle reads
// `rootProject.ext.get("compileSdk", 34)` -- note the key is "compileSdk",
// NOT the standard "compileSdkVersion" Expo's own root build.gradle uses
// (and doesn't define as a raw `ext` property at all under the modern
// "expo-root-project" plugin, so the library always falls through to its
// own hardcoded default of 34). Platform 34 was unreliable to install in
// this dev environment (network rate-limiting on the ~63MB archive), while
// Platform 35 was already fully installed (CLAUDE.md S6's target). Rather
// than depend on ever successfully fetching 34, define the exact ext key
// this one library looks for so it compiles against 35 instead -- additive,
// doesn't touch how anything else in the project resolves its SDK version.
function withNfcCompileSdkFix(config) {
  return withProjectBuildGradle(config, (config) => {
    if (config.modResults.language !== 'groovy') {
      throw new Error('withNfcCompileSdkFix expected a Groovy root build.gradle');
    }
    const marker = 'ext.compileSdk = 35 // withNfcCompileSdkFix';
    if (!config.modResults.contents.includes(marker)) {
      config.modResults.contents = config.modResults.contents.replace(
        'apply plugin: "expo-root-project"',
        `apply plugin: "expo-root-project"\n\n${marker}`
      );
    }
    return config;
  });
}

module.exports = withNfcCompileSdkFix;
