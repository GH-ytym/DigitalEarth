package gazetteer

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed schema.sql
var schema string

const Attribution = "GeoNames, CC BY 4.0 — https://www.geonames.org/"

func connectionConfig() (*pgx.ConnConfig, error) {
	cfg, err := pgx.ParseConfig("")
	if err != nil {
		return nil, fmt.Errorf("invalid PostgreSQL environment configuration")
	}
	if path := os.Getenv("PGPASSWORD_FILE"); path != "" {
		b, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read database password file: %w", err)
		}
		cfg.Password = strings.TrimSpace(string(b))
	}
	cfg.ConnectTimeout = 10 * time.Second
	cfg.RuntimeParams["application_name"] = "digitalearth-gazetteer"
	return cfg, nil
}

func Connect(ctx context.Context) (*pgx.Conn, error) {
	cfg, err := connectionConfig()
	if err != nil {
		return nil, err
	}
	return pgx.ConnectConfig(ctx, cfg)
}

func ConnectPool(ctx context.Context) (*pgxpool.Pool, error) {
	cfg, err := connectionConfig()
	if err != nil {
		return nil, err
	}
	poolConfig, err := pgxpool.ParseConfig("")
	if err != nil {
		return nil, errors.New("invalid PostgreSQL pool configuration")
	}
	poolConfig.ConnConfig = cfg
	poolConfig.MaxConns = 4
	poolConfig.MinConns = 0
	poolConfig.MaxConnIdleTime = 5 * time.Minute
	return pgxpool.NewWithConfig(ctx, poolConfig)
}

