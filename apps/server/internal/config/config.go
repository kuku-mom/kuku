package config

import (
	"errors"
	"fmt"
	"log/slog"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/joho/godotenv"
)

// devJWTSecret is the placeholder value Load() falls back to when JWT_SECRET
// is unset. Surfaced as a constant so Validate() can detect it explicitly —
// any production deploy still using this string can forge arbitrary tokens.
const devJWTSecret = "change-me-in-development"

type Config struct {
	Port string
	Env  string

	LogLevel  string
	LogFormat string

	DatabaseURL   string
	JWTSecret     string
	AutoMigration bool

	GoogleClientID     string
	GoogleClientSecret string
	GoogleRedirectURL  string

	GitHubClientID     string
	GitHubClientSecret string
	GitHubRedirectURL  string

	ClientSuccessURL string
	ClientErrorURL   string
	ClientWebURL     string

	SessionMaxAge     time.Duration
	SessionInactivity time.Duration

	AllowedOrigins []string

	// TrustedProxiesRaw is the comma-separated list from the
	// `TRUSTED_PROXIES` env var (CIDR or single IP). Validate() parses it
	// into TrustedProxies. Leave empty when running with no proxy in front
	// of the server — `X-Forwarded-For` / `X-Real-IP` will then be ignored
	// to prevent client-side IP spoofing.
	TrustedProxiesRaw string
	TrustedProxies    []netip.Prefix

	EmailProvider    string
	EmailFromAddress string
	EmailFromName    string
	SMTPHost         string
	SMTPPort         string
	SMTPUsername     string
	SMTPPassword     string
	// AWSRegion is consumed by the SES email provider; AWS credentials
	// themselves come from the SDK's default chain (env vars, shared
	// config, or container/EC2 instance role) so they never touch the
	// process config.
	AWSRegion string

	GeminiAPIKey string

	SyncFeatureEnabled              bool
	SyncObjectStoreDriver           string
	SyncLocalObjectDir              string
	SyncS3Endpoint                  string
	SyncS3Region                    string
	SyncS3Bucket                    string
	SyncS3AccessKeyID               string
	SyncS3SecretAccessKey           string
	SyncS3ForcePathStyle            bool
	SyncPresignTTL                  time.Duration
	SyncDirectBytesDevEnabled       bool
	SyncMaxWorkspacesPerUser        int32
	SyncMaxTotalStorageBytesPerUser int64
	SyncMaxStorageBytesPerWorkspace int64
	SyncMaxSingleBlobBytes          int64
	SyncMaxPendingUploadBytes       int64
	SyncMaxPendingUploadAge         time.Duration
}

