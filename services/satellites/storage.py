"""PostgreSQL stores the index; MinIO stores the complete immutable samples."""
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

    def mark_running(self, result_id):
        with self.connect() as conn:
            conn.execute("UPDATE satellite_results SET status='running',updated_at=now() WHERE result_id=%s", (result_id,))

    def save(self, result_id, samples, manifest):
        raw = json.dumps(samples, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        key = f"orbits/{result_id}/samples.json"
        self.objects.put_object(self.settings.bucket, key, BytesIO(raw), len(raw), content_type="application/json")
        manifest["byte_length"] = len(raw)
        try:
            with self.connect() as conn:
                conn.execute("""UPDATE satellite_results SET status='succeeded',object_key=%s,
                    manifest=%s,error=NULL,updated_at=now() WHERE result_id=%s""",
                    (key, Jsonb(manifest), result_id))
        except Exception:
            # Only remove the object created for this failed, unpublished result.
            self.objects.remove_object(self.settings.bucket, key)
            raise

    def fail(self, result_id, message):
        with self.connect() as conn:
            conn.execute("""UPDATE satellite_results SET status='failed',error=%s,updated_at=now()
                WHERE result_id=%s""", (message, result_id))