func nullable(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func Import(ctx context.Context, conn *pgx.Conn, d *Data) error {
	if d == nil || len(d.Places) == 0 || len(d.Names) == 0 {
		return errors.New("refusing to replace a snapshot with an empty dataset")
	}
	start := time.Now()
	tx, err := conn.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(746293104861)"); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, schema); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `CREATE TEMP TABLE import_places (LIKE gazetteer.places INCLUDING DEFAULTS INCLUDING CONSTRAINTS) ON COMMIT DROP;
        CREATE TEMP TABLE import_names (LIKE gazetteer.names INCLUDING DEFAULTS INCLUDING CONSTRAINTS) ON COMMIT DROP;`); err != nil {
		return err
	}
	placeColumns := []string{"geoname_id", "kind", "canonical_name", "ascii_name", "country_code", "country_name", "admin1_code", "admin1_name", "feature_code", "longitude", "latitude", "population", "importance", "source_modified_on"}
	count, err := tx.CopyFrom(ctx, pgx.Identifier{"import_places"}, placeColumns, pgx.CopyFromSlice(len(d.Places), func(i int) ([]any, error) {
		p := d.Places[i]
		return []any{p.ID, p.Kind, p.Canonical, p.ASCII, p.CountryCode, p.CountryName, nullable(p.AdminCode), nullable(p.AdminName), p.Feature, p.Longitude, p.Latitude, p.Population, p.Importance, p.Modified}, nil
	}))
	if err != nil {
		return fmt.Errorf("COPY places: %w", err)
	}
	if count != int64(len(d.Places)) {
		return errors.New("place COPY count mismatch")
	}
	count, err = tx.CopyFrom(ctx, pgx.Identifier{"import_names"}, []string{"place_id", "name", "normalized_name", "priority"}, pgx.CopyFromSlice(len(d.Names), func(i int) ([]any, error) {
		n := d.Names[i]
		return []any{n.PlaceID, n.Display, n.Normalized, n.Priority}, nil
	}))
	if err != nil {
		return fmt.Errorf("COPY names: %w", err)
	}
	if count != int64(len(d.Names)) {
		return errors.New("name COPY count mismatch")
	}
	var orphans int
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM import_names n LEFT JOIN import_places p ON p.geoname_id=n.place_id WHERE p.geoname_id IS NULL`).Scan(&orphans); err != nil {
		return err
	}
	if orphans != 0 {
		return fmt.Errorf("%d orphan names in staging", orphans)
	}
	d.Report.Seconds["copy_and_staging_validation"] = time.Since(start).Seconds()
	start = time.Now()
	if _, err = tx.Exec(ctx, `DELETE FROM gazetteer.names; DELETE FROM gazetteer.places;
        INSERT INTO gazetteer.places SELECT * FROM import_places;
        INSERT INTO gazetteer.names SELECT * FROM import_names;`); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO gazetteer.snapshot
            (singleton,source,dataset,source_digest,imported_at,place_count,name_count,license,attribution)
        VALUES (true,'GeoNames',$1,$2,clock_timestamp(),$3,$4,'CC BY 4.0',$5)
        ON CONFLICT (singleton) DO UPDATE SET
            source=EXCLUDED.source,dataset=EXCLUDED.dataset,source_digest=EXCLUDED.source_digest,
            imported_at=EXCLUDED.imported_at,place_count=EXCLUDED.place_count,name_count=EXCLUDED.name_count,
            license=EXCLUDED.license,attribution=EXCLUDED.attribution`, d.Report.Dataset, d.Report.Digest, len(d.Places), len(d.Names), Attribution); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `ANALYZE gazetteer.places; ANALYZE gazetteer.names;`); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	d.Report.Seconds["replace_index_and_commit"] = time.Since(start).Seconds()
	d.Report.CompletedAt = time.Now().UTC()
	d.Report.Seconds["total"] = d.Report.CompletedAt.Sub(d.Report.StartedAt).Seconds()
	return nil
}

// SearchSQL uses the same normalized key as import; LIKE input is a parameter.
const SearchSQL = `WITH matches AS (
    SELECT DISTINCT ON (place_id) place_id,name,priority,
        CASE WHEN normalized_name=$1 THEN 0 ELSE 1 END AS match_quality
    FROM gazetteer.names WHERE normalized_name LIKE $2
    ORDER BY place_id,match_quality,priority,normalized_name
)
SELECT p.geoname_id,m.name,p.canonical_name,p.kind,p.country_code,p.country_name,
       p.admin1_code,p.admin1_name,p.feature_code,p.longitude,p.latitude,
       p.population,m.match_quality,m.priority
FROM matches m JOIN gazetteer.places p ON p.geoname_id=m.place_id
ORDER BY m.match_quality,m.priority,p.importance,p.population DESC,p.geoname_id
LIMIT $3`

type Result struct {
	ID           int64   `json:"geoname_id"`
	Name         string  `json:"name"`
	Canonical    string  `json:"canonical_name"`
	Kind         string  `json:"kind"`
	CountryCode  string  `json:"country_code"`
	CountryName  string  `json:"country_name"`
	AdminCode    *string `json:"admin1_code"`
	AdminName    *string `json:"admin1_name"`
	Feature      string  `json:"feature_code"`
	Longitude    float64 `json:"longitude"`
	Latitude     float64 `json:"latitude"`
	Population   int64   `json:"population"`
	MatchQuality int     `json:"match_quality"`
	Priority     int16   `json:"priority"`
	Approximate  bool    `json:"approximate_representative_point"`
}

type Queryer interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

var ErrInvalidSearch = errors.New("invalid search parameters")

func ValidateSearch(input string, limit int) (string, error) {
	key := Normalize(input)
	if n := utf8.RuneCountInString(key); n < 2 || n > 100 {
		return "", fmt.Errorf("%w: normalized query must contain 2–100 characters", ErrInvalidSearch)
	}
	if limit < 1 || limit > 10 {
		return "", fmt.Errorf("%w: limit must be between 1 and 10", ErrInvalidSearch)
	}
	return key, nil
}

func Search(ctx context.Context, conn Queryer, input string, limit int) ([]Result, error) {
	key, err := ValidateSearch(input, limit)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 750*time.Millisecond)
	defer cancel()
	rows, err := conn.Query(ctx, SearchSQL, key, key+"%", limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	results := []Result{}
	for rows.Next() {
		var r Result
		if err := rows.Scan(&r.ID, &r.Name, &r.Canonical, &r.Kind, &r.CountryCode, &r.CountryName, &r.AdminCode, &r.AdminName, &r.Feature, &r.Longitude, &r.Latitude, &r.Population, &r.MatchQuality, &r.Priority); err != nil {
			return nil, err
		}
		r.Approximate = r.Kind != "city"
		results = append(results, r)
	}
	return results, rows.Err()
}
