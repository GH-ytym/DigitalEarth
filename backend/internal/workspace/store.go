package workspace

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	defaultWorkspace = "default"
	algorithm        = "postgis-wgs84-geodesic-v1"
	annotationFields = `id::text, title, note, ST_X(position), ST_Y(position),
        source_geoname_id, visible, created_at, updated_at`
	measurementFields = `id::text, title, note, mode, vertices, segment_meters, total_meters,
        algorithm, visible, created_at, updated_at`
)

type Store struct {
	pool *pgxpool.Pool
}

func NewStore(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

func readAnnotation(row pgx.Row) (Annotation, error) {
	var value Annotation
	err := row.Scan(&value.ID, &value.Title, &value.Note, &value.Longitude, &value.Latitude,
		&value.SourceGeoNameID, &value.Visible, &value.CreatedAt, &value.UpdatedAt)
	return value, err
}

func readMeasurement(row pgx.Row) (Measurement, error) {
	var value Measurement
	err := row.Scan(&value.ID, &value.Title, &value.Note, &value.Mode, &value.Vertices,
		&value.SegmentMeters, &value.TotalMeters, &value.Algorithm, &value.Visible, &value.CreatedAt, &value.UpdatedAt)
	return value, err
}

func createHash(input any) ([]byte, error) {
	data, err := json.Marshal(input)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(data)
	return digest[:], nil
}

func (s *Store) ListAnnotations(ctx context.Context) ([]Annotation, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+annotationFields+` FROM map_workspace.annotations
        WHERE workspace_id = $1 ORDER BY updated_at DESC, id`, defaultWorkspace)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (Annotation, error) { return readAnnotation(row) })
}

func (s *Store) CreateAnnotation(ctx context.Context, input AnnotationInput) (Annotation, error) {
	if err := input.normalize(); err != nil {
		return Annotation{}, err
	}
	digest, err := createHash(input)
	if err != nil {
		return Annotation{}, err
	}
	// Retrying an identical request can return the existing record, even if it was edited later.
	row := s.pool.QueryRow(ctx, `INSERT INTO map_workspace.annotations AS existing
        (workspace_id, id, create_hash, title, note, position, source_geoname_id, visible)
        VALUES ($1, COALESCE(NULLIF($2::text, '')::uuid, gen_random_uuid()), $3, $4, $5,
            ST_SetSRID(ST_MakePoint($6, $7), 4326), $8, $9)
        ON CONFLICT (workspace_id, id) DO UPDATE SET create_hash = existing.create_hash
        WHERE existing.create_hash = EXCLUDED.create_hash
        RETURNING `+annotationFields,
		defaultWorkspace, input.ID, digest, input.Title, input.Note, *input.Longitude, *input.Latitude,
		input.SourceGeoNameID, *input.Visible)
	value, err := readAnnotation(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return Annotation{}, ErrConflict
	}
	return value, err
}

func (s *Store) UpdateAnnotation(ctx context.Context, id string, input AnnotationPatch) (Annotation, error) {
	source, err := input.normalize()
	if err != nil {
		return Annotation{}, err
	}
	row := s.pool.QueryRow(ctx, `UPDATE map_workspace.annotations SET
        title = COALESCE($3, title), note = COALESCE($4, note), visible = COALESCE($5, visible),
        position = COALESCE(ST_SetSRID(ST_MakePoint($6, $7), 4326), position),
        source_geoname_id = CASE WHEN $8::boolean THEN $9 ELSE source_geoname_id END,
        updated_at = now() WHERE workspace_id = $1 AND id = $2::text::uuid
        RETURNING `+annotationFields,
		defaultWorkspace, id, input.Title, input.Note, input.Visible, input.Longitude, input.Latitude,
		input.SourceGeoNameID != nil, source)
	return readAnnotation(row)
}

