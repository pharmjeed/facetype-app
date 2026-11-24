import assert from 'node:assert/strict';
import test from 'node:test';

import type { FaceTypeClient } from '@facetype/contracts';

import { ConsentGatedAnalytics } from './tracking.ts';

function fakeApi() {
  const events: unknown[] = [];
  const consents: boolean[] = [];
  const api = {
    async recordTrackingConsent(body: { granted: boolean }) {
      consents.push(body.granted);
      return { ...body, policy_version: 'analytics-1.0.0', captured_at: new Date().toISOString() };
    },
    async ingestProductEvent(body: unknown) {
      events.push(body);
      return body;
    },
  } as unknown as FaceTypeClient;
  return { api, events, consents };
}

test('no analytics request is created before explicit consent', async () => {
  const { api, events } = fakeApi();
  const analytics = new ConsentGatedAnalytics(api);
  assert.equal(await analytics.trackEvent('scan_started', { platform: 'ios' }), false);
  assert.deepEqual(events, []);
});

test('revocation closes the client gate before awaiting the server', async () => {
  const { api, events, consents } = fakeApi();
  const analytics = new ConsentGatedAnalytics(api);
  await analytics.setConsent(true);
  assert.equal(await analytics.trackEvent('scan_started', { platform: 'android' }), true);
  await analytics.setConsent(false);
  assert.equal(await analytics.trackEvent('result_viewed'), false);
  assert.deepEqual(consents, [true, false]);
  assert.equal(events.length, 1);
});

test('the client rejects biometric and identity properties', async () => {
  const { api, events } = fakeApi();
  const analytics = new ConsentGatedAnalytics(api);
  await analytics.setConsent(true);
  await assert.rejects(
    () => analytics.trackEvent('pose_accepted', { embedding: 'forbidden' }),
    /Forbidden analytics property/,
  );
  await assert.rejects(
    () => analytics.trackEvent('scan_terminal', { principal_id: 'forbidden' }),
    /Forbidden analytics property/,
  );
  assert.deepEqual(events, []);
});
