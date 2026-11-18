import {
  ArcType, Cartesian2, Cartesian3, Cartographic, ClockRange, ClockStep, Color, CustomDataSource,
  HeightReference, JulianDate, LabelStyle, LinearApproximation, Math as CesiumMath, ReferenceFrame,
  SampledPositionProperty, TimeInterval, TimeIntervalCollection, VelocityOrientationProperty,
} from 'cesium';
import type { Entity, Viewer } from 'cesium';
import type { SatelliteManifest, SatellitePlaybackState, SatelliteSamples } from './types';
import { subsatellitePosition } from './subsatellitePosition';

const colors = ['#80D9FA', '#FFBD7B', '#C5B1FF'];

/** Uses the workspace's existing Viewer; owns only satellite entities and their clock listener. */
export class SatellitePlayback {
  private source = new CustomDataSource('public-satellites');
  private entities: Entity[] = [];
  private manifest: SatelliteManifest | null = null;
  private epoch = new JulianDate();
  private lastUpdate = 0;
  private following: string | null = null;
  private removeTick: () => void;
  private disposed = false;

  constructor(private viewer: Viewer, private onChange: (state: SatellitePlaybackState | null) => void) {
    void viewer.dataSources.add(this.source).then(source => {
      if (this.disposed && !viewer.isDestroyed()) viewer.dataSources.remove(source, true);
    });
    this.removeTick = viewer.clock.onTick.addEventListener(() => this.tick());
  }

  load(manifest: SatelliteManifest, samples: SatelliteSamples) {
    this.clear(false);
    this.manifest = manifest;
    this.epoch = JulianDate.fromIso8601(manifest.epoch_utc);
    samples.satellites.forEach((track, index) => {
      const spec = manifest.satellites.find(sat => sat.satellite_id === track.satellite_id)!;
      const color = Color.fromCssColorString(colors[index]);
      const position = new SampledPositionProperty(ReferenceFrame.FIXED);
      position.addSamplesPackedArray(track.samples.flat(), this.epoch);
      position.setInterpolationOptions({ interpolationAlgorithm: LinearApproximation, interpolationDegree: 1 });
      const availability = new TimeIntervalCollection([new TimeInterval({
        start: this.epoch, stop: JulianDate.fromIso8601(manifest.stop_utc),
      })]);
      this.source.entities.add({ id: `${track.satellite_id}-orbit`, polyline: {
        positions: track.samples.map(([, x, y, z]) => new Cartesian3(x, y, z)),
        arcType: ArcType.NONE, width: 1.3, material: color.withAlpha(0.5),
      } });
      this.entities.push(this.source.entities.add({ id: track.satellite_id, position,
        availability,
        // A metre-based offset in the tracking frame, independent of the model's size.
        viewFrom: new Cartesian3(-1500000, -1500000, 1200000),
        orientation: new VelocityOrientationProperty(position),
        model: { uri: './models/satellite.glb', minimumPixelSize: 30, maximumScale: 80000 },
        point: { pixelSize: 6, color },
        label: { text: spec.object_name, font: '13px sans-serif', fillColor: color,
          outlineColor: Color.fromCssColorString('#06162e'), outlineWidth: 3,
          style: LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cartesian2(0, -26) },
        path: { leadTime: 0, trailTime: 900, resolution: manifest.output_step_s, width: 2.5, material: color },
      }));
      this.source.entities.add({ id: `${track.satellite_id}-subpoint`, availability,
        position: subsatellitePosition(position),
        point: { pixelSize: 10, color, outlineColor: Color.fromCssColorString('#06162e'),
          outlineWidth: 2, heightReference: HeightReference.CLAMP_TO_GROUND },
        label: { text: `${spec.object_name} 星下点`, font: '12px sans-serif', fillColor: color,
          outlineColor: Color.fromCssColorString('#06162e'), outlineWidth: 3,
          style: LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cartesian2(0, 18),
          heightReference: HeightReference.CLAMP_TO_GROUND },
      });
    });
    const clock = this.viewer.clock;
    clock.startTime = this.epoch.clone();
    clock.currentTime = this.epoch.clone();
    clock.stopTime = JulianDate.fromIso8601(manifest.stop_utc);
    clock.clockStep = ClockStep.SYSTEM_CLOCK_MULTIPLIER;
    clock.clockRange = ClockRange.CLAMPED;
    clock.multiplier = 60;
    clock.canAnimate = true;
    this.focus();
    this.play(true);
    this.tick(true);
  }

  private tick(force = false) {
    if (!this.manifest || this.disposed || (!force && performance.now() - this.lastUpdate < 150)) return;
    this.lastUpdate = performance.now();
    const clock = this.viewer.clock;
    const elapsed = Math.max(0, JulianDate.secondsDifference(clock.currentTime, this.epoch));
    if (elapsed >= this.manifest.duration_s) {
      clock.shouldAnimate = false;
      this.viewer.scene.maximumRenderTimeChange = Infinity;
    }
    this.onChange({ manifest: this.manifest, elapsed, currentUtc: JulianDate.toIso8601(clock.currentTime, 0),
      playing: clock.shouldAnimate, speed: clock.multiplier, following: this.following,
      positions: this.entities.flatMap(entity => {
        const p = entity.position?.getValue(clock.currentTime);
        if (!p) return [];
        const point = Cartographic.fromCartesian(p);
        return [{ satellite_id: entity.id, longitude: CesiumMath.toDegrees(point.longitude),
          latitude: CesiumMath.toDegrees(point.latitude), height: point.height }];
      }) });
  }

  play(enabled: boolean) {
    if (!this.manifest) return;
    if (enabled && JulianDate.greaterThanOrEquals(this.viewer.clock.currentTime, this.viewer.clock.stopTime)) {
      this.viewer.clock.currentTime = this.epoch.clone();
    }
    this.viewer.clock.shouldAnimate = enabled;
    this.viewer.scene.maximumRenderTimeChange = enabled ? 0 : Infinity;
    this.viewer.scene.requestRender();
    this.tick(true);
  }
  seek(seconds: number) {
    if (!this.manifest) return;
    this.play(false);
    this.viewer.clock.currentTime = JulianDate.addSeconds(this.epoch,
      Math.max(0, Math.min(seconds, this.manifest.duration_s)), new JulianDate());
    this.viewer.scene.requestRender();
    this.tick(true);
  }
  speed(value: number) {
    if (![1, 30, 60, 120, 300].includes(value)) return;
    this.viewer.clock.multiplier = value;
    this.tick(true);
  }
  follow(id: string | null) {
    this.following = id;
    this.viewer.trackedEntity = this.entities.find(entity => entity.id === id);
    this.viewer.scene.requestRender();
    this.tick(true);
  }
  focus() {
    this.follow(null);
    this.viewer.camera.flyTo({ destination: Cartesian3.fromDegrees(105, 20, 23000000),
      orientation: { heading: 0, pitch: -CesiumMath.PI_OVER_TWO, roll: 0 }, duration: 0.8 });
  }
  clear(notify = true) {
    this.viewer.clock.shouldAnimate = false;
    this.viewer.scene.maximumRenderTimeChange = Infinity;
    this.viewer.trackedEntity = undefined;
    this.following = null;
    this.source.entities.removeAll();
    this.entities = [];
    this.manifest = null;
    this.viewer.scene.requestRender();
    if (notify) this.onChange(null);
  }
  destroy() {
    this.disposed = true;
    this.removeTick();
    this.clear(false);
    this.viewer.dataSources.remove(this.source, true);
  }
}
