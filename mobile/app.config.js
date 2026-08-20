// Converted from a static app.json (Ship List v2) specifically so the BLE
// permissions plugin can be conditional -- app.json has no way to express
// that. Mirrors the server's ENABLE_PROXIMITY_ROUTES flag/default
// (server/src/config.ts) exactly: default false, so a live build never
// declares BLUETOOTH_SCAN/ADVERTISE/CONNECT, permissions the shipping app
// structurally never uses (a real Play Store review flag, and a bad look
// under a security-conscious bank evaluator's manifest inspection). Set
// ENABLE_PROXIMITY_ROUTES=true only when actually reviving the parked BLE
// work (CLAUDE.md's "Rule for reviving parked work").
const ENABLE_PROXIMITY_FEATURES = process.env.ENABLE_PROXIMITY_ROUTES === "true";

module.exports = {
  expo: {
    name: "mobile",
    slug: "mobile",
    version: "1.0.0",
    orientation: "portrait",
    icon: "./assets/icon.png",
    userInterfaceStyle: "dark",
    scheme: "tappay",
    newArchEnabled: true,
    ios: {
      supportsTablet: true,
    },
    android: {
      package: "com.tappay.mobile",
      adaptiveIcon: {
        backgroundColor: "#E6F4FE",
        foregroundImage: "./assets/android-icon-foreground.png",
        backgroundImage: "./assets/android-icon-background.png",
        monochromeImage: "./assets/android-icon-monochrome.png",
      },
      predictiveBackGestureEnabled: false,
      softwareKeyboardLayoutMode: "resize",
    },
    web: {
      favicon: "./assets/favicon.png",
    },
    plugins: [
      ...(ENABLE_PROXIMITY_FEATURES ? ["./plugins/withBlePermissions.js"] : []),
      "./plugins/withNfcCompileSdkFix.js",
      "expo-camera",
      "expo-router",
      "expo-secure-store",
      "expo-font",
      "expo-splash-screen",
      [
        "expo-image-picker",
        {
          photosPermission: "TapPay needs access to your photos to import a QR code image.",
        },
      ],
      [
        "expo-local-authentication",
        {
          faceIDPermission: "TapPay uses Face ID to sign you in without your password.",
        },
      ],
      "react-native-nfc-manager",
      // Ship List v2 Wave 2 Phase 2: Android App Shortcuts (long-press the
      // launcher icon -> "Send money" / "Pay a bill"). Reuses the existing
      // adaptive-icon assets/background color rather than new bespoke
      // per-shortcut art -- a real, working default; a distinct icon per
      // shortcut is a cheap follow-up once real icon assets exist, not
      // done here. NOTE: this package's own README only lists verified
      // compatibility through Expo SDK 54 (this app is on 57) -- `npx
      // expo install` raised no incompatibility warning and the API
      // surface is small/stable, but treat this as unverified until a
      // real native rebuild + device test confirms it, same as every
      // other mobile change in this engagement without a device run.
      [
        "expo-quick-actions",
        {
          androidIcons: {
            send_money: {
              foregroundImage: "./assets/android-icon-foreground.png",
              backgroundColor: "#E6F4FE",
            },
            pay_bills: {
              foregroundImage: "./assets/android-icon-foreground.png",
              backgroundColor: "#E6F4FE",
            },
          },
        },
      ],
    ],
  },
};
