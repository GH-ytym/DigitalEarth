package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"digitalearth.local/gazetteer/internal/gazetteer"
	"digitalearth.local/gazetteer/internal/httpapi"
	"digitalearth.local/gazetteer/internal/workspace"
)

func output(value any, path string) error {
	b, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')
	if path != "" {
		if err = os.WriteFile(path, b, 0644); err != nil {
			return err
		}
	}
	_, err = os.Stdout.Write(b)
	return err
}

func run(ctx context.Context) error {
	if len(os.Args) < 2 {
		return errors.New("usage: gazetteer import|query|verify|setup-reader|setup-workspace|serve|healthcheck [options]")
	}
	command := os.Args[1]
	flags := flag.NewFlagSet(command, flag.ContinueOnError)
	dataDir := flags.String("data", "/data", "GeoNames input directory")
	report := flags.String("report", "", "optional JSON output file")
	query := flags.String("q", "", "place name")
	limit := flags.Int("limit", 6, "result limit (1–10)")
	listen := flags.String("listen", ":8080", "HTTP listen address")
	apiPassword := flags.String("api-password-file", os.Getenv("API_PASSWORD_FILE"), "API role password file")
	workspacePassword := flags.String("workspace-password-file", os.Getenv("WORKSPACE_PASSWORD_FILE"), "workspace role password file")
	if err := flags.Parse(os.Args[2:]); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected positional arguments")
	}
	switch command {
	case "serve":
		return httpapi.Run(ctx, *listen)
	case "healthcheck":
		client := &http.Client{Timeout: 3 * time.Second}
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://127.0.0.1:8080/healthz", nil)
		if err != nil {
			return err
		}
		response, err := client.Do(request)
		if err != nil {
			return errors.New("API is not reachable")
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			return errors.New("API database is not ready")
		}
		return nil
	case "setup-reader":
		conn, err := gazetteer.Connect(ctx)
		if err != nil {
			return err
		}
		defer conn.Close(context.Background())
		if err := gazetteer.ConfigureReader(ctx, conn, *apiPassword); err != nil {
			return err
		}
		fmt.Println("Read-only GeoNames API account configured.")
		return nil
	case "setup-workspace":
		conn, err := gazetteer.Connect(ctx)
		if err != nil {
			return err
		}
		defer conn.Close(context.Background())
		if err := workspace.Setup(ctx, conn, *workspacePassword); err != nil {
			return err
		}
		fmt.Println("Map workspace database and API account ready.")
		return nil
	case "import":
		fmt.Fprintln(os.Stderr, "Reading GeoNames snapshot; source files are unchanged.")
		data, err := gazetteer.Load(*dataDir)
		if err != nil {
			return err
		}
		fmt.Fprintf(os.Stderr, "Prepared %d places and %d names; importing in one transaction.\n", len(data.Places), len(data.Names))
		conn, err := gazetteer.Connect(ctx)
		if err != nil {
			return err
		}
		defer conn.Close(context.Background())
		if err = gazetteer.Import(ctx, conn, data); err != nil {
			return err
		}
		// Database commit has already succeeded if writing this report fails.
		if err = output(data.Report, *report); err != nil {
			return fmt.Errorf("database import committed, but report output failed: %w", err)
		}
		return nil
	case "query":
		conn, err := gazetteer.Connect(ctx)
		if err != nil {
			return err
		}
		defer conn.Close(context.Background())
		start := time.Now()
		results, err := gazetteer.Search(ctx, conn, *query, *limit)
		if err != nil {
			return err
		}
		return output(map[string]any{"query": *query, "results": results, "elapsed_ms": float64(time.Since(start).Microseconds()) / 1000, "attribution": gazetteer.Attribution}, *report)
	case "verify":
		conn, err := gazetteer.Connect(ctx)
		if err != nil {
			return err
		}
		defer conn.Close(context.Background())
		result, err := gazetteer.Verify(ctx, conn)
		if err != nil {
			return err
		}
		return output(result, *report)
	default:
		return fmt.Errorf("unknown command %q", command)
	}
}

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := run(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "gazetteer:", err)
		os.Exit(1)
	}
}
