package logger

import (
	"io"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/lmittmann/tint"
)

type Options struct {
	Level  string
	Format string
	Output io.Writer
}

func DefaultOptions() *Options {
	return &Options{
		Level:  "info",
		Format: "json",
		Output: os.Stderr,
	}
}

func New(opts *Options) *slog.Logger {
	if opts == nil {
		opts = DefaultOptions()
	}
	if opts.Output == nil {
		opts.Output = os.Stdout
	}

	level := parseLevel(opts.Level)
	handlerOpts := &slog.HandlerOptions{
		Level:     level,
		AddSource: level == slog.LevelDebug,
	}

	var handler slog.Handler
	switch strings.ToLower(opts.Format) {
	case "text":
		handler = slog.NewTextHandler(opts.Output, handlerOpts)
	case "pretty":
		handler = tint.NewHandler(opts.Output, &tint.Options{
			Level:       handlerOpts.Level,
			AddSource:   handlerOpts.AddSource,
			ReplaceAttr: handlerOpts.ReplaceAttr,
			TimeFormat:  time.Kitchen,
		})
	default:
		handler = slog.NewJSONHandler(opts.Output, handlerOpts)
	}

	return slog.New(handler)
}

func SetDefault(log *slog.Logger) {
	slog.SetDefault(log)
}

func parseLevel(level string) slog.Level {
	switch strings.ToLower(level) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}
