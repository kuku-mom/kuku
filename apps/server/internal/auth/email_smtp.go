package auth

import (
	"context"
	"fmt"
	"log/slog"
	"net/smtp"
	"strings"

	"github.com/kuku-mom/kuku/apps/server/internal/config"
)

type SMTPEmailSender struct {
	cfg *config.Config
	log *slog.Logger
}

func NewSMTPEmailSender(cfg *config.Config, log *slog.Logger) *SMTPEmailSender {
	return &SMTPEmailSender{cfg: cfg, log: log}
}

func (s *SMTPEmailSender) SendAuthCode(ctx context.Context, to, code string) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}

	body, err := renderOTPEmail(code)
	if err != nil {
		return fmt.Errorf("render otp email: %w", err)
	}

	addr := s.cfg.SMTPAddress()
	from := s.cfg.EmailFromAddress
	message := strings.Join([]string{
		"From: " + s.cfg.EmailFromName + " <" + from + ">",
		"To: " + to,
		"Subject: " + otpEmailSubject,
		"MIME-Version: 1.0",
		"Content-Type: text/html; charset=UTF-8",
		"",
		body,
	}, "\r\n")

	var auth smtp.Auth
	if s.cfg.SMTPUsername != "" || s.cfg.SMTPPassword != "" {
		auth = smtp.PlainAuth("", s.cfg.SMTPUsername, s.cfg.SMTPPassword, s.cfg.SMTPHost)
	}
	if err := smtp.SendMail(addr, auth, from, []string{to}, []byte(message)); err != nil {
		return err
	}
	s.log.Debug("sent email auth code via smtp")
	return nil
}
