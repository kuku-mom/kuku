package auth

import (
	"context"
	"fmt"
	"log/slog"
	"net/smtp"
	"strings"

	"github.com/kuku-mom/kuku/apps/server/internal/config"
)

type EmailSender interface {
	SendAuthCode(ctx context.Context, to, code string) error
}

type SMTPEmailSender struct {
	cfg *config.Config
	log *slog.Logger
}

func NewEmailSender(cfg *config.Config, log *slog.Logger) EmailSender {
	return &SMTPEmailSender{cfg: cfg, log: log}
}

func (s *SMTPEmailSender) SendAuthCode(ctx context.Context, to, code string) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}

	addr := s.cfg.SMTPAddress()
	from := s.cfg.EmailFromAddress
	subject := "Your Kuku sign-in code"
	body := fmt.Sprintf("Your Kuku sign-in code is %s.\n\nThis code expires in 10 minutes.\n", code)
	message := strings.Join([]string{
		"From: " + s.cfg.EmailFromName + " <" + from + ">",
		"To: " + to,
		"Subject: " + subject,
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=UTF-8",
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
	s.log.Debug("sent email auth code")
	return nil
}
