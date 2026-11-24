/** Executable checks for dependencies that Metro loads from the installed graph. */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const requireFromMobile = createRequire(import.meta.url);

test('@babel/runtime exposes the exact helper emitted into the device bundle', () => {
  assert.doesNotThrow(
    () => requireFromMobile.resolve('@babel/runtime/helpers/interopRequireDefault'),
    'the helper Metro needs must resolve from the mobile workspace after pnpm install',
  );
});
