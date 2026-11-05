package gazetteer

import (
	"archive/zip"
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const DatasetVersion = "cities500-local-v1"

type Name struct {
	PlaceID    int64
	Display    string
	Normalized string
	Priority   int16
}

type Place struct {
	ID                                               int64
	Kind, Canonical, ASCII, CountryCode, CountryName string
	AdminCode, AdminName, Feature                    string
	Longitude, Latitude                              float64
	Population                                       int64
	Importance                                       int16
	Modified                                         *time.Time
	candidates                                       map[string]Name
}

type Report struct {
	Dataset     string             `json:"dataset"`
	Digest      string             `json:"source_digest"`
	Files       map[string]string  `json:"file_sha256"`
	StartedAt   time.Time          `json:"started_at"`
	CompletedAt time.Time          `json:"completed_at"`
	Counts      map[string]int     `json:"counts"`
	Seconds     map[string]float64 `json:"seconds"`
}

type Data struct {
	Places []*Place
	Names  []Name
	Report Report
}

type reference struct {
	id          int64
	name, ascii string
}
type center struct {
	x, y, z    float64
	population int64
	count      int
}

func (c *center) add(p *Place) {
	weight := math.Max(float64(p.Population), 1)
	lon, lat := p.Longitude*math.Pi/180, p.Latitude*math.Pi/180
	c.x += weight * math.Cos(lat) * math.Cos(lon)
	c.y += weight * math.Cos(lat) * math.Sin(lon)
	c.z += weight * math.Sin(lat)
	c.population += p.Population
	c.count++
}

func (c center) coordinates() (float64, float64, error) {
	if c.count == 0 || math.Sqrt(c.x*c.x+c.y*c.y+c.z*c.z) < 1e-9 {
		return 0, 0, fmt.Errorf("cannot calculate representative point")
	}
	return math.Atan2(c.y, c.x) * 180 / math.Pi,
		math.Atan2(c.z, math.Hypot(c.x, c.y)) * 180 / math.Pi, nil
}

func (p *Place) addName(display string, priority int16) {
	display = strings.TrimSpace(display)
	key := Normalize(display)
	if key == "" {
		return
	}
	if hasHan(display) {
		priority -= 10
	}
	candidate := Name{p.ID, display, key, priority}
	previous, exists := p.candidates[key]
	if !exists || candidate.Priority < previous.Priority ||
		(candidate.Priority == previous.Priority && candidate.Display < previous.Display) {
		p.candidates[key] = candidate
	}
}

func scanTSV(reader io.Reader, label string, columns int, visit func([]string) error) error {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), 2*1024*1024)
	line := 0
	for scanner.Scan() {
		line++
		text := strings.TrimSuffix(scanner.Text(), "\r")
		if text == "" || strings.HasPrefix(text, "#") {
			continue
		}
		if !utf8.ValidString(text) {
			return fmt.Errorf("%s:%d: invalid UTF-8", label, line)
		}
		fields := strings.Split(text, "\t")
		if len(fields) != columns {
			return fmt.Errorf("%s:%d: expected %d fields, got %d", label, line, columns, len(fields))
		}
		if err := visit(fields); err != nil {
			return fmt.Errorf("%s:%d: %w", label, line, err)
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("%s:%d: %w", label, line, err)
	}
	return nil
}

func readTSV(path string, columns int, visit func([]string) error) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return scanTSV(f, path, columns, visit)
}

func readZIP(path, member string, columns int, visit func([]string) error) error {
	z, err := zip.OpenReader(path)
	if err != nil {
		return err
	}
	defer z.Close()
	for _, entry := range z.File {
		if entry.Name != member {
			continue
		}
		r, err := entry.Open()
		if err != nil {
			return err
		}
		defer r.Close()
		return scanTSV(r, path+"/"+member, columns, visit)
	}
	return fmt.Errorf("%s: missing %s", path, member)
}

func positiveID(value string) (int64, error) {
	id, err := strconv.ParseInt(value, 10, 64)
	if err != nil || id <= 0 {
		return 0, fmt.Errorf("invalid geoname ID %q", value)
	}
	return id, nil
}

