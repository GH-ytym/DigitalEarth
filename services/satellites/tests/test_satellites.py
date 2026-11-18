import csv
import ctypes as C
from datetime import datetime, timezone
import json
import math
import time
import unittest

from sgp4 import omm
from sgp4.api import Satrec
from fastapi.testclient import TestClient

from app import app
from config import ROOT
from dll_adapter import OrbitLibrary, julian, utc


class NativeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.native = OrbitLibrary(ROOT / "build/satellites.dll")
        with (ROOT / "data/public-gp.csv").open(encoding="utf-8", newline="") as source:
            cls.records = list(csv.DictReader(source))

    def test_public_omm_matches_reference_sgp4(self):
        for record in self.records:
            epoch = utc(record["EPOCH"])
            points = self.native.propagate(record, epoch, duration=600, step=60)
            reference = Satrec()
            omm.initialize(reference, record)
            for dt, x, y, z in points:
                # Split JD prevents avoidable precision loss in the independent caller.
                start = julian(epoch)
                day = math.floor(start)
                error, r, _ = reference.sgp4(day, start-day+dt/86400)
                self.assertEqual(error, 0)
                jd = start + dt/86400
                centuries = (jd-2451545.0)/36525
                theta = (67310.54841 + (876600*3600 + 8640184.812866)*centuries +
                         .093104*centuries**2 - 6.2e-6*centuries**3) * math.pi / 43200
                expected = [(math.cos(theta)*r[0]+math.sin(theta)*r[1])*1000,
                            (-math.sin(theta)*r[0]+math.cos(theta)*r[1])*1000, r[2]*1000]
                self.assertLess(math.dist([x,y,z], expected), 1.0)
                self.assertGreater(math.hypot(x,y,z), 6370000)

    def test_capacity_and_nonfinite_epoch_are_rejected(self):
        fields = (C.c_double*10)(2461361.5, 15.4, .001, 51.6, 100, 20, 30, .0001, 0, 0)
        output = (C.c_double*4)(123,123,123,123)
        written = C.c_int32(999)
        self.assertEqual(self.native.function(fields, fields[0], 2, 10, output, 1, C.byref(written)), 2)
        self.assertEqual(written.value, 0)
        self.assertEqual(list(output), [123]*4)
        self.assertEqual(self.native.function(fields, float('nan'), 1, 10, output, 1, C.byref(written)), 1)


class PipelineTests(unittest.TestCase):
    def test_public_catalog_saved_tracks_and_restart_reuse(self):
        body = {"norad_ids": [25544, 20580]}
        with TestClient(app) as client:
            catalog = client.get("/api/v1/satellites/catalog").json()
            self.assertEqual({sat["norad_id"] for sat in catalog["satellites"]}, {25544,20580,43013})
            self.assertTrue(all(sat["source_url"].startswith("https://celestrak.org/") for sat in catalog["satellites"]))
            response = client.post("/api/v1/satellites/tracks", json=body)
            self.assertIn(response.status_code, (200,202))
            job = response.json()
            deadline = time.monotonic()+20
            while job["status"] in {"queued", "running"}:
                self.assertLess(time.monotonic(), deadline)
                time.sleep(.03)
                job = client.get(f"/api/v1/satellites/jobs/{job['job_id']}").json()
            self.assertEqual(job["status"], "succeeded", job)
            manifest = client.get(job["result_url"]).json()
            self.assertEqual(manifest["propagation"], "C++ SGP4 (WGS72)")
            saved = client.get(manifest["samples_url"])
            self.assertEqual(saved.status_code, 200)
            self.assertEqual(len(saved.json()["satellites"]), 2)
            self.assertEqual(saved.json()["satellites"][0]["samples"][-1][0], 7200)
            count = client.get("/api/v1/satellites/health").json()["native_calls"]
            repeated = client.post("/api/v1/satellites/tracks", json={"norad_ids": [20580,25544]})
            self.assertEqual(repeated.status_code, 200)
            self.assertTrue(repeated.json()["cache_hit"])
            self.assertEqual(repeated.json()["result_id"], job["result_id"])
            self.assertEqual(client.get("/api/v1/satellites/health").json()["native_calls"], count)
            self.assertEqual(client.post("/api/v1/satellites/tracks", json={**body,"altitude_km":550}).status_code, 422)
            self.assertEqual(client.post("/api/v1/satellites/tracks", json={"norad_ids":[123]}).status_code, 422)
            changed = client.app.state.service.prepare([25544,20580])
            key = client.app.state.service.cache_key(changed)
            changed["elements"][0]["fingerprint"] = "different-public-elements"
            self.assertNotEqual(client.app.state.service.cache_key(changed), key)
        with TestClient(app) as client:
            repeated = client.post("/api/v1/satellites/tracks", json=body).json()
            self.assertTrue(repeated["cache_hit"])
            self.assertEqual(repeated["result_id"], job["result_id"])
            self.assertEqual(client.get(manifest["samples_url"]).content, saved.content)
            self.assertEqual(client.get("/api/v1/satellites/health").json()["native_calls"], 0)

if __name__ == "__main__":
    unittest.main()
