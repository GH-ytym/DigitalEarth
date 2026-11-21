package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"digitalearth.local/gazetteer/internal/workspace"
)

func TestWorkspaceUnavailableKeepsGazetteerHealth(t *testing.T) {
	handler := Handler(Service{Ready: func(context.Context) (Snapshot, error) {
		return Snapshot{Dataset: "test", PlaceCount: 1, NameCount: 1}, nil
	}})
	for _, check := range []struct {
		url    string
		status int
	}{{workspacePrefix + "annotations", 503}, {workspacePrefix + "measurements", 503}, {"/healthz", 200}} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, check.url, nil))
		if response.Code != check.status {
			t.Fatalf("%s: got status %d, want %d", check.url, response.Code, check.status)
		}
	}
}

func TestWorkspaceJSONContract(t *testing.T) {
	const path = workspacePrefix + "annotations"
	mux := http.NewServeMux()
	registerWorkspaceCollection[workspace.Annotation, workspace.AnnotationInput, workspace.AnnotationPatch](
		mux, path, func(context.Context) ([]workspace.Annotation, error) { return nil, nil },
		func(_ context.Context, input workspace.AnnotationInput) (workspace.Annotation, error) {
			return workspace.Annotation{ID: input.ID, Title: input.Title}, nil
		}, nil, nil)
	for _, check := range []struct {
		method      string
		body        string
		contentType string
		status      int
		response    string
	}{
		{http.MethodGet, "", "", 200, `"items":[]`},
		{http.MethodPost, `{"title":"济南"}`, "application/json", 201, `"title":"济南"`},
		{http.MethodPost, `{"title":"济南"} {}`, "application/json", 400, `"invalid_body"`},
		{http.MethodPost, `{"unexpected":true}`, "application/json", 400, `"invalid_body"`},
		{http.MethodPost, `{"title":"济南"}`, "text/plain", 415, `"invalid_content_type"`},
		{http.MethodDelete, "", "", 405, `"method_not_allowed"`},
	} {
		response := httptest.NewRecorder()
		request := httptest.NewRequest(check.method, path, strings.NewReader(check.body))
		request.Header.Set("Content-Type", check.contentType)
		mux.ServeHTTP(response, request)
		if response.Code != check.status || !strings.Contains(response.Body.String(), check.response) {
			t.Errorf("%s %s: got %d %s", check.method, check.body, response.Code, response.Body.String())
		}
	}
}