func Load() *Config {
	loadEnv()

	env := getEnv("ENV", "development")

	return &Config{
		Port: getEnv("PORT", "8080"),
		Env:  env,

		LogLevel:  getEnv("LOG_LEVEL", "info"),
		LogFormat: getEnv("LOG_FORMAT", defaultLogFormat(env)),

		DatabaseURL:   getEnv("DATABASE_URL", ""),
		AutoMigration: parseBool(getEnv("AUTO_MIGRATION", "")),
		JWTSecret:     getEnv("JWT_SECRET", devJWTSecret),

		GoogleClientID:     getEnv("GOOGLE_CLIENT_ID", ""),
		GoogleClientSecret: getEnv("GOOGLE_CLIENT_SECRET", ""),
		GoogleRedirectURL:  getEnv("GOOGLE_REDIRECT_URL", "http://localhost:8080/auth/callback/google"),

		GitHubClientID:     getEnv("GITHUB_CLIENT_ID", ""),
		GitHubClientSecret: getEnv("GITHUB_CLIENT_SECRET", ""),
		GitHubRedirectURL:  getEnv("GITHUB_REDIRECT_URL", "http://localhost:8080/auth/callback/github"),

		ClientSuccessURL: getEnv("CLIENT_SUCCESS_URL", "http://localhost:4321/auth/done?success=true"),
		ClientErrorURL:   getEnv("CLIENT_ERROR_URL", "http://localhost:4321/auth/done"),
		ClientWebURL:     getEnv("CLIENT_WEB_URL", "http://localhost:4321"),

		SessionMaxAge:     parseDuration(getEnv("SESSION_MAX_AGE", "720h")),
		SessionInactivity: parseDuration(getEnv("SESSION_INACTIVITY", "336h")),

		AllowedOrigins: parseCSV(getEnv("ALLOWED_ORIGINS", "http://localhost:4321,http://localhost:3000")),

		TrustedProxiesRaw: getEnv("TRUSTED_PROXIES", ""),

		EmailProvider:    getEnv("EMAIL_PROVIDER", "smtp"),
		EmailFromAddress: getEnv("EMAIL_FROM_ADDRESS", "noreply@kuku.mom"),
		EmailFromName:    getEnv("EMAIL_FROM_NAME", "kuku"),
		SMTPHost:         getEnv("SMTP_HOST", "localhost"),
		SMTPPort:         getEnv("SMTP_PORT", "1025"),
		SMTPUsername:     getEnv("SMTP_USERNAME", ""),
		SMTPPassword:     getEnv("SMTP_PASSWORD", ""),
		AWSRegion:        getEnv("AWS_REGION", "us-east-1"),

		GeminiAPIKey: getEnv("GEMINI_API_KEY", ""),

		SyncFeatureEnabled:              parseBool(getEnv("SYNC_FEATURE_ENABLED", "")),
		SyncObjectStoreDriver:           getEnv("SYNC_OBJECT_STORE_DRIVER", "local"),
		SyncLocalObjectDir:              getEnv("SYNC_LOCAL_OBJECT_DIR", ".data/sync-objects"),
		SyncS3Endpoint:                  getEnv("SYNC_S3_ENDPOINT", ""),
		SyncS3Region:                    getEnv("SYNC_S3_REGION", getEnv("AWS_REGION", "us-east-1")),
		SyncS3Bucket:                    getEnv("SYNC_S3_BUCKET", ""),
		SyncS3AccessKeyID:               getEnv("SYNC_S3_ACCESS_KEY_ID", ""),
		SyncS3SecretAccessKey:           getEnv("SYNC_S3_SECRET_ACCESS_KEY", ""),
		SyncS3ForcePathStyle:            parseBool(getEnv("SYNC_S3_FORCE_PATH_STYLE", "")),
		SyncPresignTTL:                  parseDuration(getEnv("SYNC_PRESIGN_TTL", "10m")),
		SyncDirectBytesDevEnabled:       parseBool(getEnv("SYNC_DIRECT_BYTES_DEV_ENABLED", defaultSyncDirectBytesDevEnabled(env))),
		SyncMaxWorkspacesPerUser:        int32(parseInt64(getEnv("SYNC_MAX_WORKSPACES_PER_USER", "5"), 5)),
		SyncMaxTotalStorageBytesPerUser: parseInt64(getEnv("SYNC_MAX_TOTAL_STORAGE_BYTES_PER_USER", "1073741824"), 1073741824),
		SyncMaxStorageBytesPerWorkspace: parseInt64(getEnv("SYNC_MAX_STORAGE_BYTES_PER_WORKSPACE", "536870912"), 536870912),
		SyncMaxSingleBlobBytes:          parseInt64(getEnv("SYNC_MAX_SINGLE_BLOB_BYTES", "33554432"), 33554432),
		SyncMaxPendingUploadBytes:       parseInt64(getEnv("SYNC_MAX_PENDING_UPLOAD_BYTES_PER_WORKSPACE", "134217728"), 134217728),
		SyncMaxPendingUploadAge:         parseDuration(getEnv("SYNC_MAX_PENDING_UPLOAD_AGE", "24h")),
	}
}

func defaultLogFormat(env string) string {
	if env == "development" {
		return "pretty"
	}
	return "json"
}

func loadEnv() {
	if envPath := os.Getenv("ENV_PATH"); envPath != "" {
		if err := godotenv.Load(envPath); err == nil {
			return
		}
	}
	_ = godotenv.Load()
}

// Validate fails fast on misconfigurations that would leave the server in a
// dangerous state. In production, missing/default secrets are fatal; in
// development they downgrade to a warning so local workflows still run.
//
// On success, parsed/derived fields like TrustedProxies are populated.
func (c *Config) Validate(log *slog.Logger) error {
	c.applySyncDefaults()

	if c.JWTSecret == "" || c.JWTSecret == devJWTSecret {
		if c.IsProduction() {
			return errors.New("JWT_SECRET must be set to a non-default value in production")
		}
		log.Warn("JWT_SECRET is using the development default — set a strong random value before deploying")
	}

	prefixes, err := parseTrustedProxies(c.TrustedProxiesRaw)
	if err != nil {
		return fmt.Errorf("TRUSTED_PROXIES parse failed: %w", err)
	}
	c.TrustedProxies = prefixes
	if len(prefixes) == 0 && c.IsProduction() {
		// Not fatal — the server may be exposed directly. But behind any
		// LB / reverse proxy this means the client IP we record is the
		// proxy's, breaking rate limiting and audit logs.
		log.Warn("TRUSTED_PROXIES is empty — X-Forwarded-For / X-Real-IP will be ignored. Set this if running behind a load balancer or reverse proxy")
	}

	// CORS wildcard with `Access-Control-Allow-Credentials: true` (which the
	// CORS middleware sets) is a hard browser-spec violation that effectively
	// disables CSRF protection. Refuse to start if someone copy-pastes `*`
	// into a production allowlist.
	for _, origin := range c.AllowedOrigins {
		if origin == "*" && c.IsProduction() {
			return errors.New("ALLOWED_ORIGINS=* is not permitted in production — list explicit origins")
		}
	}
	if c.SyncDirectBytesDevEnabled && c.IsProduction() {
		return errors.New("SYNC_DIRECT_BYTES_DEV_ENABLED is not permitted in production")
	}
	switch c.SyncObjectStoreDriver {
	case "local", "s3", "s3_compatible":
	default:
		return fmt.Errorf("SYNC_OBJECT_STORE_DRIVER must be local, s3, or s3_compatible")
	}
	if c.SyncFeatureEnabled && c.IsProduction() && c.SyncObjectStoreDriver == "local" {
		return errors.New("SYNC_OBJECT_STORE_DRIVER=local is not permitted for enabled production sync")
	}
	if c.SyncObjectStoreDriver == "s3" || c.SyncObjectStoreDriver == "s3_compatible" {
		if strings.TrimSpace(c.SyncS3Bucket) == "" {
			return errors.New("SYNC_S3_BUCKET must be set when using S3 sync object storage")
		}
		if strings.TrimSpace(c.SyncS3Region) == "" {
			return errors.New("SYNC_S3_REGION must be set when using S3 sync object storage")
		}
		if c.SyncObjectStoreDriver == "s3_compatible" && strings.TrimSpace(c.SyncS3Endpoint) == "" {
			return errors.New("SYNC_S3_ENDPOINT must be set when using s3_compatible sync object storage")
		}
		if (c.SyncS3AccessKeyID == "") != (c.SyncS3SecretAccessKey == "") {
			return errors.New("SYNC_S3_ACCESS_KEY_ID and SYNC_S3_SECRET_ACCESS_KEY must be set together")
		}
	}
	if c.SyncMaxWorkspacesPerUser <= 0 {
		return errors.New("SYNC_MAX_WORKSPACES_PER_USER must be positive")
	}
	if c.SyncMaxTotalStorageBytesPerUser <= 0 ||
		c.SyncMaxStorageBytesPerWorkspace <= 0 ||
		c.SyncMaxSingleBlobBytes <= 0 ||
		c.SyncMaxPendingUploadBytes <= 0 ||
		c.SyncMaxPendingUploadAge <= 0 ||
		c.SyncPresignTTL <= 0 {
		return errors.New("sync quota limits must be positive")
	}
	return nil
}

