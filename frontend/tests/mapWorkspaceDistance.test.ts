import assert from 'node:assert/strict';
import test from 'node:test';
import { formatDistance, geodesicMidpoint, geodesicPath, measureDistance } from '../src/features/mapWorkspace/distance.ts';

test('the regional city route previews the PostGIS segment lengths and total', () => {
  const vertices = [
    { longitude: 116.39723, latitude: 39.9075 },
    { longitude: 116.99722, latitude: 36.66833 },
    { longitude: 117.28083, latitude: 31.86389 },
    { longitude: 121.45806, latitude: 31.22222 },
  ];
  const { segment_meters, total_meters } = measureDistance(vertices);
  assert.deepEqual(segment_meters.map(formatDistance), ['363.36 km', '533.58 km', '402.97 km']);
  assert.equal(formatDistance(total_meters), '1,299.91 km');
  assert.equal(total_meters, segment_meters.reduce((sum, segment) => sum + segment, 0));
});

test('distance and drawing use the same geodesic across the antimeridian and near antipodes', () => {
  const start = { longitude: 179.5, latitude: 0 };
  const across = { longitude: -179.5, latitude: 0 };
  const midpoint = geodesicMidpoint(start, across);
  assert.ok(Math.abs(Math.abs(midpoint.longitude) - 180) < 1e-10);
  assert.ok(Math.abs(measureDistance([start, across]).total_meters - 111319.490793) < 0.01);

  const nearAntipode = { longitude: -0.500001, latitude: 0.01 };
  const path = geodesicPath(start, nearAntipode);
  assert.deepEqual(path[0], start);
  assert.deepEqual(path.at(-1), nearAntipode);
  const sampled = measureDistance(path);
  assert.ok(sampled.segment_meters.every((segment) => segment > 0 && segment <= 100_000));
  assert.ok(Math.abs(sampled.total_meters - measureDistance([start, nearAntipode]).total_meters) < 0.01);
});
