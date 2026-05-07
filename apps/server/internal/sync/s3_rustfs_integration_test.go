package sync

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/smithy-go"

	syncv1 "github.com/kuku-mom/kuku/packages/contract/gen/go/kuku/sync/v1"

	"github.com/kuku-mom/kuku/apps/server/internal/database/sqlc"
)

func TestServiceIntegrationRustFSObjectStorageRoundTrip(t *testing.T) {
	endpoint := strings.TrimRight(strings.TrimSpace(os.Getenv("KUKU_TEST_RUSTFS_ENDPOINT")), "/")
	if endpoint == "" {
		t.Skip("KUKU_TEST_RUSTFS_ENDPOINT is not set")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	f := newTransferFixture(t, nil)
	f.ctx = ctx

	cfg := *f.service.cfg
	cfg.Env = rustFSTestEnv("KUKU_TEST_RUSTFS_NAMESPACE", "test")
	cfg.SyncS3Endpoint = endpoint
	cfg.SyncS3Region = rustFSTestEnv("KUKU_TEST_RUSTFS_REGION", "us-east-1")
	cfg.SyncS3Bucket = rustFSTestEnv("KUKU_TEST_RUSTFS_BUCKET", "kuku-sync-test")
	cfg.SyncS3AccessKeyID = rustFSTestEnv("KUKU_TEST_RUSTFS_ACCESS_KEY", "rustfsadmin")
	cfg.SyncS3SecretAccessKey = rustFSTestEnv("KUKU_TEST_RUSTFS_SECRET_ACCESS_KEY", "rustfsadmin")
	cfg.SyncS3ForcePathStyle = rustFSTestBoolEnv("KUKU_TEST_RUSTFS_FORCE_PATH_STYLE", true)

	store, err := NewS3ObjectStore(ctx, &cfg)
	if err != nil {
		t.Fatal(err)
	}
	ensureRustFSBucket(ctx, t, store.client, cfg.SyncS3Bucket)
	f.service = NewService(f.pool, f.queries, &cfg, store)

	payload := []byte("kuku encrypted pack through rustfs")
	sha, size := objectMetadata(payload)
	object := f.reserveObject(t, "rustfs-content-pack", syncv1.SyncObjectKind_SYNC_OBJECT_KIND_CONTENT_PACK)
	t.Cleanup(func() {
		_ = store.Delete(context.Background(), object.StorageKey)
	})

	targets, err := f.service.CreateObjectUploadBatch(f.ctx, f.user.ID, f.workspace.ID, f.device.ID, "rustfs-attempt-1", []UploadObjectRequest{{
		ObjectID:         object.ObjectID,
		Kind:             syncv1.SyncObjectKind_SYNC_OBJECT_KIND_CONTENT_PACK,
		CiphertextSHA256: sha,
		SizeBytes:        size,
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(targets) != 1 {
		t.Fatalf("upload targets = %d, want 1", len(targets))
	}
	putPresignedObject(ctx, t, targets[0].PutURL, targets[0].RequiredHeaders, payload)

	results, err := f.service.CompleteObjectUploadBatch(f.ctx, f.user.ID, f.workspace.ID, f.device.ID, "rustfs-attempt-1", []CompletedObjectUploadRequest{{
		ObjectID:         object.ObjectID,
		CiphertextSHA256: sha,
		SizeBytes:        size,
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Object.UploadState != sqlc.KukuSyncObjectStateAvailable || results[0].ErrorReason.Valid {
		t.Fatalf("completion results = %+v", results)
	}

	downloads, err := f.service.CreateObjectDownloadBatch(f.ctx, f.user.ID, f.workspace.ID, f.device.ID, []string{object.ObjectID})
	if err != nil {
		t.Fatal(err)
	}
	if len(downloads) != 1 {
		t.Fatalf("download targets = %d, want 1", len(downloads))
	}
	downloaded := getPresignedObject(ctx, t, downloads[0].GetURL, downloads[0].RequiredHeaders)
	if !bytes.Equal(downloaded, payload) {
		t.Fatalf("downloaded payload = %q, want %q", downloaded, payload)
	}

	if err := store.Delete(ctx, object.StorageKey); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Head(ctx, object.StorageKey); !errors.Is(err, ErrObjectStoreNotFound) {
		t.Fatalf("head after delete error = %v, want ErrObjectStoreNotFound", err)
	}
}

func ensureRustFSBucket(ctx context.Context, t *testing.T, client *s3.Client, bucket string) {
	t.Helper()
	if _, err := client.HeadBucket(ctx, &s3.HeadBucketInput{Bucket: aws.String(bucket)}); err == nil {
		return
	}
	if _, err := client.CreateBucket(ctx, &s3.CreateBucketInput{Bucket: aws.String(bucket)}); err != nil {
		var apiErr smithy.APIError
		if errors.As(err, &apiErr) && (apiErr.ErrorCode() == "BucketAlreadyOwnedByYou" || apiErr.ErrorCode() == "BucketAlreadyExists") {
			return
		}
		t.Fatalf("create RustFS bucket %q: %v", bucket, err)
	}
}

func putPresignedObject(ctx context.Context, t *testing.T, url string, headers map[string]string, payload []byte) {
	t.Helper()
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, url, bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	request.ContentLength = int64(len(payload))
	applyPresignedHeaders(request, headers)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = response.Body.Close()
	}()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		t.Fatalf("presigned PUT status = %d, body = %s", response.StatusCode, body)
	}
}

func getPresignedObject(ctx context.Context, t *testing.T, url string, headers map[string]string) []byte {
	t.Helper()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	applyPresignedHeaders(request, headers)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = response.Body.Close()
	}()
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		t.Fatalf("presigned GET status = %d, body = %s", response.StatusCode, body)
	}
	return body
}

func applyPresignedHeaders(request *http.Request, headers map[string]string) {
	for key, value := range headers {
		if strings.EqualFold(key, "Host") {
			request.Host = value
			continue
		}
		request.Header.Set(key, value)
	}
}

func rustFSTestEnv(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func rustFSTestBoolEnv(key string, fallback bool) bool {
	value := strings.ToLower(strings.TrimSpace(os.Getenv(key)))
	if value == "" {
		return fallback
	}
	return value == "1" || value == "true" || value == "yes" || value == "on"
}
