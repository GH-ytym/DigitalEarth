package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"digitalearth.local/gazetteer/internal/gazetteer"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Snapshot struct {
	Dataset    string `json:"dataset"`
	PlaceCount int    `json:"place_count"`
	NameCount  int    `json:"name_count"`
}

type Service struct {
	Search func(context.Context, string, int) ([]gazetteer.Result, error)
	Ready  func(context.Context) (Snapshot, error)
}

type Response struct {
	Query       string             `json:"query"`
	Results     []gazetteer.Result `json:"results"`
	Attribution string             `json:"attribution"`
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func failure(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}

func Handler(service Service) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/locations", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			failure(w, 405, "method_not_allowed", "仅支持 GET 查询。")
			return
		}
		values, err := httpParseQuery(r)
		if err != nil {
			failure(w, 400, "invalid_query", "请输入 2–100 个有效字符，结果数量应为 1–10。")
			return
		}
		results, err := service.Search(r.Context(), values.query, values.limit)
		if err != nil {
			if r.Context().Err() != nil {
				return
			}
			if errors.Is(err, gazetteer.ErrInvalidSearch) {
				failure(w, 400, "invalid_query", "请输入 2–100 个有效字符，结果数量应为 1–10。")
				return
			}
			if errors.Is(err, context.DeadlineExceeded) {
				failure(w, 504, "query_timeout", "查询超时，请稍后重试。")
				return
			}
			log.Print("location search unavailable")
			failure(w, 503, "service_unavailable", "地名查询服务暂不可用，请稍后重试。")
			return
		}
		if results == nil {
			results = []gazetteer.Result{}
		}
		writeJSON(w, 200, Response{values.query, results, gazetteer.Attribution})
	})
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			failure(w, 405, "method_not_allowed", "仅支持 GET。")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		snapshot, err := service.Ready(ctx)
		if err != nil || snapshot.PlaceCount <= 0 || snapshot.NameCount <= 0 {
			failure(w, 503, "not_ready", "地名数据库尚未就绪。")
			return
		}
		writeJSON(w, 200, map[string]any{"status": "ok", "snapshot": snapshot})
	})
	return mux
}

type parameters struct {
	query string
	limit int
}

func httpParseQuery(r *http.Request) (parameters, error) {
	// Bound untrusted input before Unicode normalization and reject ambiguous keys.
	if len(r.URL.RawQuery) > 4096 {
		return parameters{}, errors.New("query too large")
	}
	values, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return parameters{}, err
	}
	if len(values["q"]) != 1 || len(values["limit"]) > 1 {
		return parameters{}, errors.New("duplicate or missing parameter")
	}
	query := strings.TrimSpace(values.Get("q"))
	limit := 6
	if text := values.Get("limit"); text != "" {
		limit, err = strconv.Atoi(text)
		if err != nil {
			return parameters{}, err
		}
	}
	if _, err = gazetteer.ValidateSearch(query, limit); err != nil {
		return parameters{}, err
	}
	return parameters{query, limit}, nil
}

func Run(ctx context.Context, address string) error {
	pool, err := gazetteer.ConnectPool(ctx)
	if err != nil {
		return err
	}
	defer pool.Close()
	service := Service{
		Search: func(ctx context.Context, q string, limit int) ([]gazetteer.Result, error) {
			return gazetteer.Search(ctx, pool, q, limit)
		},
		Ready: func(ctx context.Context) (Snapshot, error) { return ready(ctx, pool) },
	}
	server := &http.Server{Addr: address, Handler: Handler(service), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 * 1024}
	stopped := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = server.Shutdown(shutdown)
		case <-stopped:
		}
	}()
	log.Printf("GeoNames HTTP service listening on %s", address)
	err = server.ListenAndServe()
	close(stopped)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func ready(ctx context.Context, pool *pgxpool.Pool) (Snapshot, error) {
	var s Snapshot
	err := pool.QueryRow(ctx, "SELECT dataset,place_count,name_count FROM gazetteer.snapshot WHERE singleton").Scan(&s.Dataset, &s.PlaceCount, &s.NameCount)
	return s, err
}
