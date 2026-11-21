CREATE EXTENSION IF NOT EXISTS postgis;
CREATE SCHEMA IF NOT EXISTS map_workspace;

CREATE TABLE map_workspace.annotations (
    workspace_id text NOT NULL,
    id uuid NOT NULL,
    create_hash bytea NOT NULL,
    title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
    note text NOT NULL CHECK (char_length(note) <= 2000),
    position geometry(Point, 4326) NOT NULL CHECK (
        NOT ST_IsEmpty(position)
        AND ST_X(position) BETWEEN -180 AND 180
        AND ST_Y(position) BETWEEN -90 AND 90
    ),
    source_geoname_id bigint CHECK (source_geoname_id > 0),
    visible boolean NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, id)
);

CREATE TABLE map_workspace.measurements (
    workspace_id text NOT NULL,
    id uuid NOT NULL,
    create_hash bytea NOT NULL,
    title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
    note text NOT NULL CHECK (char_length(note) <= 2000),
    mode text NOT NULL CHECK (mode IN ('straight', 'polyline')),
    vertices jsonb NOT NULL,
    path geometry(LineString, 4326) NOT NULL CHECK (
        ST_NPoints(path) BETWEEN 2 AND 256
        AND (mode = 'polyline' OR ST_NPoints(path) = 2)
    ),
    segment_meters double precision[] NOT NULL CHECK (
        cardinality(segment_meters) = ST_NPoints(path) - 1 AND 0 < ALL(segment_meters)
    ),
    total_meters double precision NOT NULL CHECK (total_meters > 0),
    algorithm text NOT NULL,
    visible boolean NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (jsonb_typeof(vertices) = 'array' AND jsonb_array_length(vertices) = ST_NPoints(path)),
    PRIMARY KEY (workspace_id, id)
);

CREATE INDEX annotations_recent_idx ON map_workspace.annotations (workspace_id, updated_at DESC, id);
CREATE INDEX measurements_recent_idx ON map_workspace.measurements (workspace_id, updated_at DESC, id);
