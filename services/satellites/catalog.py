"""Fetch public GP elements on demand, with a persistent two-hour minimum interval."""
import csv
from datetime import datetime, timezone, timedelta
import gzip
from hashlib import sha256
from io import StringIO
import json
import logging
import math
from threading import Lock
from urllib.request import Request, urlopen

from psycopg.types.json import Jsonb
from config import ROOT
from dll_adapter import utc

SATELLITES = {25544: "国际空间站 ISS", 20580: "哈勃空间望远镜 HST", 43013: "NOAA-20 气象卫星"}
FIELDS = ("MEAN_MOTION", "ECCENTRICITY", "INCLINATION", "RA_OF_ASC_NODE",
          "ARG_OF_PERICENTER", "MEAN_ANOMALY", "BSTAR", "MEAN_MOTION_DOT", "MEAN_MOTION_DDOT")
logger = logging.getLogger(__name__)

def source_url(norad):
    return f"https://celestrak.org/NORAD/elements/gp.php?CATNR={norad}&FORMAT=CSV"

def validate(record):
    norad = int(record["NORAD_CAT_ID"])
    if norad not in SATELLITES or not record.get("OBJECT_NAME"):
        raise ValueError("Unexpected satellite in public data.")
    utc(record["EPOCH"])
    values = {name: float(record[name]) for name in FIELDS}
    if not all(math.isfinite(value) for value in values.values()) or not 0 < values["MEAN_MOTION"] < 20 or not 0 <= values["ECCENTRICITY"] < 1:
        raise ValueError("Invalid public GP orbital element.")
    return norad

class PublicCatalog:
    def __init__(self, store):
        self.store = store
        self.lock = Lock()

    def initialize(self):
        with self.store.connect() as conn:
            conn.execute("""CREATE TABLE IF NOT EXISTS satellite_elements (
                norad_id integer PRIMARY KEY, record jsonb NOT NULL, fetched_at timestamptz NOT NULL,
                source_url text NOT NULL, fingerprint text NOT NULL)""")
            conn.execute("""CREATE TABLE IF NOT EXISTS satellite_source_state (
                id integer PRIMARY KEY CHECK(id=1), attempted_at timestamptz, error text)""")
            if conn.execute("SELECT count(*) AS n FROM satellite_elements").fetchone()["n"] == 0:
                meta = json.loads((ROOT / "data/public-gp.json").read_text(encoding="utf-8"))
                records = list(csv.DictReader(StringIO((ROOT / "data/public-gp.csv").read_text(encoding="utf-8"))))
                self.write(conn, records, utc(meta["fetched_at"]))
                conn.execute("INSERT INTO satellite_source_state VALUES (1,%s,NULL)", (utc(meta["fetched_at"]),))

    def write(self, conn, records, fetched):
        if len(records) != len(SATELLITES) or {validate(row) for row in records} != set(SATELLITES):
            raise ValueError("Public source did not return the complete configured catalog.")
        for record in records:
            norad = validate(record)
            fingerprint = sha256(json.dumps(record, sort_keys=True).encode()).hexdigest()
            conn.execute("""INSERT INTO satellite_elements VALUES (%s,%s,%s,%s,%s)
                ON CONFLICT(norad_id) DO UPDATE SET record=excluded.record,fetched_at=excluded.fetched_at,
                source_url=excluded.source_url,fingerprint=excluded.fingerprint""",
                (norad, Jsonb(record), fetched, source_url(norad), fingerprint))

    def refresh(self):
        with self.lock:
            now = datetime.now(timezone.utc)
            with self.store.connect() as conn:
                state = conn.execute("SELECT * FROM satellite_source_state WHERE id=1").fetchone()
                if state and state["attempted_at"] and now-state["attempted_at"] < timedelta(hours=2):
                    return False
                conn.execute("""INSERT INTO satellite_source_state VALUES (1,%s,NULL)
                    ON CONFLICT(id) DO UPDATE SET attempted_at=excluded.attempted_at,error=NULL""", (now,))
            try:
                records = []
                for norad in SATELLITES:
                    request = Request(source_url(norad), headers={
                        "User-Agent": "DigitalEarth/0.1 public-orbit-viewer", "Accept-Encoding": "gzip"})
                    # No retries: stop all remaining source requests after the first non-200/error.
                    with urlopen(request, timeout=15) as response:
                        if response.status != 200:
                            raise ValueError("CelesTrak returned a non-200 response.")
                        raw = response.read(1024 * 1024)
                        if response.headers.get("Content-Encoding") == "gzip":
                            raw = gzip.decompress(raw)
                    rows = list(csv.DictReader(StringIO(raw.decode("utf-8-sig"))))
                    if len(rows) != 1 or int(rows[0]["NORAD_CAT_ID"]) != norad:
                        raise ValueError("CelesTrak query returned unexpected data.")
                    records.extend(rows)
                with self.store.connect() as conn:
                    self.write(conn, records, now)
                return True
            except Exception:
                logger.exception("Public GP update failed; retaining the last complete catalog")
                with self.store.connect() as conn:
                    conn.execute("UPDATE satellite_source_state SET error=%s WHERE id=1",
                                 ("公开数据更新失败，保留上次完整快照；请稍后重试。",))
                return False

    def entries(self):
        with self.store.connect() as conn:
            return conn.execute("SELECT * FROM satellite_elements ORDER BY norad_id").fetchall()

    def describe(self):
        now = datetime.now(timezone.utc)
        with self.store.connect() as conn:
            state = conn.execute("SELECT * FROM satellite_source_state WHERE id=1").fetchone()
        return dict(provider="CelesTrak", update_error=state["error"] if state else None,
                    next_update_at=(state["attempted_at"]+timedelta(hours=2)) if state else None,
                    satellites=[dict(norad_id=row["norad_id"], display_name=SATELLITES[row["norad_id"]],
                        object_name=row["record"]["OBJECT_NAME"], epoch_utc=utc(row["record"]["EPOCH"]),
                        fetched_at=row["fetched_at"], source_url=row["source_url"],
                        age_hours=round((now-utc(row["record"]["EPOCH"])).total_seconds()/3600, 1))
                        for row in self.entries()])
