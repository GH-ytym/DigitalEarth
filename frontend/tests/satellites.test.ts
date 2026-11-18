import assert from 'node:assert/strict';
import test from 'node:test';
import { isManifest, isSamples } from '../src/features/satellites/api.ts';

const manifest = {
  schema_version: 'satellites-1', result_id: '12345678-1234-1234-1234-123456789abc',
  epoch_utc: '2026-11-18T00:00:00Z', stop_utc: '2026-11-18T00:00:10Z',
  duration_s: 10, output_step_s: 10, position_frame: 'ECEF_APPROX', position_unit: 'm',
  window_kind: 'current-window',
  samples_url: '/api/v1/satellites/tracks/12345678-1234-1234-1234-123456789abc/samples',
  satellites: [{ satellite_id:'norad-25544', norad_id:25544, display_name:'ISS', object_name:'ISS',
    sample_count:2, period_s:5500, element_epoch_utc:'2026-11-17T20:00:00Z',
    fetched_at:'2026-11-18T00:00:00Z', source_url:'https://celestrak.org/NORAD/elements/gp.php' }],
};
const payload = { schema_version:'satellite-samples-1', result_id:manifest.result_id,
  satellites:[{satellite_id:'norad-25544',samples:[[0,7000000,0,0],[10,6999000,100000,0]]}] };

test('only matching Earth-fixed metre samples enter the scene', () => {
  assert.equal(isManifest(manifest), true);
  assert.ok(isManifest(manifest));
  assert.equal(isSamples(payload, manifest), true);
  assert.equal(isManifest({...manifest,position_frame:'TEME'}), false);
  assert.equal(isManifest({...manifest,position_unit:'km'}), false);
  assert.equal(isManifest({...manifest,samples_url:'https://other.example/samples'}), false);
  assert.equal(isSamples({...payload,result_id:'other'}, manifest), false);
});

test('missing satellites, invalid coordinates and incorrect times are rejected', () => {
  assert.ok(isManifest(manifest));
  assert.equal(isSamples({...payload,satellites:[]}, manifest), false);
  assert.equal(isSamples({...payload,satellites:[{satellite_id:'norad-25544',samples:[[0,NaN,0,0],[10,1,2,3]]}]}, manifest), false);
  assert.equal(isSamples({...payload,satellites:[{satellite_id:'norad-25544',samples:[[0,1,2,3],[5,1,2,3]]}]}, manifest), false);
});
