import { CallbackPositionProperty, Cartesian3, Ellipsoid, ReferenceFrame } from 'cesium';
import type { PositionProperty } from 'cesium';

/** Project the interpolated position along the WGS84 ellipsoid normal at playback time. */
export function subsatellitePosition(position: PositionProperty) {
  const scratch = new Cartesian3();
  return new CallbackPositionProperty((time, result) => {
    const satellite = position.getValue(time, scratch);
    return satellite ? Ellipsoid.WGS84.scaleToGeodeticSurface(satellite, result) : undefined;
  }, false, ReferenceFrame.FIXED);
}
