package config

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
	"time"
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
	cfg := &Config{Env: "production", JWTSecret: "a-real-strong-secret-value-from-env", TrustedProxiesRaw: "10.0.0.0/8"}
	log, buf := newTestLogger()
	if err := cfg.Validate(log); err != nil {
		t.Fatalf("expected nil error with custom secret, got %v", err)
	}
	if buf.Len() != 0 {
		t.Fatalf("expected no warnings, got %q", buf.String())
	}
}

func TestValidate_TrustedProxiesParsesCIDRAndIP(t *testing.T) {
	cfg := &Config{
		Env:               "development",
		JWTSecret:         "dev",
		TrustedProxiesRaw: "10.0.0.0/8, 192.168.1.1, 2001:db8::/32",
	}
	log, _ := newTestLogger()
	if err := cfg.Validate(log); err != nil {
		t.Fatalf("expected nil error, got %v", err)
	}
	if got := len(cfg.TrustedProxies); got != 3 {
		t.Fatalf("expected 3 trusted prefixes, got %d", got)
	}
	// Single-IP entry must promote to /32 so Contains works the same way as
	// CIDR — the rest of the system only checks via Prefix.Contains.
	if bits := cfg.TrustedProxies[1].Bits(); bits != 32 {
		t.Fatalf("expected single IPv4 to become /32, got /%d", bits)
	}
}

func TestValidate_TrustedProxiesRejectsMalformed(t *testing.T) {
	cfg := &Config{
		Env:               "development",
		JWTSecret:         "dev",
		TrustedProxiesRaw: "10.0.0.0/8, not-an-ip",
	}
	log, _ := newTestLogger()
	if err := cfg.Validate(log); err == nil {
		t.Fatal("expected error on malformed entry, got nil")
	}
}

func TestValidate_ProductionWarnsWhenTrustedProxiesEmpty(t *testing.T) {
	cfg := &Config{Env: "production", JWTSecret: "real", TrustedProxiesRaw: ""}
	log, buf := newTestLogger()
	if err := cfg.Validate(log); err != nil {
		t.Fatalf("expected nil error (warn only), got %v", err)
	}
	if !strings.Contains(buf.String(), "TRUSTED_PROXIES is empty") {
		t.Fatalf("expected production warn about empty TRUSTED_PROXIES, got %q", buf.String())
	}
}

func TestValidate_ProductionRejectsCORSWildcard(t *testing.T) {
	cfg := &Config{
		Env:               "production",
		JWTSecret:         "real",
		TrustedProxiesRaw: "10.0.0.0/8",
		AllowedOrigins:    []string{"https://www.kuku.mom", "*"},
	}
	log, _ := newTestLogger()
	if err := cfg.Validate(log); err == nil {
		t.Fatal("expected error when production allowlist contains *, got nil")
	}
}

func TestValidate_DevelopmentAllowsCORSWildcard(t *testing.T) {
	cfg := &Config{
		Env:            "development",
		JWTSecret:      "dev",
		AllowedOrigins: []string{"*"},
	}
	log, _ := newTestLogger()
	if err := cfg.Validate(log); err != nil {
		t.Fatalf("expected dev to accept wildcard for ergonomic local setups, got %v", err)
	}
}

func TestValidate_ProductionRejectsSyncDirectBytesDevRPC(t *testing.T) {
	cfg := &Config{
		Env:                             "production",
		JWTSecret:                       "real",
		TrustedProxiesRaw:               "10.0.0.0/8",
		AllowedOrigins:                  []string{"https://www.kuku.mom"},
		SyncDirectBytesDevEnabled:       true,
		SyncObjectStoreDriver:           "s3_compatible",
		SyncMaxWorkspacesPerUser:        5,
		SyncMaxTotalStorageBytesPerUser: 1073741824,
		SyncMaxStorageBytesPerWorkspace: 536870912,
		SyncMaxSingleBlobBytes:          33554432,
		SyncMaxPendingUploadBytes:       134217728,
		SyncMaxPendingUploadAge:         24 * time.Hour,
	}
	log, _ := newTestLogger()
	if err := cfg.Validate(log); err == nil {
		t.Fatal("expected production to reject direct sync byte RPCs, got nil")
	}
}

func TestValidate_S3CompatibleSyncConfig(t *testing.T) {
	cfg := &Config{
		Env:                             "production",
		JWTSecret:                       "real",
		TrustedProxiesRaw:               "10.0.0.0/8",
		AllowedOrigins:                  []string{"https://www.kuku.mom"},
		SyncFeatureEnabled:              true,
		SyncObjectStoreDriver:           "s3_compatible",
		SyncS3Endpoint:                  "https://example.r2.cloudflarestorage.com",
		SyncS3Region:                    "auto",
		SyncS3Bucket:                    "kuku-sync",
		SyncPresignTTL:                  10 * time.Minute,
		SyncMaxWorkspacesPerUser:        5,
		SyncMaxTotalStorageBytesPerUser: 1073741824,
		SyncMaxStorageBytesPerWorkspace: 536870912,
		SyncMaxSingleBlobBytes:          33554432,
		SyncMaxPendingUploadBytes:       134217728,
		SyncMaxPendingUploadAge:         24 * time.Hour,
	}
	log, _ := newTestLogger()
	if err := cfg.Validate(log); err != nil {
		t.Fatalf("expected valid S3-compatible sync config, got %v", err)
	}
}

func TestValidate_S3CompatibleRequiresEndpoint(t *testing.T) {
	cfg := &Config{
		Env:                             "development",
		JWTSecret:                       "dev",
		SyncObjectStoreDriver:           "s3_compatible",
		SyncS3Region:                    "auto",
		SyncS3Bucket:                    "kuku-sync",
		SyncPresignTTL:                  10 * time.Minute,
		SyncMaxWorkspacesPerUser:        5,
		SyncMaxTotalStorageBytesPerUser: 1073741824,
		SyncMaxStorageBytesPerWorkspace: 536870912,
		SyncMaxSingleBlobBytes:          33554432,
		SyncMaxPendingUploadBytes:       134217728,
		SyncMaxPendingUploadAge:         24 * time.Hour,
	}
	log, _ := newTestLogger()
	if err := cfg.Validate(log); err == nil {
		t.Fatal("expected s3_compatible config to require endpoint, got nil")
	}
}
