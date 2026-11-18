import assert from 'node:assert/strict';
import test from 'node:test';
import {
  defaultProvinceSettings, loadProvinceSettings, normalizeProvinceSettings,
  provinceSettingsKey, saveProvinceSettings,
} from '../src/features/layers/provinceSettings.ts';

test('valid settings survive a save/load including zero opacity and disabled visibility', () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
  const settings = { enabled: false, opacity: 0, lineColor: '#00ddeb', lineWidth: 1.5 };
  assert.equal(saveProvinceSettings('layer', settings, storage), true);
  assert.deepEqual(loadProvinceSettings('layer', storage), { ...settings, lineColor: '#00DDEB' });
});

test('missing, malformed, or blocked storage falls back without preventing rendering', () => {
  for (const value of [null, '{broken', 'null', '[]', '"text"']) {
    assert.deepEqual(loadProvinceSettings('layer', { getItem: () => value }), defaultProvinceSettings);
  }
  assert.deepEqual(loadProvinceSettings('layer', { getItem: () => { throw new Error('blocked'); } }), defaultProvinceSettings);
  assert.equal(saveProvinceSettings('layer', { ...defaultProvinceSettings }, { setItem: () => { throw new Error('quota'); } }), false);
});

test('stored values are validated before becoming style request parameters', () => {
  assert.deepEqual(normalizeProvinceSettings({ enabled: 'false', opacity: Infinity, lineColor: '#fff;lineWidth:99', lineWidth: 99 }), defaultProvinceSettings);
  assert.equal(normalizeProvinceSettings({ opacity: -1 }).opacity, 0);
  assert.equal(normalizeProvinceSettings({ opacity: 2 }).opacity, 1);
  assert.equal(normalizeProvinceSettings({ lineWidth: 1.2 }).lineWidth, 1);
});

test('settings keys separate service URLs and published layer names', () => {
  assert.notEqual(provinceSettingsKey('/a/wms', 'China:province'), provinceSettingsKey('/b/wms', 'China:province'));
  assert.notEqual(provinceSettingsKey('/a/wms', 'China:province'), provinceSettingsKey('/a/wms', 'China:roads'));
});
