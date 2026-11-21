package workspace

import (
	"context"
	_ "embed"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	DatabaseName = "digitalearth_workspace"
	WriterRole   = "digitalearth_workspace_writer"
)

//go:embed 001_workspace.sql
var initialMigration string

// OpenPool uses the project's existing PostgreSQL host and a separate business role.
func OpenPool(ctx context.Context) (*pgxpool.Pool, error) {
	passwordFile := os.Getenv("WORKSPACE_PASSWORD_FILE")
	if passwordFile == "" {
		return nil, nil
	}
	password, err := readPassword(passwordFile)
	if err != nil {
		return nil, err
	}
	cfg, err := pgxpool.ParseConfig("")
	if err != nil {
		return nil, errors.New("invalid workspace PostgreSQL configuration")
	}
	cfg.ConnConfig.Database = DatabaseName
	cfg.ConnConfig.User = WriterRole
	cfg.ConnConfig.Password = password
	cfg.ConnConfig.ConnectTimeout = 3 * time.Second
	cfg.ConnConfig.RuntimeParams["application_name"] = "digitalearth-workspace"
	cfg.MaxConns = 4
	cfg.MinConns = 0
	cfg.MaxConnIdleTime = 5 * time.Minute
	return pgxpool.NewWithConfig(ctx, cfg)
}

func readPassword(path string) (string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", errors.New("cannot read workspace password file")
	}
	password := strings.TrimSpace(string(raw))
	decoded, err := hex.DecodeString(password)
	if err != nil || len(decoded) != 32 {
		return "", errors.New("workspace password file must contain a generated 32-byte hex password")
	}
	return password, nil
}

// Setup is a manual administration command for new installations and upgrades.
func Setup(ctx context.Context, admin *pgx.Conn, passwordFile string) error {
	password, err := readPassword(passwordFile)
	if err != nil {
		return err
	}
	if _, err := admin.Exec(ctx, "SELECT pg_advisory_lock(746293104862)"); err != nil {
		return err
	}
	defer func() { _, _ = admin.Exec(context.Background(), "SELECT pg_advisory_unlock(746293104862)") }()

	var exists bool
	if err := admin.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1)", WriterRole).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		if _, err := admin.Exec(ctx, "CREATE ROLE "+WriterRole+" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS"); err != nil {
			return err
		}
	}
	if err := admin.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)", DatabaseName).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		if _, err := admin.Exec(ctx, "CREATE DATABASE "+DatabaseName+" TEMPLATE template0"); err != nil {
			return err
		}
	}

	cfg := admin.Config()
	cfg.Database = DatabaseName
	conn, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	return migrate(ctx, conn, password)
}

func migrate(ctx context.Context, conn *pgx.Conn, password string) error {
	tx, err := conn.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	if _, err := tx.Exec(ctx, `CREATE SCHEMA IF NOT EXISTS map_workspace;
        CREATE TABLE IF NOT EXISTS map_workspace.schema_migrations (
            version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
        );`); err != nil {
		return err
	}
	var applied bool
	if err := tx.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM map_workspace.schema_migrations WHERE version = 1)").Scan(&applied); err != nil {
		return err
	}
	if !applied {
		if _, err := tx.Exec(ctx, initialMigration); err != nil {
			return fmt.Errorf("apply workspace migration 1: %w", err)
		}
		if _, err := tx.Exec(ctx, "INSERT INTO map_workspace.schema_migrations (version) VALUES (1)"); err != nil {
			return err
		}
	}
	const privileges = `REVOKE CONNECT, TEMPORARY ON DATABASE digitalearth_workspace FROM PUBLIC;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE digitalearth_workspace TO digitalearth_workspace_writer;
        GRANT USAGE ON SCHEMA map_workspace TO digitalearth_workspace_writer;
        GRANT SELECT, INSERT, UPDATE, DELETE ON map_workspace.annotations, map_workspace.measurements TO digitalearth_workspace_writer;`
	if _, err := tx.Exec(ctx, privileges); err != nil {
		return err
	}
	// The password is generated hex. Do not include the statement or value in errors.
	if _, err := tx.Exec(ctx, "ALTER ROLE "+WriterRole+" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '"+password+"'"); err != nil {
		return errors.New("could not configure workspace writer password")
	}
	return tx.Commit(ctx)
}
