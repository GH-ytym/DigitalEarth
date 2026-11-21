package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"mime"
	"net/http"
	"strings"
	"time"

	"digitalearth.local/gazetteer/internal/workspace"
	"github.com/jackc/pgx/v5"
)

const workspacePrefix = "/api/v1/map-workspace/"

func addWorkspaceRoutes(mux *http.ServeMux, store *workspace.Store) {
	if store == nil {
		mux.HandleFunc(workspacePrefix, func(w http.ResponseWriter, r *http.Request) {
			workspaceFailure(w, errors.New("workspace connection not configured"))
		})
		return
	}
	registerWorkspaceCollection(mux, workspacePrefix+"annotations", store.ListAnnotations,
		store.CreateAnnotation, store.UpdateAnnotation, store.DeleteAnnotation)
	registerWorkspaceCollection(mux, workspacePrefix+"measurements", store.ListMeasurements,
		store.CreateMeasurement, store.UpdateMeasurement, store.DeleteMeasurement)
}

func registerWorkspaceCollection[Record, Input, Patch any](mux *http.ServeMux, path string,
	list func(context.Context) ([]Record, error), create func(context.Context, Input) (Record, error),
	update func(context.Context, string, Patch) (Record, error), remove func(context.Context, string) error) {
	mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 4*time.Second)
		defer cancel()
		switch r.Method {
		case http.MethodGet:
			items, err := list(ctx)
			if err != nil {
				workspaceFailure(w, err)
				return
			}
			if items == nil {
				items = []Record{}
			}
			writeJSON(w, http.StatusOK, map[string]any{"items": items})
		case http.MethodPost:
			var input Input
			if !readWorkspaceJSON(w, r, &input) {
				return
			}
			item, err := create(ctx, input)
			if err != nil {
				workspaceFailure(w, err)
				return
			}
			writeJSON(w, http.StatusCreated, item)
		default:
			w.Header().Set("Allow", "GET, POST")
			failure(w, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 GET 和 POST。")
		}
	})
	mux.HandleFunc(path+"/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if !workspace.ValidID(id) {
			failure(w, http.StatusBadRequest, "invalid_input", "成果 ID 无效。")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 4*time.Second)
		defer cancel()
		switch r.Method {
		case http.MethodPatch:
			var input Patch
			if !readWorkspaceJSON(w, r, &input) {
				return
			}
			item, err := update(ctx, id, input)
			if err != nil {
				workspaceFailure(w, err)
				return
			}
			writeJSON(w, http.StatusOK, item)
		case http.MethodDelete:
			if err := remove(ctx, id); err != nil {
				workspaceFailure(w, err)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		default:
			w.Header().Set("Allow", "PATCH, DELETE")
			failure(w, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 PATCH 和 DELETE。")
		}
	})
}

func readWorkspaceJSON(w http.ResponseWriter, r *http.Request, input any) bool {
	contentType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || contentType != "application/json" {
		failure(w, http.StatusUnsupportedMediaType, "invalid_content_type", "请使用 JSON 提交成果。")
		return false
	}
	body := http.MaxBytesReader(w, r.Body, 512<<10)
	defer body.Close()
	decoder := json.NewDecoder(body)
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(input); err == nil {
		if err = decoder.Decode(new(any)); errors.Is(err, io.EOF) {
			return true
		}
	}
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		failure(w, http.StatusRequestEntityTooLarge, "invalid_body", "提交的成果过大。")
	} else {
		failure(w, http.StatusBadRequest, "invalid_body", "提交的成果格式无效。")
	}
	return false
}

func workspaceFailure(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, workspace.ErrInvalid):
		message := strings.TrimPrefix(err.Error(), workspace.ErrInvalid.Error()+": ")
		failure(w, http.StatusBadRequest, "invalid_input", message)
	case errors.Is(err, workspace.ErrConflict):
		failure(w, http.StatusConflict, "id_conflict", "该成果 ID 已用于其他内容。")
	case errors.Is(err, pgx.ErrNoRows):
		failure(w, http.StatusNotFound, "not_found", "成果已不存在。")
	case errors.Is(err, context.DeadlineExceeded):
		failure(w, http.StatusGatewayTimeout, "request_timeout", "成果操作超时，请稍后重试。")
	default:
		log.Print("map workspace unavailable")
		failure(w, http.StatusServiceUnavailable, "workspace_unavailable", "地图成果服务暂不可用，请稍后重试。")
	}
}
