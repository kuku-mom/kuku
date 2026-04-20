package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/kuku-mom/kuku/apps/server/internal/config"
	"github.com/kuku-mom/kuku/apps/server/internal/database"
	"github.com/kuku-mom/kuku/apps/server/internal/server"
	"github.com/kuku-mom/kuku/apps/server/logger"
)

func runHealthcheck() {
	fs := flag.NewFlagSet("healthcheck", flag.ExitOnError)
	port := fs.String("port", "", "server port")
	_ = fs.Parse(os.Args[2:])
	value := *port
	if value == "" {
		value = os.Getenv("PORT")
	}
	if value == "" {
		value = "8080"
	}
	client := http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get(fmt.Sprintf("http://localhost:%s/health", value))
	if err != nil {
		os.Exit(1)
	}
	defer func() {
		_ = resp.Body.Close()
	}()
	if resp.StatusCode != http.StatusOK {
		os.Exit(1)
	}
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		runHealthcheck()
		return
	}
	if err := run(); err != nil {
		slog.Error("server exited with error", "error", err)
		os.Exit(1)
	}
}

// run wires the server lifecycle so every error path exits via deferred
// cleanup (pool close, signal stop) instead of os.Exit bypassing them.
func run() error {
	cfg := config.Load()
	log := logger.New(&logger.Options{
		Level:  cfg.LogLevel,
		Format: cfg.LogFormat,
		Output: os.Stdout,
	})
	logger.SetDefault(log)

	if err := cfg.Validate(log); err != nil {
		return fmt.Errorf("config validation: %w", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	pool, err := database.NewPool(ctx, cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("connect database: %w", err)
	}
	defer pool.Close()

	if len(os.Args) > 1 && os.Args[1] == "migrate" {
		if err := database.RunMigrations(ctx, pool, "sql/migrations"); err != nil {
			return fmt.Errorf("run migrations: %w", err)
		}
		log.Info("migrations applied")
		return nil
	}

	if cfg.AutoMigration {
		if err := database.RunMigrations(ctx, pool, "sql/migrations"); err != nil {
			return fmt.Errorf("run migrations: %w", err)
		}
		log.Info("migrations applied")
	}

	if err := server.New(cfg, log, pool).Run(ctx); err != nil {
		return fmt.Errorf("server run: %w", err)
	}
	return nil
}
