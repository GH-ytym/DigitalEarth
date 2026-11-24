from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
from hashlib import sha256
import json
import logging
from threading import Lock

from catalog import SATELLITES, SPECIFICATIONS
from dll_adapter import ENGINE_VERSION, FRAME_VERSION, utc

logger = logging.getLogger(__name__)

class BusyError(Exception):
    pass

class SatelliteService:
    def __init__(self, store, catalog, native):
        self.store, self.catalog, self.native = store, catalog, native
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="sgp4-dll")
        self.lock = Lock()
        self.active, self.native_calls = 0, 0

    def prepare(self, ids):
        rows = [row for row in self.catalog.entries() if row["norad_id"] in ids]
        if len(rows) != len(ids):
            raise ValueError("公开要素目录尚不完整，请更新数据。")
        now = datetime.now(timezone.utc)
        start = now.replace(hour=(now.hour//2)*2, minute=0, second=0, microsecond=0)
        historic = any(abs((start-utc(row["record"]["EPOCH"])).total_seconds()) > 6*86400 for row in rows)
        if historic:
            # Old snapshots remain usable as clearly dated historical replay, not 'live'.
            start = max(utc(row["record"]["EPOCH"]) for row in rows).replace(minute=0, second=0, microsecond=0)
        orbits = [SPECIFICATIONS[row["norad_id"]]["orbit_type"] for row in rows]
        has_medium_orbit = "MEO" in orbits
        duration = 86400 if has_medium_orbit else 7200
        # A mixed replay shares one clock; keep the fastest satellite's sampling resolution.
        step = 30 if has_medium_orbit and "LEO" not in orbits else 10
        return dict(norad_ids=sorted(ids), epoch_utc=start.isoformat().replace("+00:00", "Z"),
            duration_s=duration, output_step_s=step, window_kind="historical" if historic else "current-window",
            elements=[dict(norad_id=row["norad_id"], record=row["record"], fingerprint=row["fingerprint"],
                source_url=row["source_url"], fetched_at=row["fetched_at"].isoformat()) for row in rows])

    def cache_key(self, prepared):
        identity = {key: prepared[key] for key in ("norad_ids", "epoch_utc", "duration_s", "output_step_s")}
        identity["elements"] = [row["fingerprint"] for row in prepared["elements"]]
        identity.update(engine=ENGINE_VERSION, dll=self.native.fingerprint, frame=FRAME_VERSION, schema="satellites-1")
        return sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()).hexdigest()

    def submit(self, ids):
        prepared = self.prepare(ids)
        key = self.cache_key(prepared)
        with self.lock:
            previous = self.store.find_key(key)
            if previous and previous["status"] in {"queued", "running", "succeeded"}:
                return previous, False
            if self.active >= 3:
                raise BusyError("轨迹服务忙，请稍后加载。")
            row, created = self.store.claim(key, prepared)
            if created:
                self.active += 1
                self.executor.submit(self.compute, row, prepared)
            return row, created

    def compute(self, row, request):
        try:
            self.store.mark_running(row["result_id"])
            samples, satellites = [], []
            for entry in request["elements"]:
                record, norad = entry["record"], entry["norad_id"]
                key = self.cache_key(dict(request, norad_ids=[norad], elements=[entry]))
                cached = self.store.reusable_track(key, request, entry, ENGINE_VERSION, self.native.fingerprint, FRAME_VERSION)
                if cached:
                    satellites.append(dict(cached, sample_key=key, fetched_at=entry["fetched_at"], source_url=entry["source_url"]))
                    samples.append(None)
                    continue
                with self.lock:
                    self.native_calls += 1
                points = self.native.propagate(record, utc(request["epoch_utc"]),
                    duration=request["duration_s"], step=request["output_step_s"])
                satellite_id = f"norad-{norad}"
                samples.append(dict(satellite_id=satellite_id, samples=points))
                satellites.append(dict(satellite_id=satellite_id, norad_id=norad,
                    display_name=SATELLITES[norad], object_name=record["OBJECT_NAME"],
                    sample_key=key, sample_count=len(points), period_s=86400/float(record["MEAN_MOTION"]),
                    element_epoch_utc=utc(record["EPOCH"]).isoformat(), fetched_at=entry["fetched_at"],
                    source_url=entry["source_url"], elements=record))
            start = utc(request["epoch_utc"])
            manifest = dict(schema_version="satellites-1", result_id=row["result_id"],
                epoch_utc=request["epoch_utc"], stop_utc=(start+timedelta(seconds=request["duration_s"])).isoformat(),
                duration_s=request["duration_s"], output_step_s=request["output_step_s"], position_frame="ECEF_APPROX", position_unit="m",
                columns=["dt_s", "x_m", "y_m", "z_m"], satellites=satellites,
                window_kind=request["window_kind"], provider="CelesTrak", propagation="C++ SGP4 (WGS72)",
                engine_version=ENGINE_VERSION, dll_fingerprint=self.native.fingerprint, frame_version=FRAME_VERSION,
                frame_details="SGP4 TEME -> PEF by GMST; UT1 approximated by UTC; polar motion zero.",
                samples_url=f"/api/v1/satellites/tracks/{row['result_id']}/samples")
            self.store.save(row["result_id"], dict(schema_version="satellite-samples-1",
                result_id=row["result_id"], satellites=samples), manifest)
        except Exception:
            logger.exception("Public satellite propagation or storage failed")
            self.store.fail(row["result_id"], "卫星轨迹生成或保存失败，请检查服务后重试。")
        finally:
            with self.lock:
                self.active -= 1

    def close(self):
        self.executor.shutdown(wait=True)
