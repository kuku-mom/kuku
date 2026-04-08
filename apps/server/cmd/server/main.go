package main

import (
	"context"
	"flag"
	"fmt"
	"net/http"
	"os"
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

	cfg := config.Load()
	log := logger.New(&logger.Options{
		Level:  cfg.LogLevel,
		Format: cfg.LogFormat,
		Output: os.Stdout,
	})
	logger.SetDefault(log)

	ctx := context.Background()
	pool, err := database.NewPool(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Error("failed to connect database", "error", err)
		os.Exit(1)
	}
	defer pool.Close()

	if len(os.Args) > 1 && os.Args[1] == "migrate" {
		if err := database.RunMigrations(ctx, pool, "sql/migrations"); err != nil {
			log.Error("failed to run migrations", "error", err)
			os.Exit(1)
		}
		log.Info("migrations applied")
		return
	}

	if cfg.AutoMigration {
		if err := database.RunMigrations(ctx, pool, "sql/migrations"); err != nil {
			log.Error("failed to run migrations", "error", err)
			os.Exit(1)
		}
		log.Info("migrations applied")
	}

	srv := server.New(cfg, log, pool)
	if err := srv.Run(); err != nil {
		log.Error("server stopped with error", "error", err)
		os.Exit(1)
	}
}
