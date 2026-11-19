export const earthRadius = 6378137;

/** Fit an Earth-centred orbital envelope in both dimensions, with room around its limb. */
export function orbitViewDistance(radius: number, verticalFov: number, aspectRatio: number) {
  const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * aspectRatio);
  return 1.2 * Math.max(earthRadius, radius) / Math.sin(Math.min(verticalFov, horizontalFov) / 2);
}

export function orbitFollowRange(maxRadius: number, minRadius: number, verticalFov: number, aspectRatio: number) {
  // Keep the approved low-orbit Earth view, then scale up for larger orbits.
  if (maxRadius <= earthRadius + 2_000_000) return 16_000_000;
  return Math.max(16_000_000, orbitViewDistance(maxRadius, verticalFov, aspectRatio) - minRadius);
}
