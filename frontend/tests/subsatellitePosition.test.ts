import assert from 'node:assert/strict';
import test from 'node:test';
import { Cartesian3, Cartographic, JulianDate, Math as CesiumMath, SampledPositionProperty } from 'cesium';
import { subsatellitePosition } from '../src/features/satellites/subsatellitePosition.ts';

test('subsatellite point uses ellipsoid normal and follows the requested playback time', () => {
  const start = JulianDate.fromIso8601('2026-11-18T00:00:00Z');
  const end = JulianDate.addSeconds(start, 10, new JulianDate());
  const position = new SampledPositionProperty();
  position.addSample(start, Cartesian3.fromDegrees(110, 45, 600000));
  position.addSample(end, Cartesian3.fromDegrees(111, 46, 610000));
  const ground = subsatellitePosition(position);
  for (const time of [start, JulianDate.addSeconds(start, 5, new JulianDate()), end]) {
    const satellite = Cartographic.fromCartesian(position.getValue(time)!);
    const point = Cartographic.fromCartesian(ground.getValue(time)!);
    assert.ok(Math.abs(point.height) < 1e-4);
    assert.ok(Math.abs(point.longitude - satellite.longitude) < 1e-12);
    assert.ok(Math.abs(point.latitude - satellite.latitude) < 1e-12);
  }
  assert.ok(Math.abs(CesiumMath.toDegrees(Cartographic.fromCartesian(ground.getValue(start)!).latitude) - 45) < 1e-9);
  assert.ok(Cartesian3.distance(ground.getValue(start)!, ground.getValue(end)!) > 100000);
  // Seeking backwards and leaving the sampled interval must not leave a stale marker.
  assert.ok(Cartesian3.distance(ground.getValue(start)!, Cartesian3.fromDegrees(110, 45)) < 1e-4);
  assert.equal(ground.getValue(JulianDate.addSeconds(start, -1, new JulianDate())), undefined);
});
