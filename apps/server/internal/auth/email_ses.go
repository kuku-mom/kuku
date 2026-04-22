package auth

import (
	"context"
	"fmt"
	"log/slog"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/sesv2"
	"github.com/aws/aws-sdk-go-v2/service/sesv2/types"

	"github.com/kuku-mom/kuku/apps/server/internal/config"
)

type SESEmailSender struct {
	cfg    *config.Config
	log    *slog.Logger
	client *sesv2.Client
}

// NewSESEmailSender resolves AWS credentials through the SDK's default
// provider chain — env vars (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY),
// shared config files, or the container/EC2 instance role — so the
// server process never has to know where the creds came from. The only
// SES-specific input we accept is AWS_REGION.
func NewSESEmailSender(cfg *config.Config, log *slog.Logger) (*SESEmailSender, error) {
	awsCfg, err := awsconfig.LoadDefaultConfig(context.Background(),
		awsconfig.WithRegion(cfg.AWSRegion),
	)
	if err != nil {
		return nil, fmt.Errorf("load aws config: %w", err)
	}
	return &SESEmailSender{
		cfg:    cfg,
		log:    log,
		client: sesv2.NewFromConfig(awsCfg),
	}, nil
}

func (s *SESEmailSender) SendAuthCode(ctx context.Context, to, code string) error {
	body, err := renderOTPEmail(code)
	if err != nil {
		return fmt.Errorf("render otp email: %w", err)
	}
	subject := otpEmailSubject
	from := fmt.Sprintf("%s <%s>", s.cfg.EmailFromName, s.cfg.EmailFromAddress)
	charset := "UTF-8"

	_, err = s.client.SendEmail(ctx, &sesv2.SendEmailInput{
		FromEmailAddress: &from,
		Destination: &types.Destination{
			ToAddresses: []string{to},
		},
		Content: &types.EmailContent{
			Simple: &types.Message{
				Subject: &types.Content{Data: &subject, Charset: &charset},
				Body: &types.Body{
					Html: &types.Content{Data: &body, Charset: &charset},
				},
			},
		},
	})
	if err != nil {
		s.log.Error("ses send email failed", "to", to, "error", err)
		return fmt.Errorf("ses send email: %w", err)
	}
	s.log.Debug("sent email auth code via ses", "to", to)
	return nil
}