func (c *Config) applySyncDefaults() {
	if c.SyncObjectStoreDriver == "" {
		c.SyncObjectStoreDriver = "local"
	}
	if c.SyncLocalObjectDir == "" {
		c.SyncLocalObjectDir = ".data/sync-objects"
	}
	if c.SyncS3Region == "" {
		c.SyncS3Region = c.AWSRegion
		if c.SyncS3Region == "" {
			c.SyncS3Region = "us-east-1"
		}
	}
	if c.SyncPresignTTL == 0 {
		c.SyncPresignTTL = 10 * time.Minute
	}
	if c.SyncMaxWorkspacesPerUser == 0 {
		c.SyncMaxWorkspacesPerUser = 5
	}
	if c.SyncMaxTotalStorageBytesPerUser == 0 {
		c.SyncMaxTotalStorageBytesPerUser = 1073741824
	}
	if c.SyncMaxStorageBytesPerWorkspace == 0 {
		c.SyncMaxStorageBytesPerWorkspace = 536870912
	}
	if c.SyncMaxSingleBlobBytes == 0 {
		c.SyncMaxSingleBlobBytes = 33554432
	}
	if c.SyncMaxPendingUploadBytes == 0 {
		c.SyncMaxPendingUploadBytes = 134217728
	}
	if c.SyncMaxPendingUploadAge == 0 {
		c.SyncMaxPendingUploadAge = 24 * time.Hour
	}
}

// parseTrustedProxies turns the CSV input into prefixes. Accepts either CIDR
// (`10.0.0.0/8`) or single IP (`1.2.3.4`, treated as /32 or /128). Empty
// entries skipped. Any malformed entry is fatal so a typo doesn't silently
// open up the spoofing window the trust list is supposed to close.
func parseTrustedProxies(raw string) ([]netip.Prefix, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	out := make([]netip.Prefix, 0)
	for _, entry := range parseCSV(raw) {
		if pref, err := netip.ParsePrefix(entry); err == nil {
			out = append(out, pref)
			continue
		}
		addr, err := netip.ParseAddr(entry)
		if err != nil {
			return nil, fmt.Errorf("invalid entry %q: must be CIDR or IP", entry)
		}
		bits := 32
		if addr.Is6() {
			bits = 128
		}
		out = append(out, netip.PrefixFrom(addr, bits))
	}
	return out, nil
}

func (c *Config) IsProduction() bool {
	return c.Env == "production"
}

func (c *Config) IsDevelopment() bool {
	return c.Env == "development"
}

func (c *Config) SMTPAddress() string {
	port := c.SMTPPort
	if _, err := strconv.Atoi(port); err != nil || port == "" {
		port = "1025"
	}
	return c.SMTPHost + ":" + port
}

func getEnv(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func parseDuration(value string) time.Duration {
	duration, err := time.ParseDuration(value)
	if err != nil {
		return 24 * time.Hour
	}
	return duration
}

func parseBool(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes", "y", "on":
		return true
	default:
		return false
	}
}

func defaultSyncDirectBytesDevEnabled(env string) string {
	if env == "production" {
		return "false"
	}
	return "true"
}

func parseInt64(value string, fallback int64) int64 {
	parsed, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
	if err != nil {
		return fallback
	}
	return parsed
}

func parseCSV(value string) []string {
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}
