from pathlib import Path
import secrets
import subprocess

from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parent
target = ROOT / ".env"
if not target.exists():
    # Preserve local storage credentials/data while retiring the standalone example.
    old = ROOT.parents[2] / "work/satellite-orbit-learning/.env"
    if old.exists():
        text = old.read_text(encoding="utf-8").replace("ORBIT_BUCKET=orbit-results", "ORBIT_BUCKET=satellite-results")
        text += "\nSATELLITES_POSTGRES_VOLUME=satellite-orbit-learning_postgres-data\nSATELLITES_MINIO_VOLUME=satellite-orbit-learning_minio-data\n"
    else:
        text = (ROOT / ".env.example").read_text(encoding="utf-8")
        text = text.replace("replace-local-password", secrets.token_urlsafe(24), 1)
        text = text.replace("replace-local-password", secrets.token_urlsafe(24), 1)
    target.write_text(text, encoding="utf-8")
values = dotenv_values(target)
for name in (values["SATELLITES_POSTGRES_VOLUME"], values["SATELLITES_MINIO_VOLUME"]):
    subprocess.run(["docker", "volume", "create", name], check=True, stdout=subprocess.DEVNULL)
print("Satellite storage configuration ready; existing credentials and volumes retained.")
