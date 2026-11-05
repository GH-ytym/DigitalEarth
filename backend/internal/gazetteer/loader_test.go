package gazetteer

import (
	"archive/zip"
	"context"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNormalize(t *testing.T) {
	for input, want := range map[string]string{
		"  São-Paulo  ": "sao paulo", "São Paulo": "sao paulo", "Sa\u0303o Paulo": "sao paulo",
		"Ｂｅｉｊｉｎｇ": "beijing", "北京市": "北京市", "New_York%": "new york", "%_": "",
	} {
		if got := Normalize(input); got != want {
			t.Errorf("Normalize(%q)=%q, want %q", input, got, want)
		}
	}
}

func TestSphericalRepresentativeAcrossDateLine(t *testing.T) {
	c := center{}
	c.add(&Place{Longitude: 179, Latitude: 0, Population: 1000})
	c.add(&Place{Longitude: -179, Latitude: 0, Population: 1000})
	lon, lat, err := c.coordinates()
	if err != nil || math.Abs(math.Abs(lon)-180) > 1e-8 || math.Abs(lat) > 1e-8 {
		t.Fatalf("wrong representative: %v %v %v", lon, lat, err)
	}
}

func fixture(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "alternatenames"), 0755); err != nil {
		t.Fatal(err)
	}
	country := make([]string, 19)
	country[0] = "FR"
	country[4] = "France"
	country[16] = "900"
	write := func(path, value string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, path), []byte(value), 0644); err != nil {
			t.Fatal(err)
		}
	}
	write("countryInfo.txt", strings.Join(country, "\t")+"\n")
	write("admin1CodesASCII.txt", "FR.11\tÎle-de-France\tIle-de-France\t901\n")
	zipFile := func(path, member, value string) {
		t.Helper()
		f, err := os.Create(filepath.Join(dir, path))
		if err != nil {
			t.Fatal(err)
		}
		z := zip.NewWriter(f)
		w, err := z.Create(member)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = w.Write([]byte(value)); err != nil {
			t.Fatal(err)
		}
		if err = z.Close(); err != nil {
			t.Fatal(err)
		}
		if err = f.Close(); err != nil {
			t.Fatal(err)
		}
	}
	row := func(id int, name, population, feature, aliases string) string {
		f := make([]string, 19)
		f[0] = fmt.Sprint(id)
		f[1] = name
		f[2] = name
		f[3] = aliases
		f[4] = "48.8534"
		f[5] = "2.3488"
		f[6] = "P"
		f[7] = feature
		f[8] = "FR"
		f[10] = "11"
		f[14] = population
		f[18] = "2026-10-21"
		return strings.Join(f, "\t") + "\n"
	}
	aliases := []string{"巴黎", "París"}
	for i := 0; i < 50; i++ {
		aliases = append(aliases, fmt.Sprintf("alias%d", i))
	}
	zipFile("cities500.zip", "cities500.txt", row(1, "Paris", "1000", "PPL", strings.Join(aliases, ","))+row(2, "Seat", "0", "PPLA4", "")+row(3, "Small", "20", "PPL", ""))
	alias := func(id, name, language string) string {
		f := make([]string, 10)
		f[0] = "1"
		f[1] = id
		f[2] = language
		f[3] = name
		return strings.Join(f, "\t") + "\n"
	}
	zipFile(filepath.Join("alternatenames", "CN.zip"), "CN.txt", alias("900", "法国", "zh")+alias("901", "法兰西岛", "zh")+alias("1", "城市新增别名", "zh")+alias("900", "https://example.org", "link"))
	return dir
}

func TestLoadDocumentedRules(t *testing.T) {
	d, err := Load(fixture(t))
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Places) != 4 || d.Report.Counts["city_filtered"] != 1 {
		t.Fatalf("wrong selection: %+v", d.Report.Counts)
	}
	counts := map[int64]int{}
	keys := map[string]bool{}
	for _, n := range d.Names {
		counts[n.PlaceID]++
		key := fmt.Sprintf("%d/%s", n.PlaceID, n.Normalized)
		if keys[key] {
			t.Fatalf("duplicate normalized name %s", key)
		}
		keys[key] = true
	}
	if counts[1] != 32 || !keys["1/巴黎"] || !keys["900/法国"] || !keys["901/法兰西岛"] || keys["1/城市新增别名"] {
		t.Fatalf("wrong alias rules: %+v", keys)
	}
	for _, p := range d.Places {
		if p.ID == 1 && (p.Longitude != 2.3488 || p.Latitude != 48.8534) {
			t.Fatal("coordinate order changed")
		}
	}
}

func TestLoadRejectsMalformedRows(t *testing.T) {
	dir := fixture(t)
	if err := os.WriteFile(filepath.Join(dir, "admin1CodesASCII.txt"), []byte("too\tfew\tfields\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(dir); err == nil || !strings.Contains(err.Error(), "admin1CodesASCII.txt:1") {
		t.Fatalf("expected located parsing error, got %v", err)
	}
}

func TestEmptyImportCannotReplaceSnapshot(t *testing.T) {
	if err := Import(context.Background(), nil, &Data{}); err == nil {
		t.Fatal("empty import accepted")
	}
}

// Run explicitly against the independent local Compose database after importing.
func TestImportFailureRollsBack(t *testing.T) {
	if os.Getenv("GAZETTEER_INTEGRATION") != "1" {
		t.Skip("requires the populated local development database")
	}
	ctx := context.Background()
	conn, err := Connect(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	var beforePlaces, beforeNames int
	var beforeDigest string
	read := func() (int, int, string) {
		t.Helper()
		var p, n int
		var digest string
		err := conn.QueryRow(ctx, `SELECT (SELECT count(*) FROM gazetteer.places),(SELECT count(*) FROM gazetteer.names),source_digest FROM gazetteer.snapshot WHERE singleton`).Scan(&p, &n, &digest)
		if err != nil {
			t.Fatal(err)
		}
		return p, n, digest
	}
	beforePlaces, beforeNames, beforeDigest = read()
	if beforePlaces == 0 || beforeNames == 0 {
		t.Fatal("expected imported snapshot")
	}
	d, err := Load(fixture(t))
	if err != nil {
		t.Fatal(err)
	}
	// Duplicate a normalized name: staging COPY succeeds, final PK insert fails
	// after the old rows have been deleted inside the transaction.
	d.Names = append(d.Names, d.Names[0])
	if err := Import(ctx, conn, d); err == nil {
		t.Fatal("duplicate name import unexpectedly succeeded")
	}
	p, n, digest := read()
	if p != beforePlaces || n != beforeNames || digest != beforeDigest {
		t.Fatalf("failed import changed active snapshot: %d/%d %s", p, n, digest)
	}
	results, err := Search(ctx, conn, "北京", 6)
	if err != nil || !contains(results, 1816670, "city", "CN") {
		t.Fatalf("old snapshot not searchable: %v", err)
	}
}
