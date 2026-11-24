import assert from 'node:assert/strict';
import test from 'node:test';

import { CaptureError } from './captureError.ts';
import { requireNativeCaptureModule } from './nativeModule.ts';

test('a missing native capture module fails closed', () => {
  // Asserted on the carried code, not on the message: the code is the
  // contract, the message is user-facing prose that gets translated.
  assert.throws(
    () => requireNativeCaptureModule(undefined),
    (error: unknown) => error instanceof CaptureError && error.code === 'FT-REC-005',
  );
});

test('an installed native capture module is returned unchanged', () => {
  const module = { start: async () => undefined };
  assert.equal(requireNativeCaptureModule(module), module);
});
