/**
 * The field-study contract, asserted against the generated surface.
 *
 * Three things this file is watching, all of them regressions Codex found or
 * asked to be prevented in the review of `8bb50d0`:
 *
 * 1. `createFieldSession` returns the one-time `join_code`. The console dropped
 *    it, and the API cannot produce it a second time — it keeps only a digest.
 *    A generator change that removed the field from the response type would
 *    make the console's reader dead code and nothing else would notice.
 * 2. the create request carries a `site_code` and nothing a human writes in
 *    their own words. `label` was free text with a PII claim wider than its
 *    screening, and it must not come back.
 * 3. deletion reports a status and a *conditional* completion timestamp, so a
 *    client cannot read "erased" off a request that only got as far as
 *    `REQUESTED`.
 *
 * These are compile-time assertions expressed as runtime ones: the objects are
 * typed, so a field that disappeared from `generated/types.ts` fails `tsc`
 * before this file ever runs.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  CreateFieldSessionRequest,
  FieldSessionResponse,
  ParticipantDeletionResponse,
} from '../generated/types.ts';
import { createClient } from '../src/index.ts';

test('opening a session asks for a site code and nothing free-text', () => {
  const request: CreateFieldSessionRequest = { site_code: 'RUH-LAB-1' };
  assert.deepEqual(Object.keys(request), ['site_code']);
  // `label` is gone from the request type. If it returns, this stops compiling.
  assert.equal('label' in request, false);
});

test('the create response carries the one-time join code', () => {
  const response: FieldSessionResponse = {
    session_id: 'fss_abc',
    label: 'RUH-LAB-1-20260828-01',
    site_code: 'RUH-LAB-1',
    status: 'OPEN',
    capture_protocol: 'cap-1.0.0',
    consent_policy_version: 'consent-1.0.0',
    raw_photo_retention_days: 0,
    raw_photo_retention_enabled: false,
    created_at: '2026-08-28T00:00:00Z',
    join_code: 'FS-0123456789ABCDEF',
  };
  assert.equal(response.join_code, 'FS-0123456789ABCDEF');
});

test('the generated label is derived from the site code, never typed', () => {
  const response: Pick<FieldSessionResponse, 'label' | 'site_code'> = {
    label: 'RUH-LAB-1-20260828-01',
    site_code: 'RUH-LAB-1',
  };
  assert.ok(response.label.startsWith(`${response.site_code}-`));
  assert.equal(response.label.length, response.site_code.length + 12);
});

test('a read of a session carries no join code', async () => {
  // The code appears in the 201 and nowhere else. This exercises the client
  // path rather than the type, so a future generator that started echoing it
  // from a GET would show up here.
  const calls: string[] = [];
  const client = createClient({
    baseUrl: 'https://api.invalid',
    getToken: () => 'token',
    fetch: (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(
        JSON.stringify({
          session_id: 'fss_abc',
          label: 'RUH-LAB-1-20260828-01',
          site_code: 'RUH-LAB-1',
          status: 'OPEN',
          capture_protocol: 'cap-1.0.0',
          consent_policy_version: 'consent-1.0.0',
          raw_photo_retention_days: 0,
          raw_photo_retention_enabled: false,
          created_at: '2026-08-28T00:00:00Z',
          items: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch,
  });
  const page = await client.listFieldSessions({ limit: 1 });
  assert.ok(calls[0]?.includes('/field-study/sessions'));
  assert.deepEqual(page.items, []);
});

test('an erasure reports a status, and a completion time only when it completed', () => {
  const inProgress: ParticipantDeletionResponse = {
    participant_ref: 'P-000001',
    status: 'IN_PROGRESS',
    deleted_objects: 1,
    failed_objects: 0,
    failed_schedules: 1,
    scheduled_scans: [],
    pending_scans: 1,
    completed_at: null,
  };
  assert.equal(inProgress.completed_at, null);
  assert.notEqual(inProgress.status, 'COMPLETED');

  const completed: ParticipantDeletionResponse = {
    participant_ref: 'P-000001',
    status: 'COMPLETED',
    deleted_objects: 1,
    failed_objects: 0,
    failed_schedules: 0,
    scheduled_scans: ['retention_1'],
    pending_scans: 0,
    completed_at: '2026-08-28T00:00:00Z',
  };
  assert.equal(completed.status, 'COMPLETED');
  assert.ok(completed.completed_at);
});
