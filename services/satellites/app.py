from contextlib import asynccontextmanager
from uuid import UUID

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from minio.error import S3Error
from pydantic import BaseModel, ConfigDict, Field, model_validator

from catalog import PublicCatalog, SATELLITES
from config import ROOT, Settings
from dll_adapter import OrbitLibrary
from service import BusyError, SatelliteService
from storage import Store

class TrackRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    norad_ids: list[int] = Field(min_length=1, max_length=3)

    @model_validator(mode="after")
    def supported(self):
        if len(set(self.norad_ids)) != len(self.norad_ids) or not set(self.norad_ids) <= set(SATELLITES):
            raise ValueError("请选择目录中不重复的卫星编号。")
        return self

@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = Settings()
    if not settings.db_password or not settings.minio_password:
        raise RuntimeError("Run initialize.py before starting the satellite API.")
    store = Store(settings)
    store.initialize()
    catalog = PublicCatalog(store)
    catalog.initialize()
    app.state.service = SatelliteService(store, catalog, OrbitLibrary(ROOT / "build/satellites.dll"))
    try:
        yield
    finally:
        app.state.service.close()

app = FastAPI(title="DigitalEarth public satellite API", lifespan=lifespan)
PREFIX = "/api/v1/satellites"

@app.get(PREFIX + "/health")
def health(request: Request):
    service = request.app.state.service
    with service.store.connect() as conn:
        conn.execute("SELECT 1")
    return dict(status="ok", native_calls=service.native_calls, active_jobs=service.active,
                bucket_ready=service.store.objects.bucket_exists(service.store.settings.bucket))

@app.get(PREFIX + "/catalog")
def catalog(request: Request):
    service = request.app.state.service
    service.catalog.refresh()
    return service.catalog.describe()

@app.post(PREFIX + "/refresh")
def refresh(request: Request):
    service = request.app.state.service
    updated = service.catalog.refresh()
    return dict(updated=updated, **service.catalog.describe())

def job_description(row):
    return dict(job_id=row["job_id"], result_id=row["result_id"], status=row["status"],
        error=row["error"], result_url=f"{PREFIX}/tracks/{row['result_id']}")

@app.post(PREFIX + "/tracks")
def submit(body: TrackRequest, request: Request):
    try:
        row, created = request.app.state.service.submit(body.norad_ids)
    except (ValueError, BusyError) as exc:
        raise HTTPException(503, str(exc)) from exc
    result = job_description(row)
    result.update(cache_hit=not created and row["status"] == "succeeded")
    return JSONResponse(result, status_code=200 if row["status"] == "succeeded" else 202)

@app.get(PREFIX + "/jobs/{job_id}")
def job(job_id: UUID, request: Request):
    row = request.app.state.service.store.job(str(job_id))
    if not row:
        raise HTTPException(404, "任务不存在。")
    return job_description(row)

@app.get(PREFIX + "/tracks")
def results(request: Request):
    return dict(results=request.app.state.service.store.list_results())

@app.get(PREFIX + "/tracks/{result_id}")
def manifest(result_id: UUID, request: Request):
    row = request.app.state.service.store.get(str(result_id))
    if not row:
        raise HTTPException(404, "成果不存在。")
    if row["status"] != "succeeded":
        raise HTTPException(409, "成果尚未完成。")
    return row["manifest"]

@app.get(PREFIX + "/tracks/{result_id}/samples")
def download(result_id: UUID, request: Request):
    store = request.app.state.service.store
    row = store.get(str(result_id))
    if not row or row["status"] != "succeeded":
        raise HTTPException(404, "可用成果不存在。")
    etag = f'"{result_id}"'
    headers = {"ETag": etag, "Cache-Control": "private, max-age=31536000, immutable"}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    try:
        source = store.objects.get_object(store.settings.bucket, row["object_key"])
    except S3Error as exc:
        raise HTTPException(503, "轨迹文件暂不可用，请检查对象存储。") from exc
    def chunks():
        try:
            yield from source.stream(64*1024)
        finally:
            source.close()
            source.release_conn()
    headers["Content-Length"] = str(row["manifest"]["byte_length"])
    return StreamingResponse(chunks(), media_type="application/json", headers=headers)
