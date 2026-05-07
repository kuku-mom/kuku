package sync

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/smithy-go"

	serverconfig "github.com/kuku-mom/kuku/apps/server/internal/config"
	"github.com/kuku-mom/kuku/apps/server/internal/database/sqlc"
)

const s3CiphertextSHA256MetadataKey = "kuku-sha256"

type S3ObjectStore struct {
	client    *s3.Client
	presigner *s3.PresignClient
	bucket    string
}

func NewS3ObjectStore(ctx context.Context, cfg *serverconfig.Config) (*S3ObjectStore, error) {
	bucket := strings.TrimSpace(cfg.SyncS3Bucket)
	if bucket == "" {
		return nil, ErrInvalidArgument
	}
	loadOptions := []func(*awsconfig.LoadOptions) error{
		awsconfig.WithRegion(cfg.SyncS3Region),
	}
	if cfg.SyncS3AccessKeyID != "" || cfg.SyncS3SecretAccessKey != "" {
		loadOptions = append(loadOptions, awsconfig.WithCredentialsProvider(
			credentials.NewStaticCredentialsProvider(cfg.SyncS3AccessKeyID, cfg.SyncS3SecretAccessKey, ""),
		))
	}
	awsCfg, err := awsconfig.LoadDefaultConfig(ctx, loadOptions...)
	if err != nil {
		return nil, err
	}
	client := s3.NewFromConfig(awsCfg, func(options *s3.Options) {
		if endpoint := strings.TrimSpace(cfg.SyncS3Endpoint); endpoint != "" {
			options.BaseEndpoint = aws.String(strings.TrimRight(endpoint, "/"))
		}
		options.UsePathStyle = cfg.SyncS3ForcePathStyle
	})
	return &S3ObjectStore{
		client:    client,
		presigner: s3.NewPresignClient(client),
		bucket:    bucket,
	}, nil
}

func (s *S3ObjectStore) Provider() sqlc.KukuSyncStorageProvider {
	return sqlc.KukuSyncStorageProviderS3Compatible
}

func (s *S3ObjectStore) Put(context.Context, string, []byte) error {
	return ErrDevBytesDisabled
}

func (s *S3ObjectStore) Get(context.Context, string) ([]byte, error) {
	return nil, ErrDevBytesDisabled
}

func (s *S3ObjectStore) Delete(ctx context.Context, storageKey string) error {
	_, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(storageKey),
	})
	return err
}

func (s *S3ObjectStore) PresignPut(ctx context.Context, storageKey, ciphertextSHA256 string, sizeBytes int64, ttl time.Duration) (PresignedObjectURL, error) {
	expiresAt := time.Now().UTC().Add(ttl)
	result, err := s.presigner.PresignPutObject(ctx, &s3.PutObjectInput{
		Bucket:        aws.String(s.bucket),
		Key:           aws.String(storageKey),
		ContentLength: aws.Int64(sizeBytes),
		ContentType:   aws.String(EncryptedObjectContentType),
		Metadata: map[string]string{
			s3CiphertextSHA256MetadataKey: ciphertextSHA256,
		},
	}, s3.WithPresignExpires(ttl))
	if err != nil {
		return PresignedObjectURL{}, err
	}
	headers := signedHeaders(result.SignedHeader)
	headers["Content-Type"] = EncryptedObjectContentType
	headers["X-Amz-Meta-Kuku-Sha256"] = ciphertextSHA256
	return PresignedObjectURL{
		URL:             result.URL,
		RequiredHeaders: headers,
		ExpiresAt:       expiresAt,
	}, nil
}

func (s *S3ObjectStore) PresignGet(ctx context.Context, storageKey string, ttl time.Duration) (PresignedObjectURL, error) {
	expiresAt := time.Now().UTC().Add(ttl)
	result, err := s.presigner.PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(storageKey),
	}, s3.WithPresignExpires(ttl))
	if err != nil {
		return PresignedObjectURL{}, err
	}
	return PresignedObjectURL{
		URL:             result.URL,
		RequiredHeaders: signedHeaders(result.SignedHeader),
		ExpiresAt:       expiresAt,
	}, nil
}

func (s *S3ObjectStore) Head(ctx context.Context, storageKey string) (ObjectStoreMetadata, error) {
	result, err := s.client.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(storageKey),
	})
	if err != nil {
		var apiErr smithy.APIError
		if errors.As(err, &apiErr) && (apiErr.ErrorCode() == "NotFound" || apiErr.ErrorCode() == "NoSuchKey") {
			return ObjectStoreMetadata{}, ErrObjectStoreNotFound
		}
		return ObjectStoreMetadata{}, err
	}
	return ObjectStoreMetadata{
		SizeBytes:        aws.ToInt64(result.ContentLength),
		CiphertextSHA256: strings.ToLower(strings.TrimSpace(metadataValue(result.Metadata, s3CiphertextSHA256MetadataKey))),
	}, nil
}

func signedHeaders(headers http.Header) map[string]string {
	out := make(map[string]string, len(headers))
	for key, values := range headers {
		if len(values) == 0 {
			continue
		}
		out[http.CanonicalHeaderKey(key)] = values[0]
	}
	return out
}

func metadataValue(metadata map[string]string, key string) string {
	for candidate, value := range metadata {
		if strings.EqualFold(candidate, key) {
			return value
		}
	}
	return ""
}
