// @ts-check
const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..');

const config = getDefaultConfig(projectRoot);

// packages/shared lives outside mobile/ -- Metro only watches/resolves within
// the project root by default, so pnpm's workspace symlink to it would
// otherwise silently fail to bundle.
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
// pnpm's node_modules are symlinks; Metro's resolver doesn't follow them by
// default.
config.resolver.unstable_enableSymlinks = true;

// packages/shared's internal imports use the `./foo.js` extension on `.ts`
// source files -- required for Node/tsx's ESM resolution under "type":
// "module" (verified working throughout the server side of M1), but Metro's
// resolver looks for a literal types.js file and won't find one, since only
// types.ts exists. Fall back to the .ts source when a relative .js import
// can't be found as-is.
const { resolveRequest: defaultResolveRequest } = config.resolver;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith('.') && moduleName.endsWith('.js')) {
    try {
      return (defaultResolveRequest ?? context.resolveRequest)(context, moduleName, platform);
    } catch {
      const tsModuleName = moduleName.replace(/\.js$/, '.ts');
      return (defaultResolveRequest ?? context.resolveRequest)(context, tsModuleName, platform);
    }
  }
  return (defaultResolveRequest ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = withNativeWind(config, { input: './global.css' });
