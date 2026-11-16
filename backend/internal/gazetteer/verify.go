package gazetteer

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type QueryCheck struct {
	Query        string   `json:"query"`
	Milliseconds float64  `json:"milliseconds"`
	Results      []Result `json:"results"`
}

type Verification struct {
	CheckedAt  time.Time       `json:"checked_at"`
	PostgreSQL string          `json:"postgresql"`
	PostGIS    string          `json:"postgis"`
	Places     int             `json:"places"`
	Names      int             `json:"names"`
	Digest     string          `json:"source_digest"`
	Tables     int             `json:"gazetteer_tables"`
	TotalBytes int64           `json:"gazetteer_total_bytes"`
	OverCap    int             `json:"places_with_more_than_32_names"`
	Queries    []QueryCheck    `json:"queries"`
	PrefixPlan json.RawMessage `json:"prefix_query_plan"`
	Passed     bool            `json:"passed"`
}

func Verify(ctx context.Context, conn *pgx.Conn) (*Verification, error) {
	v := &Verification{CheckedAt: time.Now().UTC()}
	if err := conn.QueryRow(ctx, `SELECT current_setting('server_version'),postgis_full_version()`).Scan(&v.PostgreSQL, &v.PostGIS); err != nil {
		return nil, err
	}
	var snapshotPlaces, snapshotNames, orphans, invalid int
	if err := conn.QueryRow(ctx, `SELECT place_count,name_count,source_digest FROM gazetteer.snapshot WHERE singleton`).Scan(&snapshotPlaces, &snapshotNames, &v.Digest); err != nil {
		return nil, err
	}
	if err := conn.QueryRow(ctx, `SELECT
        (SELECT count(*) FROM gazetteer.places),
        (SELECT count(*) FROM gazetteer.names),
        (SELECT count(*) FROM information_schema.tables WHERE table_schema='gazetteer' AND table_type='BASE TABLE'),
        (SELECT count(*) FROM gazetteer.names n LEFT JOIN gazetteer.places p ON n.place_id=p.geoname_id WHERE p.geoname_id IS NULL),
        (SELECT count(*) FROM (SELECT place_id FROM gazetteer.names GROUP BY place_id HAVING count(*)>32) x),
        (SELECT count(*) FROM gazetteer.places WHERE longitude NOT BETWEEN -180 AND 180 OR latitude NOT BETWEEN -90 AND 90),
        (SELECT sum(pg_total_relation_size(format('%I.%I',schemaname,tablename)::regclass)) FROM pg_tables WHERE schemaname='gazetteer')
        `).Scan(&v.Places, &v.Names, &v.Tables, &orphans, &v.OverCap, &invalid, &v.TotalBytes); err != nil {
		return nil, err
	}
	// The 32-name cap applies to each input snapshot. A preserving merge may
	// legitimately exceed it; trimming here would discard existing search aliases.
	if snapshotPlaces != v.Places || snapshotNames != v.Names || v.Tables != 3 || orphans != 0 || invalid != 0 {
		return nil, fmt.Errorf("integrity check failed: snapshot=%d/%d actual=%d/%d tables=%d orphans=%d invalid=%d", snapshotPlaces, snapshotNames, v.Places, v.Names, v.Tables, orphans, invalid)
	}
	checks := []struct {
		query string
		check func([]Result) bool
	}{
		{"北京", func(r []Result) bool { return contains(r, 1816670, "city", "CN") }},
		{"Beijing", func(r []Result) bool { return contains(r, 1816670, "city", "CN") }},
		{"巴黎", func(r []Result) bool { return contains(r, 2988507, "city", "FR") }},
		{"Paris", func(r []Result) bool { return contains(r, 2988507, "city", "FR") && len(r) > 1 }},
		{"禄口", func(r []Result) bool {
			for _, p := range r {
				if p.CountryCode == "CN" && p.Kind == "city" {
					return true
				}
			}
			return false
		}},
		{"中国", func(r []Result) bool { return contains(r, 1814991, "country", "CN") }},
		{"江苏", func(r []Result) bool {
			for _, p := range r {
				if p.Kind == "admin1" && p.CountryCode == "CN" && p.Approximate {
					return true
				}
			}
			return false
		}},
		{"New Yo", func(r []Result) bool { return contains(r, 5128581, "city", "US") }},
		{"São Paulo", func(r []Result) bool { return contains(r, 3448439, "city", "BR") }},
		{"Sao Paulo", func(r []Result) bool { return contains(r, 3448439, "city", "BR") }},
		{"zzzzdigitalearthnomatch987654321", func(r []Result) bool { return len(r) == 0 }},
	}
	for _, check := range checks {
		start := time.Now()
		results, err := Search(ctx, conn, check.query, 6)
		if err != nil {
			return nil, fmt.Errorf("query %q: %w", check.query, err)
		}
		if !check.check(results) {
			return nil, fmt.Errorf("unexpected results for %q: %+v", check.query, results)
		}
		seen := map[int64]bool{}
		for _, r := range results {
			if seen[r.ID] || math.IsNaN(r.Longitude) || math.IsNaN(r.Latitude) {
				return nil, fmt.Errorf("invalid or duplicated result for %q", check.query)
			}
			seen[r.ID] = true
		}
		v.Queries = append(v.Queries, QueryCheck{check.query, float64(time.Since(start).Microseconds()) / 1000, results})
	}
	for _, input := range []string{"北", "%_", strings.Repeat("a", 101)} {
		if _, err := Search(ctx, conn, input, 6); err == nil {
			return nil, fmt.Errorf("invalid query accepted: %q", input)
		}
	}
	if _, err := Search(ctx, conn, "北京", 11); err == nil {
		return nil, fmt.Errorf("invalid limit accepted")
	}
	var plan []byte
	if err := conn.QueryRow(ctx, `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) `+SearchSQL, "beij", "beij%", 6).Scan(&plan); err != nil {
		return nil, err
	}
	if !strings.Contains(string(plan), "names_prefix_idx") {
		return nil, fmt.Errorf("selective prefix query did not use names_prefix_idx: %s", plan)
	}
	v.PrefixPlan = json.RawMessage(plan)
	v.Passed = true
	return v, nil
}

func contains(results []Result, id int64, kind, country string) bool {
	for _, r := range results {
		if r.ID == id && r.Kind == kind && r.CountryCode == country {
			return true
		}
	}
	return false
}
