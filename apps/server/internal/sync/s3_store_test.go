package sync

import (
	"net/http"
	"testing"
)

func TestSignedHeadersKeepsRequiredHeaderValues(t *testing.T) {
	headers := http.Header{}
	headers.Set("content-type", EncryptedObjectContentType)
	headers.Set("x-amz-meta-kuku-sha256", "abc123")

	got := signedHeaders(headers)

	if got["Content-Type"] != EncryptedObjectContentType {
		t.Fatalf("Content-Type header = %q", got["Content-Type"])
	}
	if got["X-Amz-Meta-Kuku-Sha256"] != "abc123" {
		t.Fatalf("sha metadata header = %q", got["X-Amz-Meta-Kuku-Sha256"])
	}
}

func TestMetadataValueIsCaseInsensitive(t *testing.T) {
	metadata := map[string]string{"Kuku-Sha256": "abc123"}

	if got := metadataValue(metadata, s3CiphertextSHA256MetadataKey); got != "abc123" {
		t.Fatalf("metadata value = %q", got)
	}
}
