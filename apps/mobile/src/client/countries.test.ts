import assert from 'node:assert/strict';
import { test } from 'node:test';

import { COUNTRIES, filterCountries, searchCountries } from './countries.ts';

test('an empty search gives the wheel every country, in the same order', () => {
  const all = filterCountries('');
  assert.equal(all.length, COUNTRIES.length);
  assert.deepEqual(
    all.map((c) => c.code),
    COUNTRIES.map((c) => c.code),
  );
  assert.equal(filterCountries('   ').length, COUNTRIES.length);
});

test('a search narrows the wheel without the 8-result limit of the old chips', () => {
  const g = filterCountries('غ');
  assert.ok(g.length > 8);
  assert.ok(g.every((c) => c.name.includes('غ') || c.code === 'G'));
  assert.equal(searchCountries('غ').length, 8);
});

test('an exact ISO code comes first, and letter variants still match', () => {
  assert.equal(filterCountries('sa')[0]?.code, 'SA');
  assert.ok(filterCountries('الامارات').some((c) => c.code === 'AE'));
});