func (s *Store) DeleteAnnotation(ctx context.Context, id string) error {
	tag, err := s.pool.Exec(ctx, "DELETE FROM map_workspace.annotations WHERE workspace_id = $1 AND id = $2::text::uuid", defaultWorkspace, id)
	if err == nil && tag.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	return err
}

func (s *Store) ListMeasurements(ctx context.Context) ([]Measurement, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+measurementFields+` FROM map_workspace.measurements
        WHERE workspace_id = $1 ORDER BY updated_at DESC, id`, defaultWorkspace)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (Measurement, error) { return readMeasurement(row) })
}

func (s *Store) CreateMeasurement(ctx context.Context, input MeasurementInput) (Measurement, error) {
	if err := input.normalize(); err != nil {
		return Measurement{}, err
	}
	digest, err := createHash(input)
	if err != nil {
		return Measurement{}, err
	}
	// The ordered snapshots, spatial path, and authoritative lengths commit as a single row.
	row := s.pool.QueryRow(ctx, `WITH points AS (
        SELECT ordinality AS idx, ST_SetSRID(ST_MakePoint(
            (vertex ->> 'longitude')::double precision,
            (vertex ->> 'latitude')::double precision), 4326) AS point
        FROM jsonb_array_elements($7::jsonb) WITH ORDINALITY AS v(vertex, ordinality)
    ), lengths AS (
        SELECT idx, point, ST_Distance((lag(point) OVER (ORDER BY idx))::geography, point::geography, true) AS meters
        FROM points
    ), result AS (
        SELECT ST_MakeLine(point ORDER BY idx) AS path,
            array_agg(meters ORDER BY idx) FILTER (WHERE idx > 1) AS segments,
            sum(meters ORDER BY idx) AS total
        FROM lengths
    )
    INSERT INTO map_workspace.measurements AS existing (workspace_id, id, create_hash, title, note, mode,
        vertices, path, segment_meters, total_meters, algorithm, visible)
        SELECT $1, COALESCE(NULLIF($2::text, '')::uuid, gen_random_uuid()), $3, $4, $5, $6,
            $7, path, segments, total, $8, $9 FROM result
        ON CONFLICT (workspace_id, id) DO UPDATE SET create_hash = existing.create_hash
        WHERE existing.create_hash = EXCLUDED.create_hash
        RETURNING `+measurementFields,
		defaultWorkspace, input.ID, digest, input.Title, input.Note, input.Mode, input.Vertices, algorithm, *input.Visible)
	value, err := readMeasurement(row)
	var pgErr *pgconn.PgError
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return Measurement{}, ErrConflict
	case errors.As(err, &pgErr) && pgErr.Code == "23514":
		return Measurement{}, fmt.Errorf("%w: 相邻测量点需要位于不同位置。", ErrInvalid)
	default:
		return value, err
	}
}

func (s *Store) UpdateMeasurement(ctx context.Context, id string, input MetadataPatch) (Measurement, error) {
	if err := normalizeMetadata(input.Title, input.Note); err != nil {
		return Measurement{}, err
	}
	if input.Title == nil && input.Note == nil && input.Visible == nil {
		return Measurement{}, fmt.Errorf("%w: 请提供需要修改的字段。", ErrInvalid)
	}
	row := s.pool.QueryRow(ctx, `UPDATE map_workspace.measurements SET
        title = COALESCE($3, title), note = COALESCE($4, note), visible = COALESCE($5, visible),
        updated_at = now() WHERE workspace_id = $1 AND id = $2::text::uuid
        RETURNING `+measurementFields, defaultWorkspace, id, input.Title, input.Note, input.Visible)
	return readMeasurement(row)
}

func (s *Store) DeleteMeasurement(ctx context.Context, id string) error {
	tag, err := s.pool.Exec(ctx, "DELETE FROM map_workspace.measurements WHERE workspace_id = $1 AND id = $2::text::uuid", defaultWorkspace, id)
	if err == nil && tag.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	return err
}
