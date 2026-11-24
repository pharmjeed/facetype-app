import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const config = require('../metro.config.js');
const mobile = path.dirname(require.resolve('../metro.config.js'));

test('Metro sees shared sources and the pnpm store, not the entire repository', () => {
  const root = path.resolve(mobile, '../..');
  for (const folder of ['node_modules', 'packages/contracts', 'packages/design-system']) {
    assert.ok(config.watchFolders.includes(path.join(root, folder)));
  }
  assert.ok(!config.watchFolders.includes(root));
  assert.equal(config.watcher.unstable_lazySha1, true);
});

test('Metro excludes native compiler outputs but not source or dependency build folders', () => {
  const blocked = (file: string) => config.resolver.blockList.some((rule: RegExp) => rule.test(file));
  for (const file of ['android/app/build', 'android/build/generated/file.js', 'android/.gradle/cache', 'ios/Pods/foo', 'ios/build']) {
    assert.equal(blocked(path.join(mobile, file)), true, file);
  }
  for (const file of ['src/field/FieldStudyApp.tsx', 'android/app/src/main/AndroidManifest.xml', 'node_modules/library/build/index.js']) {
    assert.equal(blocked(path.join(mobile, file)), false, file);
  }
});
