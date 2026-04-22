package auth

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/kuku-mom/kuku/apps/server/internal/config"
)

type EmailSender interface {
	SendAuthCode(ctx context.Context, to, code string) error
}

// NewEmailSender dispatches on EMAIL_PROVIDER. SES and SMTP are the only
// supported values; anything else is a fatal misconfiguration because
// auth flows silently breaking in prod is worse than failing to boot.
func NewEmailSender(cfg *config.Config, log *slog.Logger) (EmailSender, error) {
	switch cfg.EmailProvider {
	case "ses":
		return NewSESEmailSender(cfg, log)
	case "smtp":
		return NewSMTPEmailSender(cfg, log), nil
	default:
		return nil, fmt.Errorf("unknown email provider %q (want \"smtp\" or \"ses\")", cfg.EmailProvider)
	}
}
