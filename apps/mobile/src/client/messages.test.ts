/** Every native reject reason and common verdict reason has one short Arabic sentence. */

import assert from 'node:assert/strict';
import test from 'node:test';

import { CODE_KINDS } from './api/clientApi.ts';
import { apiErrorKey, profileFieldErrorKey, REJECT_REASONS, rejectReasonKey, verdictReasonKey } from './messages.ts';
import { S } from './strings.ts';

test('every topRejectReason in the native contract maps to a message', () => {
  for (const reason of REJECT_REASONS) {
    const key = rejectReasonKey(reason, 'hold_still');
    assert.ok(key, reason);
    assert.match(S[key], /[\u0600-\u06ff]/, reason);
  }
  assert.equal(rejectReasonKey(null, 'hold_still'), null);
  assert.equal(rejectReasonKey('something_new', 'hold_still'), null);
});

test('size/distance rejections keep the direction guidance already shows', () => {
  assert.equal(rejectReasonKey('distanceOrSize', 'move_back'), 'guide.move_back');
  assert.equal(rejectReasonKey('distanceOrSize', 'hold_still'), 'guide.move_closer');
  assert.equal(rejectReasonKey('expression', 'hold_still'), 'guide.no_smile');
});

test('server verdict reasons become specific retake sentences, unknown ones a generic one', () => {
  assert.equal(verdictReasonKey('glasses_detected'), 'reason.glasses');
  assert.equal(verdictReasonKey('face_occluded'), 'reason.face_covered');
  assert.equal(verdictReasonKey('second_face'), 'reason.second_face');
  assert.equal(verdictReasonKey('too_few_frames'), 'reason.too_few_frames');
  assert.equal(verdictReasonKey('blur'), 'reason.quality');
  assert.equal(verdictReasonKey('upload_integrity'), 'reason.upload_integrity');
  assert.equal(verdictReasonKey('xyz'), 'reason.generic');
});

test('every FT code the client lane maps to a kind also has one Arabic sentence', () => {
  for (const code of Object.keys(CODE_KINDS)) {
    const key = apiErrorKey(code);
    assert.ok(key, code);
    assert.match(S[key], /[؀-ۿ]/, code);
  }
  assert.equal(apiErrorKey('upload_rejected_403'), null, 'local codes keep the generic line with the code');
  assert.equal(apiErrorKey(null, 'network'), 'common.network');
});

test('server profile field reasons show the local Arabic sentence, never server text', () => {
  assert.equal(profileFieldErrorKey('phone', 'e164'), 'err.phone');
  assert.equal(profileFieldErrorKey('birth_date', 'under_18'), 'err.underage');
  assert.equal(profileFieldErrorKey('birth_date', 'future'), 'err.birth_date');
  assert.equal(profileFieldErrorKey('id_number', 'checksum'), 'err.id_checksum');
  assert.equal(profileFieldErrorKey('id_number', 'format'), 'err.id_generic');
  assert.equal(profileFieldErrorKey('unknown_field', 'x'), null);
});
