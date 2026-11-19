"""Versioned model assets and satellite bindings, independent of orbit results."""
from io import BytesIO
import math
from uuid import uuid4

from psycopg.types.json import Jsonb

from catalog import SATELLITES
from config import ROOT

DEFAULT_RENDER_OPTIONS = dict(scale=1, minimum_pixel_size=40, maximum_scale=5000000)
MODEL_PREFIX = "/api/v1/satellites/models"


def render_options(options=None):
    values = {**DEFAULT_RENDER_OPTIONS, **(options or {})}
    limits = dict(scale=1000000, minimum_pixel_size=4096, maximum_scale=1000000000)
    if set(values) != set(limits) or any(type(value) not in (int, float) or
            not math.isfinite(value) or not 0 < value <= limits[key] for key, value in values.items()):
        raise ValueError("Invalid model render options.")
    if values["maximum_scale"] < values["scale"]:
        raise ValueError("maximum_scale must not be smaller than scale.")
    return values


class ModelRegistry:
    def __init__(self, store):
        self.store = store
        self.bucket = store.settings.model_bucket

    def initialize(self):
        with self.store.connect() as conn:
            conn.execute("""CREATE TABLE IF NOT EXISTS model_assets (
                id text PRIMARY KEY, slug text NOT NULL UNIQUE, name text NOT NULL,
                current_version_id text, is_default boolean NOT NULL DEFAULT false,
                created_at timestamptz NOT NULL DEFAULT now())""")
            conn.execute("""CREATE TABLE IF NOT EXISTS model_versions (
                id text PRIMARY KEY, asset_id text NOT NULL REFERENCES model_assets(id),
                version integer NOT NULL CHECK(version>0), object_key text NOT NULL UNIQUE,
                byte_length bigint NOT NULL CHECK(byte_length>0), render_options jsonb NOT NULL,
                source_info jsonb NOT NULL, geometry_info jsonb NOT NULL,
                created_at timestamptz NOT NULL DEFAULT now(),
                UNIQUE(asset_id,version), UNIQUE(asset_id,id))""")
            conn.execute("""DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='model_current_version_fk'
                               AND conrelid='model_assets'::regclass) THEN
                    ALTER TABLE model_assets ADD CONSTRAINT model_current_version_fk
                    FOREIGN KEY(id,current_version_id) REFERENCES model_versions(asset_id,id)
                    DEFERRABLE INITIALLY DEFERRED;
                END IF;
                END $$""")
            conn.execute("""CREATE UNIQUE INDEX IF NOT EXISTS model_assets_single_default
                ON model_assets(is_default) WHERE is_default""")
            conn.execute("""CREATE TABLE IF NOT EXISTS satellite_model_bindings (
                norad_id bigint PRIMARY KEY CHECK(norad_id>0 AND norad_id<=999999999),
                asset_id text REFERENCES model_assets(id),
                updated_at timestamptz NOT NULL DEFAULT now())""")
        if not self.store.objects.bucket_exists(self.bucket):
            self.store.objects.make_bucket(self.bucket)

    def asset(self, slug):
        with self.store.connect() as conn:
            return conn.execute("SELECT * FROM model_assets WHERE slug=%s", (slug,)).fetchone()

    def get_version(self, version_id):
        with self.store.connect() as conn:
            return conn.execute("""SELECT v.*,a.name AS asset_name,a.slug FROM model_versions v
                JOIN model_assets a ON a.id=v.asset_id WHERE v.id=%s""", (version_id,)).fetchone()

    def register(self, slug, name, data, source_info, geometry_info=None, options=None, make_default=False):
        from model_pack import validate_glb
        validate_glb(data)
        if not slug.strip() or not name.strip():
            raise ValueError("Model slug and name must not be empty.")
        options = render_options(options)
        info = {key: str(source_info.get(key, "")) for key in
                ("title", "author", "author_url", "source_url", "license", "license_url", "license_text")}
        from urllib.parse import urlparse
        for key in ("author_url", "source_url", "license_url"):
            if info[key] and (urlparse(info[key]).scheme not in {"http", "https"} or not urlparse(info[key]).netloc):
                raise ValueError("Model source links must be HTTP(S) URLs.")
        version_id, uploaded = str(uuid4()), False
        key = None
        try:
            with self.store.connect() as conn:
                conn.execute("SELECT pg_advisory_xact_lock(7310401)")
                asset = conn.execute("SELECT * FROM model_assets WHERE slug=%s", (slug,)).fetchone()
                asset_id = asset["id"] if asset else str(uuid4())
                if not asset:
                    conn.execute("INSERT INTO model_assets(id,slug,name) VALUES (%s,%s,%s)", (asset_id,slug,name))
                version = conn.execute("SELECT COALESCE(max(version),0)+1 AS n FROM model_versions WHERE asset_id=%s", (asset_id,)).fetchone()["n"]
                key = f"models/{asset_id}/{version_id}/model.glb"
                self.store.objects.put_object(self.bucket, key, BytesIO(data), len(data), content_type="model/gltf-binary")
                uploaded = True
                conn.execute("""INSERT INTO model_versions
                    (id,asset_id,version,object_key,byte_length,render_options,source_info,geometry_info)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
                    (version_id,asset_id,version,key,len(data),Jsonb(options),Jsonb(info),Jsonb(geometry_info or {})))
                conn.execute("UPDATE model_assets SET current_version_id=%s WHERE id=%s", (version_id,asset_id))
                if make_default:
                    conn.execute("UPDATE model_assets SET is_default=false WHERE is_default")
                    conn.execute("UPDATE model_assets SET is_default=true WHERE id=%s", (asset_id,))
        except Exception:
            if uploaded:
                self.store.objects.remove_object(self.bucket, key)
            raise
        return self.get_version(version_id)

    def set_default(self, asset_id):
        with self.store.connect() as conn:
            conn.execute("SELECT pg_advisory_xact_lock(7310401)")
            asset = conn.execute("SELECT * FROM model_assets WHERE id=%s", (asset_id,)).fetchone()
            if not asset or not asset["current_version_id"]:
                raise ValueError("Model asset has no published version.")
            conn.execute("UPDATE model_assets SET is_default=false WHERE is_default")
            conn.execute("UPDATE model_assets SET is_default=true WHERE id=%s", (asset_id,))

    def activate_version(self, asset_id, version_id):
        with self.store.connect() as conn:
            version = conn.execute("SELECT id FROM model_versions WHERE id=%s AND asset_id=%s", (version_id,asset_id)).fetchone()
            if not version:
                raise ValueError("Version does not belong to this model asset.")
            conn.execute("UPDATE model_assets SET current_version_id=%s WHERE id=%s", (version_id,asset_id))

    def bind(self, norad, asset_id=None):
        if type(norad) is not int or not 0 < norad <= 999999999:
            raise ValueError("Invalid NORAD catalog number.")
        with self.store.connect() as conn:
            if asset_id and not conn.execute("SELECT 1 FROM model_assets WHERE id=%s AND current_version_id IS NOT NULL", (asset_id,)).fetchone():
                raise ValueError("Model asset has no published version.")
            # NULL records an explicit choice to inherit the database's global default.
            conn.execute("""INSERT INTO satellite_model_bindings(norad_id,asset_id) VALUES (%s,%s)
                ON CONFLICT(norad_id) DO UPDATE SET asset_id=excluded.asset_id,updated_at=now()""", (norad,asset_id))

    def resolve(self, ids):
        with self.store.connect() as conn:
            rows = conn.execute("""SELECT r.norad_id,a.id AS asset_id,a.name AS asset_name,
                v.id AS version_id,v.version,v.render_options,v.source_info,
                CASE WHEN b.asset_id IS NULL THEN 'default' ELSE 'override' END AS binding
                FROM unnest(%s::bigint[]) WITH ORDINALITY AS r(norad_id,ord)
                LEFT JOIN satellite_model_bindings b ON b.norad_id=r.norad_id
                JOIN model_assets a ON a.id=COALESCE(b.asset_id,(SELECT id FROM model_assets WHERE is_default))
                JOIN model_versions v ON v.id=a.current_version_id AND v.asset_id=a.id ORDER BY r.ord""", (ids,)).fetchall()
        if len(rows) != len(ids):
            raise ValueError("No default model is registered; import a model before loading satellites.")
        return [dict(row, model_url=f"{MODEL_PREFIX}/versions/{row['version_id']}/model.glb") for row in rows]

    def list_assets(self):
        with self.store.connect() as conn:
            assets = conn.execute("SELECT * FROM model_assets ORDER BY created_at").fetchall()
            for asset in assets:
                asset["versions"] = conn.execute("""SELECT id,version,byte_length,render_options,source_info,
                    geometry_info,created_at FROM model_versions WHERE asset_id=%s ORDER BY version DESC""", (asset["id"],)).fetchall()
        return assets

    def bootstrap(self):
        with self.store.connect() as conn:
            default = conn.execute("SELECT id FROM model_assets WHERE is_default").fetchone()
        if not default:
            if not self.asset("builtin-satellite"):
                path = ROOT.parent.parent / "frontend/public/models/satellite.glb"
                self.register("builtin-satellite", "内置卫星示意模型", path.read_bytes(),
                    dict(title="DigitalEarth builtin satellite",author="DigitalEarth"),
                    options=dict(scale=1,minimum_pixel_size=30,maximum_scale=80000))
            asset = self.asset("simple-satellite-low-poly-free")
            if asset and asset["current_version_id"]:
                self.set_default(asset["id"])
            else:
                from model_pack import pack_model
                packed = pack_model(ROOT / "simple_satellite_low_poly_free.glb")
                self.register("simple-satellite-low-poly-free", "Simple Satellite Low Poly Free", packed.data,
                    packed.source_info, packed.geometry_info, make_default=True)
        with self.store.connect() as conn:
            for norad in SATELLITES:
                conn.execute("""INSERT INTO satellite_model_bindings(norad_id,asset_id) VALUES (%s,NULL)
                    ON CONFLICT(norad_id) DO NOTHING""", (norad,))
