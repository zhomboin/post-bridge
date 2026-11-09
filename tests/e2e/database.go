package main

import (
	"context"
	"fmt"
	"os"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "端到端隔离数据库操作失败")
		os.Exit(1)
	}
}
func run() error {
	if len(os.Args) != 3 || !regexp.MustCompile("^e2e_[a-f0-9]{24}$").MatchString(os.Args[2]) {
		return fmt.Errorf("invalid schema")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		return err
	}
	defer pool.Close()
	name := pgx.Identifier{os.Args[2]}.Sanitize()
	var sql string
	switch os.Args[1] {
	case "create":
		sql = "CREATE SCHEMA " + name
	case "drop":
		sql = "DROP SCHEMA IF EXISTS " + name + " CASCADE"
	default:
		return fmt.Errorf("invalid action")
	}
	_, err = pool.Exec(ctx, sql)
	return err
}
