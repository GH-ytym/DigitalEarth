import {
  ArcType, Cartesian2, Cartesian3, Cartographic, ClockRange, ClockStep, Color, CustomDataSource,
  ConstantProperty, CallbackPositionProperty, ColorGeometryInstanceAttribute, GeometryInstance, PolylineColorAppearance,
  PolylineGeometry, Primitive, HeightReference, JulianDate, LabelStyle, Math as CesiumMath, ReferenceFrame,
  TimeInterval, TimeIntervalCollection, TrackingReferenceFrame, VelocityOrientationProperty,
} from 'cesium';
import type { Entity, Viewer } from 'cesium';
import type { SatelliteManifest, SatelliteModel, SatellitePlaybackState, OrbitChunk } from './types';
import { subsatellitePosition } from './subsatellitePosition';
import { earthRadius, orbitFollowRange, orbitViewDistance } from './orbitView';
import { satellitePlaybackSpeeds } from './types';

const colors = ['#80D9FA', '#FFBD7B', '#C5B1FF'];

/** Uses the workspace's existing Viewer; owns only satellite entities and their clock listener. */
export class SatellitePlayback {
  private source = new CustomDataSource('public-satellites');
  private windowController = new AbortController();
  private readers = new Map<string, NonNullable<OrbitChunk['nextWindow']>>();
  private loading = new Set<string>();
  private errors = new Map<string, string>();
  private trackLines = new Map<string, Primitive[]>();
  private lines: Primitive[] = [];
  private buffers = new Map<string, {xyz: Float64Array; loaded: Uint8Array}>();
  private entities: Entity[] = [];
  private orbitRadius = earthRadius;
  private orbitBounds = new Map<string, { min: number; max: number }>();
  private manifest: SatelliteManifest | null = null;
  private models: SatelliteModel[] = [];
  private epoch = new JulianDate();
  private preserveView = false;
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

