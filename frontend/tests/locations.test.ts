import assert from 'node:assert/strict';
import test from 'node:test';
import { placeCameraHeight, placeHierarchy, placeKindLabel, type PlaceResult } from '../src/features/locations/types.ts';
import { searchPlaces } from '../src/features/locations/search.ts';

const place: PlaceResult = {
  geoname_id: 123, name: 'Sample district', canonical_name: 'Sample district', kind: 'admin2',
  country_code: 'CN', country_name: 'China', admin1_code: '04', admin1_name: 'Jiangsu',
  feature_code: 'ADM2', longitude: 118, latitude: 32, approximate_representative_point: true,
};

test('all added administrative levels have labels, hierarchy and finite camera heights', () => {
  for (const [kind, label] of [['admin2', '二级行政区'], ['admin3', '三级行政区'], ['admin4', '四级行政区'], ['admin5', '五级行政区']] as const) {
    const result = { ...place, kind };
    assert.equal(placeKindLabel(result), label);
    assert.equal(placeHierarchy(result), 'Sample district · Jiangsu · China');
    assert.ok(Number.isFinite(placeCameraHeight(result)) && placeCameraHeight(result) > 0);
  }
});

test('search accepts added kinds and still rejects unknown kinds', async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis });
  try {
    for (const kind of ['admin2', 'admin3', 'admin4', 'admin5', 'unknown']) {
      globalThis.fetch = async () => new Response(JSON.stringify({ results: [{ ...place, kind }] }));
      if (kind === 'unknown') {
        await assert.rejects(searchPlaces('district', new AbortController().signal), /格式异常/);
      } else {
        assert.equal((await searchPlaces('district', new AbortController().signal))[0].kind, kind);
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
