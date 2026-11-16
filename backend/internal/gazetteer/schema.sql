CREATE SCHEMA IF NOT EXISTS gazetteer;
CREATE TABLE IF NOT EXISTS gazetteer.places (
    geoname_id bigint PRIMARY KEY CHECK (geoname_id > 0),
    kind text NOT NULL CHECK (kind IN ('country', 'admin1', 'admin2', 'admin3', 'admin4', 'admin5', 'city')),
    canonical_name text NOT NULL CHECK (canonical_name <> ''),
    ascii_name text NOT NULL,
    country_code text NOT NULL,
    country_name text NOT NULL,
    admin1_code text,
    admin1_name text,
    feature_code text NOT NULL,
    longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    population bigint NOT NULL CHECK (population >= 0),
    importance smallint NOT NULL,
    source_modified_on date,
    admin2_code text,
    admin3_code text,
    admin4_code text
);
CREATE TABLE IF NOT EXISTS gazetteer.names (
    place_id bigint NOT NULL REFERENCES gazetteer.places(geoname_id),
    name text NOT NULL CHECK (name <> ''),
    normalized_name text COLLATE "C" NOT NULL CHECK (normalized_name <> ''),
    priority smallint NOT NULL,
    PRIMARY KEY (place_id, normalized_name)
);
CREATE INDEX IF NOT EXISTS names_prefix_idx ON gazetteer.names
    (normalized_name text_pattern_ops, priority, place_id) INCLUDE (name);
CREATE INDEX IF NOT EXISTS places_rank_idx ON gazetteer.places
    (importance, population DESC, geoname_id);
CREATE TABLE IF NOT EXISTS gazetteer.snapshot (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    source text NOT NULL,
    dataset text NOT NULL,
    source_digest text NOT NULL,
    imported_at timestamptz NOT NULL,
    place_count integer NOT NULL,
    name_count integer NOT NULL,
    license text NOT NULL,
    attribution text NOT NULL
);
