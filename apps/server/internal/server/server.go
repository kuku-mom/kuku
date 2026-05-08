package server

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kuku-mom/kuku/packages/contract/gen/go/kuku/ai/v1/aiv1connect"
	"github.com/kuku-mom/kuku/packages/contract/gen/go/kuku/auth/v1/authv1connect"
	"github.com/kuku-mom/kuku/packages/contract/gen/go/kuku/dashboard/v1/dashboardv1connect"
	"github.com/kuku-mom/kuku/packages/contract/gen/go/kuku/sync/v1/syncv1connect"

	"github.com/kuku-mom/kuku/apps/server/internal/ai"
	"github.com/kuku-mom/kuku/apps/server/internal/auth"
	"github.com/kuku-mom/kuku/apps/server/internal/config"
	"github.com/kuku-mom/kuku/apps/server/internal/dashboard"
	"github.com/kuku-mom/kuku/apps/server/internal/database/sqlc"
	"github.com/kuku-mom/kuku/apps/server/internal/middleware"
	syncsvc "github.com/kuku-mom/kuku/apps/server/internal/sync"
)

type Server struct {
	cfg        *config.Config
	log        *slog.Logger
	pool       *pgxpool.Pool
	httpServer *http.Server
}

func New(cfg *config.Config, log *slog.Logger, pool *pgxpool.Pool) *Server {
	return &Server{cfg: cfg, log: log, pool: pool}
}

func (s *Server) Run(ctx context.Context) error {
	queries := sqlc.New(s.pool)
	emailSender, err := auth.NewEmailSender(s.cfg, s.log)
	if err != nil {
		return fmt.Errorf("init email sender: %w", err)
	}
	authService := auth.NewAuthService(s.cfg, s.pool, queries, emailSender, s.log)
	dashboardService := dashboard.NewDashboardService(s.pool, queries)
	syncHandler, err := s.newSyncHandler(queries)
	if err != nil {
		return err
	}
	aiService, err := ai.NewService(s.cfg)
	if err != nil {
		return fmt.Errorf("init ai service: %w", err)
	}

	secureCookie := s.cfg.IsProduction()
	authHandler := auth.NewAuthHandler(authService, s.log, secureCookie)
	oauthHandler := auth.NewOAuthCallbackHandler(s.cfg, authService, s.log, secureCookie)
	dashboardHandler := dashboard.NewDashboardHandler(dashboardService, s.log)
	aiHandler := ai.NewHandler(aiService, dashboardService, s.log)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("OK"))
	})
	mux.HandleFunc("GET /ready", func(w http.ResponseWriter, r *http.Request) {
		if err := s.pool.Ping(r.Context()); err != nil {
			http.Error(w, "database not ready", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("OK"))
	})
	mux.HandleFunc("GET /auth/callback/google", oauthHandler.GoogleCallback)
	mux.HandleFunc("GET /auth/callback/github", oauthHandler.GithubCallback)

	authPath, authHTTPHandler := authv1connect.NewAuthServiceHandler(authHandler)
	mux.Handle(authPath, authHTTPHandler)
	dashboardPath, dashboardHTTPHandler := dashboardv1connect.NewDashboardServiceHandler(dashboardHandler)
	mux.Handle(dashboardPath, dashboardHTTPHandler)
	syncPath, syncHTTPHandler := syncv1connect.NewSyncServiceHandler(syncHandler)
	mux.Handle(syncPath, syncHTTPHandler)
	aiPath, aiHTTPHandler := aiv1connect.NewAIServiceHandler(aiHandler)
	mux.Handle(aiPath, aiHTTPHandler)

	var root http.Handler = mux
	root = middleware.Auth(authService, s.log, secureCookie)(root)
	// Rate limit sits between CORS and Auth: CORS preflights short-circuit
	// before reaching the limiter, but unauthenticated brute-force against
	// the public auth endpoints is throttled before the auth check ever
	// runs.
	root = middleware.RateLimit(s.log)(root)
	root = middleware.CORS(s.cfg.AllowedOrigins)(root)
	root = middleware.Logging(s.log)(root)
	// ClientIP runs before everything that needs an audit-able client IP
	// (Logging, RateLimit, Auth refresh logging). With this in front of
	// Logging, every line we emit references the trusted-proxy-resolved IP
	// instead of the raw RemoteAddr / first-XFF spoof target.
	root = middleware.ClientIP(s.cfg.TrustedProxies)(root)
	root = middleware.Recover(s.log)(root)
	// RequestID sits at the outermost edge so every downstream log line —
	// including Recover's panic record — can tag the same correlation ID.
	// Honors a client/LB-supplied `X-Request-ID` header when present.
	root = middleware.RequestID()(root)

	s.httpServer = &http.Server{
		Addr:              ":" + s.cfg.Port,
		Handler:           root,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       15 * time.Second,
		// WriteTimeout caps how long a slow/stuck client can hold a response
		// goroutine. Must stay >= the longest-running handler; Gemini calls
		// are capped at 120s upstream, so 180s gives a clean margin.
		WriteTimeout: 180 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		s.log.Info("starting server", "port", s.cfg.Port, "env", s.cfg.Env)
		if err := s.httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		return fmt.Errorf("listen: %w", err)
	case <-ctx.Done():
		s.log.Info("shutdown signal received")
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := s.httpServer.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}
	return nil
}

func (s *Server) newSyncHandler(queries *sqlc.Queries) (syncv1connect.SyncServiceHandler, error) {
	if !s.cfg.SyncFeatureEnabled {
		return syncsvc.NewDisabledHandler(), nil
	}
	objectStore, err := syncsvc.NewObjectStore(s.cfg)
	if err != nil {
		return nil, fmt.Errorf("init sync object store: %w", err)
	}
	syncService := syncsvc.NewService(s.pool, queries, s.cfg, objectStore)
	return syncsvc.NewHandler(syncService, s.log), nil
}
