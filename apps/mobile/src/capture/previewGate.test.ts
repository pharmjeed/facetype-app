/** Auto-start gate contract, without React Native (audit M1-F3, R2). */

import assert from 'node:assert/strict';
import test from 'node:test';

import { isNativePreviewProvider, shouldAutoStartPreviewSequence } from './previewGate.ts';

test('both native geometry providers (ARCore, ARKit) have a real preview', () => {
  // Regression guard for the Android-only `Platform.OS === 'android' &&
  // provider?.kind === 'arcore'` check this replaced (audit F1/F2 iOS pass):
  // iOS's ARKit provider now has a real `FaceTypePreviewView` too and must
  // read as native exactly like ARCore does.
  assert.equal(isNativePreviewProvider('arcore'), true);
  assert.equal(isNativePreviewProvider('arkit'), true);
});

test('mediapipe, simulator and an unresolved provider have no native preview', () => {
  assert.equal(isNativePreviewProvider('mediapipe'), false);
  assert.equal(isNativePreviewProvider('simulator'), false);
  assert.equal(isNativePreviewProvider(undefined), false);
});

test('does nothing off the scan screen', () => {
  assert.equal(
    shouldAutoStartPreviewSequence({
      screen: 'consent',
      providerSelection: 'ready',
      usingNativePreview: false,
      alreadyStarted: false,
    }),
    false,
  );
});

test('waits for provider resolution instead of guessing non-native', () => {
  // This is the exact race in M1-F3: provider is still unresolved,
  // so usingNativePreview reads false today even though the provider might
  // resolve to ARCore a moment later. The gate must not auto-start here —
  // doing so marks the sequence started before the eventual native view
  // mounts, so its onPreviewReady event is then ignored forever.
  assert.equal(
    shouldAutoStartPreviewSequence({
      screen: 'scan',
      providerSelection: 'pending',
      usingNativePreview: false,
      alreadyStarted: false,
    }),
    false,
  );
});

test('once provider resolves to ARCore, waits for the native onPreviewReady event instead', () => {
  assert.equal(
    shouldAutoStartPreviewSequence({
      screen: 'scan',
      providerSelection: 'ready',
      usingNativePreview: true,
      alreadyStarted: false,
    }),
    false,
  );
});

test('auto-starts once provider resolves to a non-native provider', () => {
  assert.equal(
    shouldAutoStartPreviewSequence({
      screen: 'scan',
      providerSelection: 'ready',
      usingNativePreview: false,
      alreadyStarted: false,
    }),
    true,
  );
});

test('never restarts an already-started sequence', () => {
  assert.equal(
    shouldAutoStartPreviewSequence({
      screen: 'scan',
      providerSelection: 'ready',
      usingNativePreview: false,
      alreadyStarted: true,
    }),
    false,
  );
});

test('an unsupported device (selection resolved to null) never auto-starts — no native preview is coming', () => {
  // R2: selectProvider legitimately returning null (no supported provider
  // for this device) used to be indistinguishable from "still resolving".
  // The gate must fail closed here, not wait forever.
  assert.equal(
    shouldAutoStartPreviewSequence({
      screen: 'scan',
      providerSelection: 'unavailable',
      usingNativePreview: false,
      alreadyStarted: false,
    }),
    false,
  );
});

test('a rejected selection promise never auto-starts', () => {
  assert.equal(
    shouldAutoStartPreviewSequence({
      screen: 'scan',
      providerSelection: 'failed',
      usingNativePreview: false,
      alreadyStarted: false,
    }),
    false,
  );
});
