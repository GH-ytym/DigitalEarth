import assert from 'node:assert/strict';
import test from 'node:test';
import { earthRadius, orbitFollowRange, orbitViewDistance } from '../src/features/satellites/orbitView.ts';

test('overview fits an entire orbital envelope even in wide and narrow viewports', () => {
  for (const radius of [7_000_000, 30_000_000, 42_200_000]) {
    for (const aspect of [.65, 1.6, 2.5, 3.5]) {
      const vertical = Math.PI / 4;
      const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * aspect);
      const distance = orbitViewDistance(radius, vertical, aspect);
      assert.ok(Math.asin(radius / distance) < Math.min(vertical, horizontal) / 2);
    }
  }
  assert.ok(orbitViewDistance(42_200_000, Math.PI / 6, 2.5) > 100_000_000);
});

test('following retains the low-orbit view and scales up with orbital size', () => {
  assert.equal(orbitFollowRange(earthRadius + 850_000, earthRadius + 400_000, Math.PI / 4, 1.6), 16_000_000);
  const medium = orbitFollowRange(30_000_000, 26_000_000, Math.PI / 4, 1.6);
  const high = orbitFollowRange(42_200_000, 42_000_000, Math.PI / 4, 1.6);
  assert.ok(medium > 40_000_000);
  assert.ok(high > medium);
  assert.ok(26_000_000 + medium >= orbitViewDistance(30_000_000, Math.PI / 4, 1.6));
});
