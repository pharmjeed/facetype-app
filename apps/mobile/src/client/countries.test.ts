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

test('English names and search follow the interface language', async () => {
  const { setLang } = await import('./i18n.ts');
  const { countries, countryName } = await import('./countries.ts');
  setLang('en');
  try {
    assert.equal(countryName('SA'), 'Saudi Arabia');
    assert.ok((countries()[0]?.name ?? '').localeCompare(countries()[1]?.name ?? '', 'en') <= 0);
    assert.ok(filterCountries('egy').some((c) => c.code === 'EG'));
    assert.ok(filterCountries('aland').some((c) => c.code === 'AX'));
    assert.equal(filterCountries('').length, countries().length);
  } finally {
    setLang('ar');
  }
  assert.equal(countryName('SA'), 'السعودية');
});
