package workspace

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"
	"unicode/utf8"
)

const MaxMeasurementVertices = 256

var (
	ErrInvalid  = errors.New("invalid workspace input")
	ErrConflict = errors.New("workspace ID already exists")
)

type Annotation struct {
	ID              string    `json:"id"`
	Title           string    `json:"title"`
	Note            string    `json:"note"`
	Longitude       float64   `json:"longitude"`
	Latitude        float64   `json:"latitude"`
	SourceGeoNameID *int64    `json:"source_geoname_id,omitempty"`
	Visible         bool      `json:"visible"`
	CreatedAt       time.Time `json:"created_at"`
	UpdatedAt       time.Time `json:"updated_at"`
}

type AnnotationInput struct {
	ID              string   `json:"id,omitempty"`
	Title           string   `json:"title"`
	Note            string   `json:"note"`
	Longitude       *float64 `json:"longitude"`
	Latitude        *float64 `json:"latitude"`
	SourceGeoNameID *int64   `json:"source_geoname_id,omitempty"`
	Visible         *bool    `json:"visible,omitempty"`
}

type MetadataPatch struct {
	Title   *string `json:"title"`
	Note    *string `json:"note"`
	Visible *bool   `json:"visible"`
}

type AnnotationPatch struct {
	MetadataPatch
	Longitude       *float64        `json:"longitude"`
	Latitude        *float64        `json:"latitude"`
	SourceGeoNameID json.RawMessage `json:"source_geoname_id"`
}

type Vertex struct {
	Longitude       *float64 `json:"longitude"`
	Latitude        *float64 `json:"latitude"`
	Name            string   `json:"name,omitempty"`
	AnnotationID    string   `json:"annotation_id,omitempty"`
	SourceGeoNameID *int64   `json:"source_geoname_id,omitempty"`
}

type Measurement struct {
	ID            string    `json:"id"`
	Title         string    `json:"title"`
	Note          string    `json:"note"`
	Mode          string    `json:"mode"`
	Vertices      []Vertex  `json:"vertices"`
	SegmentMeters []float64 `json:"segment_meters"`
	TotalMeters   float64   `json:"total_meters"`
	Algorithm     string    `json:"algorithm"`
	Visible       bool      `json:"visible"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

type MeasurementInput struct {
	ID       string   `json:"id,omitempty"`
	Title    string   `json:"title"`
	Note     string   `json:"note"`
	Mode     string   `json:"mode"`
	Vertices []Vertex `json:"vertices"`
	Visible  *bool    `json:"visible,omitempty"`
}

func ValidID(id string) bool {
	if len(id) != 36 || id[8] != '-' || id[13] != '-' || id[18] != '-' || id[23] != '-' {
		return false
	}
	decoded, err := hex.DecodeString(strings.ReplaceAll(id, "-", ""))
	return err == nil && len(decoded) == 16
}

func checkText(value string, min, max int) bool {
	length := utf8.RuneCountInString(value)
	return length >= min && length <= max && !strings.ContainsRune(value, 0)
}

func normalizeMetadata(title, note *string) error {
	if title != nil {
		*title = strings.TrimSpace(*title)
		if !checkText(*title, 1, 120) {
			return fmt.Errorf("%w: 名称应为 1 至 120 个字符。", ErrInvalid)
		}
	}
	if note != nil {
		*note = strings.TrimSpace(*note)
		if !checkText(*note, 0, 2000) {
			return fmt.Errorf("%w: 备注最多 2000 个字符。", ErrInvalid)
		}
	}
	return nil
}

func checkPosition(longitude, latitude *float64) error {
	if longitude == nil || latitude == nil || math.IsNaN(*longitude) || math.IsNaN(*latitude) ||
		*longitude < -180 || *longitude > 180 || *latitude < -90 || *latitude > 90 {
		return fmt.Errorf("%w: 请同时提供有效的经度和纬度。", ErrInvalid)
	}
	return nil
}

func checkSource(id *int64) error {
	if id != nil && (*id < 1 || *id > 9007199254740991) {
		return fmt.Errorf("%w: 地名来源 ID 无效。", ErrInvalid)
	}
	return nil
}

func normalizeNew(id *string, visible **bool, title, note *string) error {
	if *id != "" && !ValidID(*id) {
		return fmt.Errorf("%w: 成果 ID 无效。", ErrInvalid)
	}
	*id = strings.ToLower(*id)
	if *visible == nil {
		defaultVisible := true
		*visible = &defaultVisible
	}
	return normalizeMetadata(title, note)
}

func (input *AnnotationInput) normalize() error {
	if err := normalizeNew(&input.ID, &input.Visible, &input.Title, &input.Note); err != nil {
		return err
	}
	if err := checkPosition(input.Longitude, input.Latitude); err != nil {
		return err
	}
	return checkSource(input.SourceGeoNameID)
}

func (input *AnnotationPatch) normalize() (*int64, error) {
	if err := normalizeMetadata(input.Title, input.Note); err != nil {
		return nil, err
	}
	if input.Longitude != nil || input.Latitude != nil {
		if err := checkPosition(input.Longitude, input.Latitude); err != nil {
			return nil, err
		}
	}
	if input.Title == nil && input.Note == nil && input.Visible == nil && input.Longitude == nil && input.SourceGeoNameID == nil {
		return nil, fmt.Errorf("%w: 请提供需要修改的字段。", ErrInvalid)
	}
	var source *int64
	if input.SourceGeoNameID != nil {
		if err := json.Unmarshal(input.SourceGeoNameID, &source); err != nil {
			return nil, fmt.Errorf("%w: 地名来源 ID 无效。", ErrInvalid)
		}
	}
	return source, checkSource(source)
}

func (input *MeasurementInput) normalize() error {
	if err := normalizeNew(&input.ID, &input.Visible, &input.Title, &input.Note); err != nil {
		return err
	}
	if input.Mode != "straight" && input.Mode != "polyline" {
		return fmt.Errorf("%w: 请选择直线或折线测量。", ErrInvalid)
	}
	n := len(input.Vertices)
	if n < 2 || n > MaxMeasurementVertices || (input.Mode == "straight" && n != 2) {
		return fmt.Errorf("%w: 直线需要恰好两个点，折线需要 2 至 %d 个点。", ErrInvalid, MaxMeasurementVertices)
	}
	for i := range input.Vertices {
		point := &input.Vertices[i]
		if err := checkPosition(point.Longitude, point.Latitude); err != nil {
			return err
		}
		point.Name = strings.TrimSpace(point.Name)
		if !checkText(point.Name, 0, 120) || (point.AnnotationID != "" && !ValidID(point.AnnotationID)) {
			return fmt.Errorf("%w: 测量点名称或标注来源无效。", ErrInvalid)
		}
		point.AnnotationID = strings.ToLower(point.AnnotationID)
		if err := checkSource(point.SourceGeoNameID); err != nil {
			return err
		}
		if i > 0 {
			previous := input.Vertices[i-1]
			if *point.Longitude == *previous.Longitude && *point.Latitude == *previous.Latitude {
				return fmt.Errorf("%w: 相邻测量点需要位于不同位置。", ErrInvalid)
			}
		}
	}
	return nil
}
