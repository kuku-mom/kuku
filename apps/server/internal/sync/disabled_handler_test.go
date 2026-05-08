package sync

import (
	"context"
	"strings"
	"testing"

	"connectrpc.com/connect"

	syncv1 "github.com/kuku-mom/kuku/packages/contract/gen/go/kuku/sync/v1"
)

func TestDisabledHandlerReturnsFailedPreconditionForEveryRPC(t *testing.T) {
	ctx := context.Background()
	handler := NewDisabledHandler()
	cases := map[string]func() error{
		"GetAccountKeyState": func() error {
			_, err := handler.GetAccountKeyState(ctx, connect.NewRequest(&syncv1.GetAccountKeyStateRequest{}))
			return err
		},
		"CreateAccountKey": func() error {
			_, err := handler.CreateAccountKey(ctx, connect.NewRequest(&syncv1.CreateAccountKeyRequest{}))
			return err
		},
		"ListAccountKeyEnvelopes": func() error {
			_, err := handler.ListAccountKeyEnvelopes(ctx, connect.NewRequest(&syncv1.ListAccountKeyEnvelopesRequest{}))
			return err
		},
		"PutAccountKeyEnvelope": func() error {
			_, err := handler.PutAccountKeyEnvelope(ctx, connect.NewRequest(&syncv1.PutAccountKeyEnvelopeRequest{}))
			return err
		},
		"CreateWorkspace": func() error {
			_, err := handler.CreateWorkspace(ctx, connect.NewRequest(&syncv1.CreateWorkspaceRequest{}))
			return err
		},
		"ListWorkspaces": func() error {
			_, err := handler.ListWorkspaces(ctx, connect.NewRequest(&syncv1.ListWorkspacesRequest{}))
			return err
		},
		"GetWorkspace": func() error {
			_, err := handler.GetWorkspace(ctx, connect.NewRequest(&syncv1.GetWorkspaceRequest{}))
			return err
		},
		"UpdateWorkspaceMetadata": func() error {
			_, err := handler.UpdateWorkspaceMetadata(ctx, connect.NewRequest(&syncv1.UpdateWorkspaceMetadataRequest{}))
			return err
		},
		"UpdateWorkspaceKey": func() error {
			_, err := handler.UpdateWorkspaceKey(ctx, connect.NewRequest(&syncv1.UpdateWorkspaceKeyRequest{}))
			return err
		},
		"RegisterDevice": func() error {
			_, err := handler.RegisterDevice(ctx, connect.NewRequest(&syncv1.RegisterDeviceRequest{}))
			return err
		},
		"UpdateDeviceMetadata": func() error {
			_, err := handler.UpdateDeviceMetadata(ctx, connect.NewRequest(&syncv1.UpdateDeviceMetadataRequest{}))
			return err
		},
		"ListKeyEnvelopes": func() error {
			_, err := handler.ListKeyEnvelopes(ctx, connect.NewRequest(&syncv1.ListKeyEnvelopesRequest{}))
			return err
		},
		"PutKeyEnvelope": func() error {
			_, err := handler.PutKeyEnvelope(ctx, connect.NewRequest(&syncv1.PutKeyEnvelopeRequest{}))
			return err
		},
		"GetHead": func() error {
			_, err := handler.GetHead(ctx, connect.NewRequest(&syncv1.GetHeadRequest{}))
			return err
		},
		"ListCommits": func() error {
			_, err := handler.ListCommits(ctx, connect.NewRequest(&syncv1.ListCommitsRequest{}))
			return err
		},
		"PublishCommit": func() error {
			_, err := handler.PublishCommit(ctx, connect.NewRequest(&syncv1.PublishCommitRequest{}))
			return err
		},
		"ReserveObjectIds": func() error {
			_, err := handler.ReserveObjectIds(ctx, connect.NewRequest(&syncv1.ReserveObjectIdsRequest{}))
			return err
		},
		"CreateObjectUploadBatch": func() error {
			_, err := handler.CreateObjectUploadBatch(ctx, connect.NewRequest(&syncv1.CreateObjectUploadBatchRequest{}))
			return err
		},
		"CompleteObjectUploadBatch": func() error {
			_, err := handler.CompleteObjectUploadBatch(ctx, connect.NewRequest(&syncv1.CompleteObjectUploadBatchRequest{}))
			return err
		},
		"CreateObjectDownloadBatch": func() error {
			_, err := handler.CreateObjectDownloadBatch(ctx, connect.NewRequest(&syncv1.CreateObjectDownloadBatchRequest{}))
			return err
		},
		"DeleteWorkspace": func() error {
			_, err := handler.DeleteWorkspace(ctx, connect.NewRequest(&syncv1.DeleteWorkspaceRequest{}))
			return err
		},
		"UploadObjectBytesDev": func() error {
			_, err := handler.UploadObjectBytesDev(ctx, connect.NewRequest(&syncv1.UploadObjectBytesDevRequest{}))
			return err
		},
		"DownloadObjectBytesDev": func() error {
			_, err := handler.DownloadObjectBytesDev(ctx, connect.NewRequest(&syncv1.DownloadObjectBytesDevRequest{}))
			return err
		},
	}

	for name, call := range cases {
		t.Run(name, func(t *testing.T) {
			err := call()
			if got := connect.CodeOf(err); got != connect.CodeFailedPrecondition {
				t.Fatalf("CodeOf(err) = %v, want %v", got, connect.CodeFailedPrecondition)
			}
			if !strings.Contains(err.Error(), "sync disabled") {
				t.Fatalf("error = %q, want sync disabled message", err.Error())
			}
		})
	}
}
