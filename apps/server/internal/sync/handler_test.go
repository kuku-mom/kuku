package sync

import (
	"testing"

	syncv1 "github.com/kuku-mom/kuku/packages/contract/gen/go/kuku/sync/v1"

	"github.com/kuku-mom/kuku/apps/server/internal/database/sqlc"
)

func TestObjectUploadResultToProtoOmitsErrorReasonForSuccessfulUpload(t *testing.T) {
	got := objectUploadResultToProto(ObjectUploadResult{
		Object: sqlc.KukuSyncObject{
			ObjectID: "obj_success",
		},
	})

	if got.ErrorReason != nil {
		t.Fatalf("ErrorReason = %v, want nil", *got.ErrorReason)
	}
	if got.Object == nil {
		t.Fatal("Object = nil, want metadata")
	}
	if got.Object.ErrorReason != nil {
		t.Fatalf("Object.ErrorReason = %v, want nil", *got.Object.ErrorReason)
	}
}

func TestObjectUploadResultToProtoIncludesErrorReasonForFailedUpload(t *testing.T) {
	reason := sqlc.NullKukuSyncObjectErrorReason{
		KukuSyncObjectErrorReason: sqlc.KukuSyncObjectErrorReasonStorageProviderError,
		Valid:                     true,
	}

	got := objectUploadResultToProto(ObjectUploadResult{
		Object: sqlc.KukuSyncObject{
			ObjectID:    "obj_failed",
			ErrorReason: reason,
		},
		ErrorReason: reason,
	})

	want := syncv1.SyncObjectErrorReason_SYNC_OBJECT_ERROR_REASON_STORAGE_PROVIDER_ERROR
	if got.ErrorReason == nil || *got.ErrorReason != want {
		t.Fatalf("ErrorReason = %v, want %v", got.ErrorReason, want)
	}
	if got.Object == nil {
		t.Fatal("Object = nil, want metadata")
	}
	if got.Object.ErrorReason == nil || *got.Object.ErrorReason != want {
		t.Fatalf("Object.ErrorReason = %v, want %v", got.Object.ErrorReason, want)
	}
}