  load(manifest: SatelliteManifest, chunk: OrbitChunk, models: SatelliteModel[]) {
    if (this.disposed) return;
    const newReplay = manifest !== this.manifest;
    const previous = this.manifest;
    const extending = newReplay && previous && previous.satellites.length < manifest.satellites.length &&
      previous.epoch_utc === manifest.epoch_utc && previous.satellites.every(old =>
        manifest.satellites.some(s => s.satellite_id === old.satellite_id) &&
        models.find(m => m.norad_id === old.norad_id)?.version_id ===
          this.models.find(m => m.norad_id === old.norad_id)?.version_id);
    if (newReplay) {
      if (!extending) this.clear(false);
      else {
        // Old window callbacks capture the previous manifest; retire them before switching.
        this.windowController.abort();
        this.windowController = new AbortController();
        for (const old of previous.satellites) {
          const next = manifest.satellites.find(s => s.satellite_id === old.satellite_id)!;
          const sameSamples = previous.output_step_s === manifest.output_step_s &&
            old.pack_key === next.pack_key && old.blocks && next.blocks && old.blocks.length === next.blocks.length &&
            old.blocks.every((b,i) => b.key === next.blocks![i].key && b.start === next.blocks![i].start);
          if (sameSamples) continue;
          this.buffers.delete(old.satellite_id);
          this.readers.delete(old.satellite_id);
          this.orbitBounds.delete(old.satellite_id);
          for (const line of this.trackLines.get(old.satellite_id) ?? []) {
            this.viewer.scene.primitives.remove(line);
            this.lines.splice(this.lines.indexOf(line), 1);
          }
          this.trackLines.delete(old.satellite_id);
        }
        this.viewer.clock.stopTime = JulianDate.fromIso8601(manifest.stop_utc);
        this.loading.clear();
        this.errors.clear();
      }
      this.preserveView = !!extending;
      this.manifest = manifest;
      this.models = models;
      this.epoch = JulianDate.fromIso8601(manifest.epoch_utc);
    }
    const spec = chunk.satellite;
    const id = spec.satellite_id;
    const color = Color.fromCssColorString(colors[spec.norad_id % colors.length]);
    let buffer = this.buffers.get(id);
    const firstChunk = !buffer;
    if (chunk.nextWindow && (!buffer || !this.readers.has(id))) this.readers.set(id, chunk.nextWindow);
    if (buffer && buffer.loaded[chunk.first]) {
      this.tick(true);
      return JulianDate.secondsDifference(this.viewer.clock.currentTime, this.epoch);
    }
    if (!buffer) {
      buffer = {xyz: new Float64Array(spec.sample_count * 3), loaded: new Uint8Array(spec.sample_count)};
      this.buffers.set(id, buffer);
    }
    const {xyz, loaded} = buffer;
    const end = chunk.first + chunk.xyz.length / 3;
    xyz.set(chunk.xyz, chunk.first * 3);
    loaded.fill(1, chunk.first, end);
    const overview = spec.overview;
    const bounds = this.orbitBounds.get(id) ?? {min: Infinity, max: 0};
    const coordinates = firstChunk && overview ? overview : chunk.xyz;
    for (let i = 0; i < coordinates.length; i += 3) {
      const radius = Math.hypot(coordinates[i], coordinates[i+1], coordinates[i+2]);
      bounds.min = Math.min(bounds.min, radius);
      bounds.max = Math.max(bounds.max, radius);
    }
    this.orbitBounds.set(id, bounds);
    const expandView = firstChunk && this.orbitRadius * 1.1 < bounds.max;
    this.orbitRadius = Math.max(this.orbitRadius, bounds.max);
    if (firstChunk && overview) {
      this.addLine(id, Cartesian3.unpackArray(overview), color);
    } else if (!overview) {
      // Older manifests have no overview. Join already loaded neighbours at hour boundaries.
      const first = Math.max(0, chunk.first - (loaded[chunk.first-1] ? 1 : 0));
      const last = end - 1 + (loaded[end] ? 1 : 0);
      const stride = Math.max(1, Math.ceil(spec.sample_count / 720));
      const point = (i: number) => new Cartesian3(xyz[3*i], xyz[3*i+1], xyz[3*i+2]);
      const positions = [];
      for (let i = first; i < last; i += stride) positions.push(point(i));
      positions.push(point(last));
      this.addLine(id, positions, color);
    }
    if (firstChunk) {
      const model = models.find(m => m.norad_id === spec.norad_id)!;
      const position = new CallbackPositionProperty((time, result) => {
        const t = JulianDate.secondsDifference(time!, this.epoch) / manifest.output_step_s;
        if (t < 0 || t > spec.sample_count - 1) return undefined;
        const i = Math.floor(t), j = Math.ceil(t);
        if (!loaded[i] || !loaded[j]) return undefined;
        const f = t-i, a = 3*i, b = 3*j;
        return Cartesian3.fromElements(xyz[a]+f*(xyz[b]-xyz[a]), xyz[a+1]+f*(xyz[b+1]-xyz[a+1]),
          xyz[a+2]+f*(xyz[b+2]-xyz[a+2]), result);
      }, false, ReferenceFrame.FIXED);
      const availability = new TimeIntervalCollection([new TimeInterval({
        start: this.epoch, stop: JulianDate.fromIso8601(manifest.stop_utc),
      })]);
      const existing = this.source.entities.getById(id);
      if (existing) {
        existing.position = position;
        existing.orientation = new VelocityOrientationProperty(position);
        existing.availability = availability;
        existing.path!.resolution = new ConstantProperty(manifest.output_step_s);
        const subpoint = this.source.entities.getById(id + '-subpoint')!;
        subpoint.position = subsatellitePosition(position);
        subpoint.availability = availability;
      } else {
        this.entities.push(this.source.entities.add({ id: spec.satellite_id, position,
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
        this.source.entities.add({ id: `${spec.satellite_id}-subpoint`, availability,
          position: subsatellitePosition(position),
          point: { pixelSize: 10, color, outlineColor: Color.fromCssColorString('#06162e'),
            outlineWidth: 2, heightReference: HeightReference.CLAMP_TO_GROUND },
          label: { text: `${spec.object_name} 星下点`, font: '12px sans-serif', fillColor: color,
            outlineColor: Color.fromCssColorString('#06162e'), outlineWidth: 3,
            style: LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cartesian2(0, 18),
            heightReference: HeightReference.CLAMP_TO_GROUND },
        });
      }
    }
    if (newReplay && !extending) {
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
    } else if (expandView && !this.following && !this.preserveView) {
      this.focus();
    }
    this.viewer.scene.requestRender();
    this.tick(true);
    return JulianDate.secondsDifference(this.viewer.clock.currentTime, this.epoch);
  }

  private addLine(id: string, positions: Cartesian3[], color: Color) {
    if (positions.length < 2) return;
    const line = new Primitive({
      geometryInstances: new GeometryInstance({ id, geometry: new PolylineGeometry({
        positions, width: 1.3, arcType: ArcType.NONE, vertexFormat: PolylineColorAppearance.VERTEX_FORMAT,
      }), attributes: {color: ColorGeometryInstanceAttribute.fromColor(color.withAlpha(0.5))} }),
      appearance: new PolylineColorAppearance({translucent: true}), asynchronous: true,
    });
    this.lines.push(this.viewer.scene.primitives.add(line));
    const track = this.trackLines.get(id) ?? [];
    track.push(line);
    this.trackLines.set(id, track);
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
    const manifest = this.manifest;
    const models = this.models;
    const signal = this.windowController.signal;
    for (const [id, reader] of this.readers) {
      if (this.loading.has(id) || this.errors.has(id)) continue;
      const request = reader(elapsed, clock.shouldAnimate ? Math.max(30, clock.multiplier) : 0, signal);
      if (!request) continue;
      this.loading.add(id);
      void request.then(chunk => {
        if (!signal.aborted) this.load(manifest, chunk, models);
      }).catch(() => {
        if (!signal.aborted) this.errors.set(id, '部分轨迹未能加载，可拖动时间轴重试。');
      }).finally(() => {
        if (!signal.aborted) { this.loading.delete(id); this.tick(true); }
      });
    }
    this.onChange({ loadError: this.errors.values().next().value, manifest: this.manifest, models: this.models, elapsed, currentUtc: JulianDate.toIso8601(clock.currentTime, 0),
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
    this.errors.clear();
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
    for (const line of this.lines) this.viewer.scene.primitives.remove(line);
    this.lines = [];
    this.trackLines.clear();
    this.buffers.clear();
    this.windowController.abort();
    this.windowController = new AbortController();
    this.loading.clear();
    this.readers.clear();
    this.errors.clear();
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
