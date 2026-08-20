const { withAndroidManifest } = require('expo/config-plugins');

// BLUETOOTH_SCAN needs the neverForLocation flag (Android 12+, CLAUDE.md S6) which a
// simple `android.permissions` list can't express -- it only emits a bare
// <uses-permission>, no attributes. So all three BLE permissions go through this
// manifest-editing plugin instead, to keep them in one place. Only included at all
// when ENABLE_PROXIMITY_ROUTES=true (app.config.js) -- a live build never declares
// permissions the shipping app structurally never uses.
const BLE_PERMISSIONS = [
  { name: 'android.permission.BLUETOOTH_SCAN', usesPermissionFlags: 'neverForLocation' },
  { name: 'android.permission.BLUETOOTH_ADVERTISE' },
  { name: 'android.permission.BLUETOOTH_CONNECT' },
];

function withBlePermissions(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    if (!manifest['uses-permission']) {
      manifest['uses-permission'] = [];
    }

    for (const permission of BLE_PERMISSIONS) {
      const alreadyPresent = manifest['uses-permission'].some(
        (entry) => entry.$ && entry.$['android:name'] === permission.name
      );
      if (alreadyPresent) continue;

      const attributes = { 'android:name': permission.name };
      if (permission.usesPermissionFlags) {
        attributes['android:usesPermissionFlags'] = permission.usesPermissionFlags;
      }
      manifest['uses-permission'].push({ $: attributes });
    }

    return config;
  });
}

module.exports = withBlePermissions;
