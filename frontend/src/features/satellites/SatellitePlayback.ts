import {
  ArcType, Cartesian2, Cartesian3, Cartographic, ClockRange, ClockStep, Color, CustomDataSource,
  HeightReference, JulianDate, LabelStyle, LinearApproximation, Math as CesiumMath, ReferenceFrame,
  SampledPositionProperty, TimeInterval, TimeIntervalCollection, TrackingReferenceFrame, VelocityOrientationProperty,
} from 'cesium';
import type { Entity, Viewer } from 'cesium';
import type { SatelliteManifest, SatelliteModel, SatellitePlaybackState, SatelliteSamples } from './types';
import { subsatellitePosition } from './subsatellitePosition';
import { earthRadius, orbitFollowRange, orbitViewDistance } from './orbitView';
import { satellitePlaybackSpeeds } from './types';

const colors = ['#80D9FA', '#FFBD7B', '#C5B1FF'];

/** Uses the workspace's existing Viewer; owns only satellite entities and their clock listener. */
export class SatellitePlayback {
  private source = new CustomDataSource('public-satellites');
  private entities: Entity[] = [];
  private orbitRadius = earthRadius;
  private orbitBounds = new Map<string, { min: number; max: number }>();
  private manifest: SatelliteManifest | null = null;
  private models: SatelliteModel[] = [];
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

  load(manifest: SatelliteManifest, samples: SatelliteSamples, models: SatelliteModel[]) {
    const byNorad = new Map(models.map(model => [model.norad_id, model]));
    if (byNorad.size !== manifest.satellites.length || manifest.satellites.some(sat => !byNorad.has(sat.norad_id))) {
      throw new Error('卫星模型配置不完整，当前场景已保留。');
    }
    this.clear(false);
    this.manifest = manifest;
    this.models = models;
    this.epoch = JulianDate.fromIso8601(manifest.epoch_utc);
    samples.satellites.forEach((track, index) => {
      const spec = manifest.satellites.find(sat => sat.satellite_id === track.satellite_id)!;
      const model = byNorad.get(spec.norad_id)!;
      const color = Color.fromCssColorString(colors[index]);
      const position = new SampledPositionProperty(ReferenceFrame.FIXED);
      position.addSamplesPackedArray(track.samples.flat(), this.epoch);
      position.setInterpolationOptions({ interpolationAlgorithm: LinearApproximation, interpolationDegree: 1 });
      const bounds = { min: Infinity, max: 0 };
      for (const [, x, y, z] of track.samples) {
        const radius = Math.hypot(x, y, z);
        bounds.min = Math.min(bounds.min, radius);
        bounds.max = Math.max(bounds.max, radius);
      }
      this.orbitBounds.set(track.satellite_id, bounds);
      this.orbitRadius = Math.max(this.orbitRadius, bounds.max);
      const availability = new TimeIntervalCollection([new TimeInterval({
        start: this.epoch, stop: JulianDate.fromIso8601(manifest.stop_utc),
      })]);
      this.source.entities.add({ id: `${track.satellite_id}-orbit`, polyline: {
        positions: track.samples.map(([, x, y, z]) => new Cartesian3(x, y, z)),
        arcType: ArcType.NONE, width: 1.3, material: color.withAlpha(0.5),
      } });
      this.entities.push(this.source.entities.add({ id: track.satellite_id, position,
        availability,
        // Keep a north-up Earth overview; only the view centre follows the satellite.
        trackingReferenceFrame: TrackingReferenceFrame.ENU,
        viewFrom: this.followOffset(bounds),
        orientation: new VelocityOrientationProperty(position),
        model: { uri: model.model_url, scale: model.render_options.scale,
          minimumPixelSize: model.render_options.minimum_pixel_size, maximumScale: model.render_options.maximum_scale },
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
    clock.multiplier = manifest.duration_s > 7200 ? 600 : 60;
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
    this.onChange({ manifest: this.manifest, models: this.models, elapsed, currentUtc: JulianDate.toIso8601(clock.currentTime, 0),
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
    if (!satellitePlaybackSpeeds.some(speed => speed === value)) return;
    this.viewer.clock.multiplier = value;
    this.tick(true);
  }
  follow(id: string | null) {
    const entity = this.entities.find(entity => entity.id === id);
    if (entity) {
      this.viewer.camera.cancelFlight();
      const bounds = this.orbitBounds.get(entity.id)!;
      const offset = this.followOffset(bounds);
      entity.viewFrom = offset;
      this.allowCameraDistance(bounds.max + offset.z);
    }
    this.following = entity?.id ?? null;
    this.viewer.trackedEntity = entity;
    this.viewer.scene.requestRender();
    this.tick(true);
  }
  focus() {
    this.follow(null);
    const distance = this.viewDistance(this.orbitRadius);
    this.allowCameraDistance(distance);
    this.viewer.camera.flyTo({ destination: Cartesian3.fromDegrees(105, 20, Math.max(23_000_000, distance - earthRadius)),
      orientation: { heading: 0, pitch: -CesiumMath.PI_OVER_TWO, roll: 0 }, duration: 0.8 });
  }
  private viewAngles() {
    const scene = this.viewer.scene;
    const aspect = Math.max(1, scene.canvas.clientWidth) / Math.max(1, scene.canvas.clientHeight);
    const frustum = this.viewer.camera.frustum;
    return { aspect, vertical: ('fovy' in frustum ? frustum.fovy : undefined) ?? CesiumMath.PI_OVER_THREE };
  }
  private viewDistance(radius: number) {
    const { vertical, aspect } = this.viewAngles();
    return orbitViewDistance(radius, vertical, aspect);
  }
  private followOffset(bounds: { min: number; max: number }) {
    const { vertical, aspect } = this.viewAngles();
    return new Cartesian3(0, 0, orbitFollowRange(bounds.max, bounds.min, vertical, aspect));
  }
  private allowCameraDistance(distance: number) {
    const controls = this.viewer.scene.screenSpaceCameraController;
    controls.maximumZoomDistance = Math.max(controls.maximumZoomDistance, distance * 2);
    const frustum = this.viewer.camera.frustum;
    frustum.far = Math.max(frustum.far, distance * 3);
  }
  clear(notify = true) {
    this.viewer.clock.shouldAnimate = false;
    this.viewer.scene.maximumRenderTimeChange = Infinity;
    this.viewer.trackedEntity = undefined;
    this.following = null;
    this.source.entities.removeAll();
    this.entities = [];
    this.orbitRadius = earthRadius;
    this.orbitBounds.clear();
    this.manifest = null;
    this.models = [];
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
