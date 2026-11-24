/**
 * The participant reference is recognised, never minted, and never repaired.
 *
 * This suite used to cover an operator typing a reference in and a device
 * proposing the next one. Both are gone — the server allocates references now —
 * so what is left to prove is the guard that the rest of the lane stands on:
 * the only string this app will treat as a participant reference is `P-` plus
 * six ASCII digits, and every directly-identifying thing a human might have
 * typed, or a response might have carried, fails it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { isParticipantRef, PARTICIPANT_REF_PATTERN } from './participantRef.ts';

test('the allocated shape is accepted, and only that shape', () => {
  assert.equal(isParticipantRef('P-000001'), true);
  assert.equal(isParticipantRef('P-999999'), true);
  assert.equal(isParticipantRef('P-000000'), true);
});

test('a direct identifier is not a participant reference, in any script', () => {
  for (const identifier of [
    'Ali Hassan',
    'علي حسن',
    'ali.hassan@example.com',
    '+966 50 123 4567',
    '0501234567',
    'the tall guy from the second session',
    'P-000001 (Ali)',
    'Ali',
  ]) {
    assert.equal(isParticipantRef(identifier), false, identifier);
  }
});

test('a near miss is a miss — nothing is trimmed, padded or upper-cased into validity', () => {
  for (const near of [
    'p-000001',
    ' P-000001',
    'P-000001 ',
    'P-00001',
    'P-0000001',
    'P000001',
    'P-00000a',
    'P-٠٠٠٠٠١', // Arabic-Indic digits are not ASCII digits.
    '',
  ]) {
    assert.equal(isParticipantRef(near), false, JSON.stringify(near));
  }
});

test('a non-string is refused rather than coerced', () => {
  for (const value of [null, undefined, 1, {}, [], true, Symbol('P-000001')]) {
    assert.equal(isParticipantRef(value), false, String(value));
  }
});

test('the pattern is anchored at both ends', () => {
  // An unanchored pattern would accept `Ali P-000001 0501234567`, which is the
  // exact string an operator with a paper list would paste.
  assert.equal(PARTICIPANT_REF_PATTERN.test('Ali P-000001 0501234567'), false);
  assert.match('P-000123', PARTICIPANT_REF_PATTERN);
});

test('this module cannot mint a reference at all', async () => {
  // The device-side allocator is the defect that let two handsets in one room
  // both hand out P-000001, and the strongest statement that it is gone is that
  // there is no export that produces a reference from a number.
  const module: Record<string, unknown> = await import('./participantRef.ts');
  assert.deepEqual(Object.keys(module).sort(), ['PARTICIPANT_REF_PATTERN', 'isParticipantRef']);
});
