"""PostgreSQL stores the index; MinIO stores the complete immutable samples."""
import re
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from orbit_codec import encode, decode
from io import BytesIO
import json
from uuid import uuid4

from minio import Minio
import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from config import Settings


class Store:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.objects = Minio(settings.endpoint, access_key=settings.minio_user,
                             secret_key=settings.minio_password, secure=False)

    def connect(self):
        return psycopg.connect(**self.settings.db_kwargs(), row_factory=dict_row)

    def initialize(self):
        with self.connect() as conn:
            conn.execute("""CREATE TABLE IF NOT EXISTS satellite_results (
                result_id text PRIMARY KEY,
                job_id text NOT NULL UNIQUE,
                cache_key text NOT NULL UNIQUE,
                request jsonb NOT NULL,
                status text NOT NULL CHECK (status IN ('queued','running','succeeded','failed')),
                manifest jsonb,
                object_key text,
                error text,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now()
            )""")
            # One Uvicorn process only. Interrupted requests are explicitly retryable.
            conn.execute("""UPDATE satellite_results SET status='failed',
                error='API restarted before this calculation completed.', updated_at=now()
                WHERE status IN ('queued','running')""")
        if not self.objects.bucket_exists(self.settings.bucket):
            self.objects.make_bucket(self.settings.bucket)

        self.reconcile()

    @staticmethod
    def lock_publication(conn):
        # Serialize namespace garbage collection with the complete PUT + SQL publication.
        conn.execute("SELECT pg_advisory_xact_lock(904231708)")

    def reconcile(self):
        with self.connect() as conn:
            self.lock_publication(conn)
            existing = set()
            for prefix in ("orbit-blocks/", "orbits/"):
                for obj in self.objects.list_objects(self.settings.bucket, prefix=prefix, recursive=True):
                    if re.fullmatch(r"orbit-blocks/[0-9]+/[0-9a-f]{64}\.orb|orbits/[0-9a-f-]{36}/samples\.json",
                                    obj.object_name):
                        existing.add(obj.object_name)
            referenced = set()
            for row in conn.execute("""SELECT result_id, manifest, object_key FROM satellite_results
                                       WHERE status='succeeded' FOR UPDATE""").fetchall():
                keys = ({row["object_key"]} if row["object_key"] else
                        {b["key"] for sat in row["manifest"]["satellites"] for b in sat["blocks"]})
                if keys and keys <= existing:
                    referenced.update(keys)
                else:
                    conn.execute("""UPDATE satellite_results SET status='failed', object_key=NULL,
                                 manifest=NULL, error='Missing orbit object; resubmit to regenerate.',
                                 updated_at=now() WHERE result_id=%s""", (row["result_id"],))
            for key in existing - referenced:
                self.objects.remove_object(self.settings.bucket, key)

    def find_key(self, key):
        with self.connect() as conn:
            return conn.execute("SELECT * FROM satellite_results WHERE cache_key=%s", (key,)).fetchone()

    def claim(self, key, request):
        result_id, job_id = str(uuid4()), str(uuid4())
        with self.connect() as conn:
            row = conn.execute("""INSERT INTO satellite_results
                (result_id,job_id,cache_key,request,status) VALUES (%s,%s,%s,%s,'queued')
                ON CONFLICT (cache_key) DO NOTHING RETURNING *""",
                (result_id, job_id, key, Jsonb(request))).fetchone()
            if row:
                return row, True
            row = conn.execute("SELECT * FROM satellite_results WHERE cache_key=%s FOR UPDATE", (key,)).fetchone()
            if row["status"] == "failed":
                row = conn.execute("""UPDATE satellite_results SET job_id=%s,status='queued',
                    error=NULL,updated_at=now() WHERE cache_key=%s RETURNING *""", (job_id, key)).fetchone()
                return row, True
            return row, False

    def get(self, result_id):
        with self.connect() as conn:
            return conn.execute("SELECT * FROM satellite_results WHERE result_id=%s", (result_id,)).fetchone()

    def job(self, job_id):
        with self.connect() as conn:
            return conn.execute("SELECT * FROM satellite_results WHERE job_id=%s", (job_id,)).fetchone()

    def list_results(self):
        with self.connect() as conn:
            return conn.execute("""SELECT result_id,job_id,status,request,manifest,error,created_at
                FROM satellite_results ORDER BY created_at DESC LIMIT 30""").fetchall()

    def reusable_track(self, key, request, entry, engine, dll, frame):
        # Match older block manifests by the same inputs used to derive the single-star key.
        with self.connect() as conn:
            row = conn.execute("""SELECT sat FROM satellite_results r,
                jsonb_array_elements(manifest->'satellites') sat
                WHERE status='succeeded' AND sat ? 'overview' AND sat ? 'blocks' AND
                (sat->>'sample_key'=%s OR (sat->>'norad_id'=%s AND
                 manifest->>'engine_version'=%s AND manifest->>'dll_fingerprint'=%s AND manifest->>'frame_version'=%s
                 AND r.request @> %s)) LIMIT 1""",
                (key, str(entry["norad_id"]), engine, dll, frame, Jsonb(dict(epoch_utc=request["epoch_utc"],
                 duration_s=request["duration_s"], output_step_s=request["output_step_s"],
                 elements=[dict(norad_id=entry["norad_id"], fingerprint=entry["fingerprint"])])))).fetchone()
            return row["sat"] if row else None

    def mark_running(self, result_id):
        with self.connect() as conn:
            conn.execute("UPDATE satellite_results SET status='running',updated_at=now() WHERE result_id=%s", (result_id,))

    def save(self, result_id, samples, manifest):
        try:
            with self.connect() as conn:
                self.lock_publication(conn)
                self.publish(conn, result_id, samples, manifest)
        except Exception:
            # Re-read committed references, including after an ambiguous COMMIT.
            # If storage itself is offline, startup retries the same reconciliation.
            self.reconcile()
            raise

    def publish(self, conn, result_id, samples, manifest):
        job = conn.execute("SELECT status FROM satellite_results WHERE result_id=%s FOR UPDATE",
                           (result_id,)).fetchone()
        if not job or job["status"] != "running":
            raise ValueError("Cannot publish an inactive orbit job")
        step = manifest["output_step_s"]
        per_hour = 3600 // step
        # Keep publication locked until every PUT completes, including on failure.
        with ThreadPoolExecutor(max_workers=4) as pool:
            uploads = []
            for spec, track in zip(manifest["satellites"], samples["satellites"], strict=True):
                if track is None:  # Already published immutable blocks shared by another result.
                    continue
                rows = track["samples"]
                # Overview only; playback still uses every original sample in the hour blocks.
                stride = max(1, (len(rows) - 1 + 719) // 720)
                overview = rows[:-1:stride] + [rows[-1]]
                spec["overview"] = [coordinate for point in overview for coordinate in point[1:]]
                blocks = []
                for first in range(0, len(rows) - 1, per_hour):
                    # Keep the final endpoint in the last hour, without duplicating boundaries.
                    end = first + per_hour
                    part = rows[first:] if end >= len(rows)-1 else rows[first:end]
                    start = int(part[0][0])
                    raw = encode([[t-start, x, y, z] for t,x,y,z in part], step)
                    digest = sha256(raw).hexdigest()
                    key = f"orbit-blocks/{spec['norad_id']}/{digest}.orb"
                    uploads.append(pool.submit(self.objects.put_object, self.settings.bucket, key,
                                               BytesIO(raw), len(raw), content_type="application/octet-stream"))
                    blocks.append(dict(start=start, count=len(part), key=key))
                spec["blocks"] = blocks
            for upload in uploads:
                upload.result()
        conn.execute("""UPDATE satellite_results SET status='succeeded',object_key=NULL,
                manifest=%s,updated_at=now() WHERE result_id=%s""", (Jsonb(manifest), result_id))

    def read_bytes(self, key):
        source = self.objects.get_object(self.settings.bucket, key)
        try:
            return source.read()
        finally:
            source.close()
            source.release_conn()

    def read_track(self, row, spec):
        if "blocks" not in spec:
            tracks = json.loads(self.read_bytes(row["object_key"]))["satellites"]
            return next(t["samples"] for t in tracks if t["satellite_id"] == spec["satellite_id"])
        rows = []
        for block in spec["blocks"]:
            for t, x, y, z in decode(self.read_bytes(block["key"])):
                rows.append([block["start"] + t, x, y, z])
        return rows

    def fail(self, result_id, message):
        with self.connect() as conn:
            conn.execute("""UPDATE satellite_results SET status='failed',error=%s,updated_at=now()
                WHERE result_id=%s AND status IN ('queued','running')""", (message, result_id))
