package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"digitalearth.local/gazetteer/internal/gazetteer"
)

func TestQueryContract(t *testing.T) {
	called := false
	handler := Handler(Service{Search: func(ctx context.Context, q string, limit int) ([]gazetteer.Result, error) {
		called = true
		if q != "江西" || limit != 6 {
			t.Fatalf("wrong arguments: %q %d", q, limit)
		}
		return []gazetteer.Result{{ID: 1806222, Name: "江西", Canonical: "Jiangxi", Kind: "admin1", CountryName: "China", Approximate: true}}, nil
	}})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest("GET", "/api/v1/locations?q="+url.QueryEscape("江西"), nil))
	var body Response
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if response.Code != 200 || !called || len(body.Results) != 1 || body.Results[0].ID != 1806222 || body.Attribution == "" {
		t.Fatalf("wrong response: %d %s", response.Code, response.Body.String())
	}
}

func TestInvalidQueriesNeverReachDatabase(t *testing.T) {
	handler := Handler(Service{Search: func(context.Context, string, int) ([]gazetteer.Result, error) {
		t.Fatal("invalid request reached database")
		return nil, nil
	}})
	for _, query := range []string{"", "q=x", "q=%25_", "q=Beijing&limit=11", "q=Beijing&limit=-1", "q=Beijing&limit=no", "q=Beijing&q=Paris", "q=Beijing&limit=6&limit=7", "q=%GG", "q=" + strings.Repeat("a", 101)} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest("GET", "/api/v1/locations?"+query, nil))
		if response.Code != 400 {
			t.Errorf("%s: got %d", query, response.Code)
		}
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest("POST", "/api/v1/locations?q=Beijing", nil))
	if response.Code != 405 || response.Header().Get("Allow") != "GET" {
		t.Fatal("method handling failed")
	}
}

func TestFailureAndEmptyResultsAreDistinct(t *testing.T) {
	for _, test := range []struct {
		name   string
		err    error
		status int
	}{{"empty", nil, 200}, {"timeout", context.DeadlineExceeded, 504}, {"unavailable", errors.New("private database detail password=secret"), 503}} {
		t.Run(test.name, func(t *testing.T) {
			handler := Handler(Service{Search: func(context.Context, string, int) ([]gazetteer.Result, error) { return nil, test.err }})
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest("GET", "/api/v1/locations?q=Beijing", nil))
			if response.Code != test.status || strings.Contains(response.Body.String(), "secret") {
				t.Fatalf("wrong error response: %d %s", response.Code, response.Body.String())
			}
			if test.err == nil && !strings.Contains(response.Body.String(), `"results":[]`) {
				t.Fatal("empty result must be a JSON array")
			}
		})
	}
}

func TestHealthRequiresActiveSnapshot(t *testing.T) {
	for _, test := range []struct {
		snapshot Snapshot
		err      error
		status   int
	}{{Snapshot{}, nil, 503}, {Snapshot{}, errors.New("offline"), 503}, {Snapshot{Dataset: "test", PlaceCount: 2, NameCount: 3}, nil, 200}} {
		handler := Handler(Service{Ready: func(context.Context) (Snapshot, error) { return test.snapshot, test.err }})
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest("GET", "/healthz", nil))
		if response.Code != test.status {
			t.Fatalf("health status %d, want %d", response.Code, test.status)
		}
	}
}
