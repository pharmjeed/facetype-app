const path = require('node:path');

const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro for a pnpm workspace.
 *
 * Two things the default config gets wrong here:
 *
 *  - `watchFolders` must include shared package sources and the pnpm store,
 *    or Metro cannot follow workspace and dependency symlinks;
 *  - pnpm resolves dependencies through a symlinked store, so Metro must be
 *    told not to collapse those links or it resolves react-native twice and
 *    the bundle fails with duplicate-module errors.
 */
const { INLINED } = require('./babel/inlineBuildEnv.js');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..', '..');

// Metro keys its transform cache on file contents and config, never on the
// environment. `babel/inlineBuildEnv.js` bakes FACETYPE_API_URL into the
// bundle, so without folding the same values in here, pointing a build at a
// new backend would silently re-serve the previously cached bundle.
const inlinedEnv = INLINED.map((name) => `${name}=${process.env[name] ?? ''}`).join('|');

// Metro needs the shared packages and pnpm store, not the API, research data,
// web build, or native compiler outputs. In particular, do not index an APK's
// previously bundled JavaScript as application source.
const nativeOutputPattern = new RegExp(
  path.resolve(projectRoot).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
    '[/\\\\](?:android[/\\\\](?:build|app[/\\\\]build|\\.gradle|\\.cxx)|ios[/\\\\](?:build|Pods))([/\\\\]|$)',
);

module.exports = mergeConfig(getDefaultConfig(projectRoot), {
  projectRoot,
  watchFolders: [
    path.join(workspaceRoot, 'node_modules'),
    path.join(workspaceRoot, 'packages/contracts'),
    path.join(workspaceRoot, 'packages/design-system'),
  ],
  maxWorkers: 2,
  // Hash files actually requested by the bundle, not every file in the store.
  watcher: { unstable_lazySha1: true },
  cacheVersion: `facetype-${inlinedEnv}`,
  resolver: {
    blockList: [getDefaultConfig(projectRoot).resolver.blockList, nativeOutputPattern],
    unstable_enableSymlinks: true,
    nodeModulesPaths: [
      path.resolve(projectRoot, 'node_modules'),
      path.resolve(workspaceRoot, 'node_modules'),
    ],
  },
});