func Load(directory string) (*Data, error) {
	d := &Data{Report: Report{Dataset: DatasetVersion, StartedAt: time.Now().UTC(),
		Files: map[string]string{}, Counts: map[string]int{}, Seconds: map[string]float64{}}}
	start := time.Now()
	combined := sha256.New()
	for _, relative := range []string{"cities500.zip", "alternatenames/CN.zip", "admin1CodesASCII.txt", "countryInfo.txt"} {
		f, err := os.Open(filepath.Join(directory, filepath.FromSlash(relative)))
		if err != nil {
			return nil, err
		}
		h := sha256.New()
		_, err = io.Copy(h, f)
		f.Close()
		if err != nil {
			return nil, err
		}
		digest := hex.EncodeToString(h.Sum(nil))
		d.Report.Files[relative] = digest
		fmt.Fprintf(combined, "%s\x00%s\n", relative, digest)
	}
	d.Report.Digest = hex.EncodeToString(combined.Sum(nil))
	d.Report.Seconds["hash"] = time.Since(start).Seconds()
	start = time.Now()
	countries, admins := map[string]reference{}, map[string]reference{}
	if err := readTSV(filepath.Join(directory, "countryInfo.txt"), 19, func(f []string) error {
		id, err := positiveID(f[16])
		if err != nil {
			return err
		}
		if _, exists := countries[f[0]]; exists {
			return fmt.Errorf("duplicate country %s", f[0])
		}
		countries[f[0]] = reference{id, f[4], f[4]}
		return nil
	}); err != nil {
		return nil, err
	}
	if err := readTSV(filepath.Join(directory, "admin1CodesASCII.txt"), 4, func(f []string) error {
		id, err := positiveID(f[3])
		if err != nil {
			return err
		}
		if _, exists := admins[f[0]]; exists {
			return fmt.Errorf("duplicate admin1 %s", f[0])
		}
		admins[f[0]] = reference{id, f[1], f[2]}
		return nil
	}); err != nil {
		return nil, err
	}
	d.Report.Counts["country_reference"] = len(countries)
	d.Report.Counts["admin1_reference"] = len(admins)
	all := map[int64]*Place{}
	countryCenters, adminCenters := map[string]*center{}, map[string]*center{}
	if err := readZIP(filepath.Join(directory, "cities500.zip"), "cities500.txt", 19, func(f []string) error {
		d.Report.Counts["city_source_rows"]++
		population, err := strconv.ParseInt(f[14], 10, 64)
		if err != nil || population < 0 {
			return fmt.Errorf("invalid population %q", f[14])
		}
		seat := f[7] == "PPLC" || f[7] == "PPLA" || f[7] == "PPLA2" || f[7] == "PPLA3" || f[7] == "PPLA4"
		if f[6] != "P" || (population < 500 && !seat) {
			d.Report.Counts["city_filtered"]++
			return nil
		}
		id, err := positiveID(f[0])
		if err != nil {
			return err
		}
		if _, exists := all[id]; exists {
			return fmt.Errorf("duplicate retained geoname ID %d", id)
		}
		latitude, err := strconv.ParseFloat(f[4], 64)
		if err != nil || math.IsNaN(latitude) || math.IsInf(latitude, 0) || latitude < -90 || latitude > 90 {
			return fmt.Errorf("invalid latitude %q", f[4])
		}
		longitude, err := strconv.ParseFloat(f[5], 64)
		if err != nil || math.IsNaN(longitude) || math.IsInf(longitude, 0) || longitude < -180 || longitude > 180 {
			return fmt.Errorf("invalid longitude %q", f[5])
		}
		country, exists := countries[f[8]]
		if !exists {
			return fmt.Errorf("unknown country %q", f[8])
		}
		var modified *time.Time
		if f[18] != "" {
			value, err := time.Parse("2006-01-02", f[18])
			if err != nil {
				return err
			}
			modified = &value
		}
		p := &Place{ID: id, Kind: "city", Canonical: f[1], ASCII: f[2], CountryCode: f[8], CountryName: country.name,
			AdminCode: f[10], Feature: f[7], Longitude: longitude, Latitude: latitude, Population: population,
			Importance: 30, Modified: modified, candidates: map[string]Name{}}
		if p.Canonical == "" {
			return fmt.Errorf("empty canonical name")
		}
		switch f[7] {
		case "PPLC":
			p.Importance = 10
		case "PPLA":
			p.Importance = 15
		case "PPLA2":
			p.Importance = 20
		case "PPLA3", "PPLA4":
			p.Importance = 25
		}
		adminKey := f[8] + "." + f[10]
		if admin, ok := admins[adminKey]; ok {
			p.AdminName = admin.name
		} else {
			d.Report.Counts["cities_without_admin1_reference"]++
		}
		p.addName(f[1], 10)
		p.addName(f[2], 20)
		for _, alias := range strings.Split(f[3], ",") {
			p.addName(alias, 30)
		}
		all[id] = p
		if countryCenters[f[8]] == nil {
			countryCenters[f[8]] = &center{}
		}
		countryCenters[f[8]].add(p)
		if adminCenters[adminKey] == nil {
			adminCenters[adminKey] = &center{}
		}
		adminCenters[adminKey].add(p)
		d.Report.Counts["cities"]++
		return nil
	}); err != nil {
		return nil, err
	}
	addRepresentative := func(ref reference, kind, countryCode, adminCode string, c *center) error {
		if _, exists := all[ref.id]; exists {
			return fmt.Errorf("representative ID collision %d", ref.id)
		}
		lon, lat, err := c.coordinates()
		if err != nil {
			return err
		}
		country := countries[countryCode]
		p := &Place{ID: ref.id, Kind: kind, Canonical: ref.name, ASCII: ref.ascii, CountryCode: countryCode, CountryName: country.name,
			AdminCode: adminCode, Longitude: lon, Latitude: lat, Population: c.population, Importance: 0, candidates: map[string]Name{}}
		if kind == "country" {
			p.Feature = "PCLI"
		} else {
			p.Feature = "ADM1"
			p.AdminName = ref.name
			p.Importance = 5
		}
		p.addName(ref.name, 10)
		p.addName(ref.ascii, 20)
		all[p.ID] = p
		d.Report.Counts[kind]++
		return nil
	}
	for code, ref := range countries {
		c := countryCenters[code]
		if c == nil {
			d.Report.Counts["countries_without_retained_cities"]++
			continue
		}
		if err := addRepresentative(ref, "country", code, "", c); err != nil {
			return nil, err
		}
	}
	for key, ref := range admins {
		c := adminCenters[key]
		if c == nil {
			d.Report.Counts["admins_without_retained_cities"]++
			continue
		}
		split := strings.SplitN(key, ".", 2)
		if len(split) != 2 {
			return nil, fmt.Errorf("invalid admin key %s", key)
		}
		if err := addRepresentative(ref, "admin1", split[0], split[1], c); err != nil {
			return nil, err
		}
	}
	d.Report.Seconds["places_and_representatives"] = time.Since(start).Seconds()
	start = time.Now()
	if err := readZIP(filepath.Join(directory, "alternatenames", "CN.zip"), "CN.txt", 10, func(f []string) error {
		d.Report.Counts["cn_alias_source_rows"]++
		id, err := positiveID(f[1])
		if err != nil {
			return err
		}
		p := all[id]
		if p == nil || p.Kind == "city" {
			d.Report.Counts["cn_alias_outside_country_admin1"]++
			return nil
		}
		if f[2] == "link" || f[2] == "wkdt" || f[2] == "post" {
			d.Report.Counts["cn_alias_non_name"]++
			return nil
		}
		priority := int16(30)
		if f[4] == "1" {
			priority = 10
		}
		if f[7] == "1" {
			priority += 10
		}
		p.addName(f[3], priority)
		d.Report.Counts["cn_alias_matched_rows"]++
		return nil
	}); err != nil {
		return nil, err
	}
	d.Report.Seconds["cn_aliases"] = time.Since(start).Seconds()
	start = time.Now()
	for _, p := range all {
		d.Places = append(d.Places, p)
	}
	sort.Slice(d.Places, func(i, j int) bool { return d.Places[i].ID < d.Places[j].ID })
	for _, p := range d.Places {
		names := make([]Name, 0, len(p.candidates))
		for _, n := range p.candidates {
			names = append(names, n)
		}
		sort.Slice(names, func(i, j int) bool {
			a, b := names[i], names[j]
			ah, bh := hasHan(a.Display), hasHan(b.Display)
			if ah != bh {
				return ah
			}
			if a.Priority != b.Priority {
				return a.Priority < b.Priority
			}
			return a.Normalized < b.Normalized
		})
		d.Report.Counts["names_before_cap"] += len(names)
		if len(names) > 32 {
			d.Report.Counts["names_removed_by_cap"] += len(names) - 32
			names = names[:32]
		}
		if len(names) == 0 {
			return nil, fmt.Errorf("place %d has no searchable name", p.ID)
		}
		d.Names = append(d.Names, names...)
		p.candidates = nil
	}
	d.Report.Counts["places"] = len(d.Places)
	d.Report.Counts["names"] = len(d.Names)
	d.Report.Seconds["name_dedup_and_cap"] = time.Since(start).Seconds()
	return d, nil
}
