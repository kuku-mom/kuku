package config

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
)

func newTestLogger() (*slog.Logger, *bytes.Buffer) {
	buf := &bytes.Buffer{}
	return slog.New(slog.NewTextHandler(buf, &slog.HandlerOptions{Level: slog.LevelDebug})), buf
}

func TestValidate_ProductionRejectsDefaultJWTSecret(t *testing.T) {
	cfg := &Config{Env: "production", JWTSecret: devJWTSecret}
	log, _ := newTestLogger()
	if err := cfg.Validate(log); err == nil {
		t.Fatal("expected error when production uses dev JWT secret, got nil")
	}
}

func TestValidate_ProductionRejectsEmptyJWTSecret(t *testing.T) {
	cfg := &Config{Env: "production", JWTSecret: ""}
	log, _ := newTestLogger()
	if err := cfg.Validate(log); err == nil {
		t.Fatal("expected error when production has empty JWT secret, got nil")
	}
}

func TestValidate_DevelopmentWarnsButPasses(t *testing.T) {
	cfg := &Config{Env: "development", JWTSecret: devJWTSecret}
	log, buf := newTestLogger()
	if err := cfg.Validate(log); err != nil {
		t.Fatalf("expected nil error in development, got %v", err)
	}
	if !strings.Contains(buf.String(), "JWT_SECRET is using the development default") {
		t.Fatalf("expected dev warning in log output, got %q", buf.String())
	}
}

func TestValidate_ProductionAcceptsCustomJWTSecret(t *testing.T) {
	cfg := &Config{Env: "production", JWTSecret: "a-real-strong-secret-value-from-env"}
	log, buf := newTestLogger()
	if err := cfg.Validate(log); err != nil {
		t.Fatalf("expected nil error with custom secret, got %v", err)
	}
	if buf.Len() != 0 {
		t.Fatalf("expected no warnings, got %q", buf.String())
	}
}
