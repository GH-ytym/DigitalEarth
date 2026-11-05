package gazetteer

import (
	"context"
	"encoding/hex"
	"errors"
	"os"
	"strings"

	"github.com/jackc/pgx/v5"
)

// ConfigureReader is an explicit administration operation, never called by serve.
func ConfigureReader(ctx context.Context, conn *pgx.Conn, passwordFile string) error {
	passwordBytes, err := os.ReadFile(passwordFile)
	if err != nil {
		return errors.New("cannot read API password file")
	}
	password := strings.TrimSpace(string(passwordBytes))
	decoded, err := hex.DecodeString(password)
	if err != nil || len(decoded) != 32 {
		return errors.New("API password file must contain a generated 32-byte hex password")
	}
	tx, err := conn.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	var exists bool
	if err = tx.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='digitalearth_reader')").Scan(&exists); err != nil {
		return err
	}
	if !exists {
		if _, err = tx.Exec(ctx, "CREATE ROLE digitalearth_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION"); err != nil {
			return err
		}
	}
	// password is validated hex; do not print the SQL or password.
	if _, err = tx.Exec(ctx, "ALTER ROLE digitalearth_reader WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION PASSWORD '"+password+"'"); err != nil {
		return errors.New("could not configure API role password")
	}
	if _, err = tx.Exec(ctx, "GRANT CONNECT ON DATABASE "+pgx.Identifier{conn.Config().Database}.Sanitize()+" TO digitalearth_reader"); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `GRANT USAGE ON SCHEMA gazetteer TO digitalearth_reader;
        GRANT SELECT ON gazetteer.places,gazetteer.names,gazetteer.snapshot TO digitalearth_reader;
        ALTER ROLE digitalearth_reader SET default_transaction_read_only=on;`); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
