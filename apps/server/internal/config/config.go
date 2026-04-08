package config

import (
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/joho/godotenv"
)

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

	EmailProvider    string
	EmailFromAddress string
	EmailFromName    string
	SMTPHost         string
	SMTPPort         string
	SMTPUsername     string
	SMTPPassword     string
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
		JWTSecret:     getEnv("JWT_SECRET", "change-me-in-development"),

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

		EmailProvider:    getEnv("EMAIL_PROVIDER", "smtp"),
		EmailFromAddress: getEnv("EMAIL_FROM_ADDRESS", "noreply@kuku.mom"),
		EmailFromName:    getEnv("EMAIL_FROM_NAME", "kuku"),
		SMTPHost:         getEnv("SMTP_HOST", "localhost"),
		SMTPPort:         getEnv("SMTP_PORT", "1025"),
		SMTPUsername:     getEnv("SMTP_USERNAME", ""),
		SMTPPassword:     getEnv("SMTP_PASSWORD", ""),
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
