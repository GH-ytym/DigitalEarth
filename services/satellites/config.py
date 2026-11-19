from dataclasses import dataclass
from pathlib import Path
import os
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")

@dataclass(frozen=True)
class Settings:
    db_host: str = os.getenv("ORBIT_DB_HOST", "127.0.0.1")
    db_port: int = int(os.getenv("ORBIT_DB_PORT", "55433"))
    db_name: str = os.getenv("ORBIT_DB_NAME", "digitalearth_satellites")
    db_user: str = os.getenv("ORBIT_DB_USER", "digitalearth_satellites")
    db_password: str = os.getenv("ORBIT_DB_PASSWORD", "")
    endpoint: str = os.getenv("ORBIT_MINIO_ENDPOINT", "127.0.0.1:19000")
    minio_user: str = os.getenv("ORBIT_MINIO_USER", "")
    minio_password: str = os.getenv("ORBIT_MINIO_PASSWORD", "")
    bucket: str = os.getenv("ORBIT_BUCKET", "satellite-results")
    model_bucket: str = os.getenv("ORBIT_MODEL_BUCKET", "satellite-models")

    def db_kwargs(self):
        return dict(host=self.db_host, port=self.db_port, dbname=self.db_name,
                    user=self.db_user, password=self.db_password, connect_timeout=5)
