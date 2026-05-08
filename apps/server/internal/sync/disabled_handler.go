package sync

import (
	"context"
	"errors"

	"connectrpc.com/connect"

	syncv1 "github.com/kuku-mom/kuku/packages/contract/gen/go/kuku/sync/v1"
	"github.com/kuku-mom/kuku/packages/contract/gen/go/kuku/sync/v1/syncv1connect"
)

type DisabledHandler struct {
	syncv1connect.UnimplementedSyncServiceHandler
}

var _ syncv1connect.SyncServiceHandler = (*DisabledHandler)(nil)

func NewDisabledHandler() *DisabledHandler {
	return &DisabledHandler{}
}

func disabledResponse[T any]() (*connect.Response[T], error) {
	return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("sync disabled"))
}

func (h *DisabledHandler) GetAccountKeyState(context.Context, *connect.Request[syncv1.GetAccountKeyStateRequest]) (*connect.Response[syncv1.GetAccountKeyStateResponse], error) {
	return disabledResponse[syncv1.GetAccountKeyStateResponse]()
}

func (h *DisabledHandler) CreateAccountKey(context.Context, *connect.Request[syncv1.CreateAccountKeyRequest]) (*connect.Response[syncv1.CreateAccountKeyResponse], error) {
	return disabledResponse[syncv1.CreateAccountKeyResponse]()
}

func (h *DisabledHandler) ListAccountKeyEnvelopes(context.Context, *connect.Request[syncv1.ListAccountKeyEnvelopesRequest]) (*connect.Response[syncv1.ListAccountKeyEnvelopesResponse], error) {
	return disabledResponse[syncv1.ListAccountKeyEnvelopesResponse]()
}

func (h *DisabledHandler) PutAccountKeyEnvelope(context.Context, *connect.Request[syncv1.PutAccountKeyEnvelopeRequest]) (*connect.Response[syncv1.PutAccountKeyEnvelopeResponse], error) {
	return disabledResponse[syncv1.PutAccountKeyEnvelopeResponse]()
}

func (h *DisabledHandler) CreateWorkspace(context.Context, *connect.Request[syncv1.CreateWorkspaceRequest]) (*connect.Response[syncv1.CreateWorkspaceResponse], error) {
	return disabledResponse[syncv1.CreateWorkspaceResponse]()
}

func (h *DisabledHandler) ListWorkspaces(context.Context, *connect.Request[syncv1.ListWorkspacesRequest]) (*connect.Response[syncv1.ListWorkspacesResponse], error) {
	return disabledResponse[syncv1.ListWorkspacesResponse]()
}

func (h *DisabledHandler) GetWorkspace(context.Context, *connect.Request[syncv1.GetWorkspaceRequest]) (*connect.Response[syncv1.GetWorkspaceResponse], error) {
	return disabledResponse[syncv1.GetWorkspaceResponse]()
}

func (h *DisabledHandler) UpdateWorkspaceMetadata(context.Context, *connect.Request[syncv1.UpdateWorkspaceMetadataRequest]) (*connect.Response[syncv1.UpdateWorkspaceMetadataResponse], error) {
	return disabledResponse[syncv1.UpdateWorkspaceMetadataResponse]()
}

func (h *DisabledHandler) UpdateWorkspaceKey(context.Context, *connect.Request[syncv1.UpdateWorkspaceKeyRequest]) (*connect.Response[syncv1.UpdateWorkspaceKeyResponse], error) {
	return disabledResponse[syncv1.UpdateWorkspaceKeyResponse]()
}

func (h *DisabledHandler) RegisterDevice(context.Context, *connect.Request[syncv1.RegisterDeviceRequest]) (*connect.Response[syncv1.RegisterDeviceResponse], error) {
	return disabledResponse[syncv1.RegisterDeviceResponse]()
}

func (h *DisabledHandler) UpdateDeviceMetadata(context.Context, *connect.Request[syncv1.UpdateDeviceMetadataRequest]) (*connect.Response[syncv1.UpdateDeviceMetadataResponse], error) {
	return disabledResponse[syncv1.UpdateDeviceMetadataResponse]()
}

func (h *DisabledHandler) ListKeyEnvelopes(context.Context, *connect.Request[syncv1.ListKeyEnvelopesRequest]) (*connect.Response[syncv1.ListKeyEnvelopesResponse], error) {
	return disabledResponse[syncv1.ListKeyEnvelopesResponse]()
}

func (h *DisabledHandler) PutKeyEnvelope(context.Context, *connect.Request[syncv1.PutKeyEnvelopeRequest]) (*connect.Response[syncv1.PutKeyEnvelopeResponse], error) {
	return disabledResponse[syncv1.PutKeyEnvelopeResponse]()
}

func (h *DisabledHandler) GetHead(context.Context, *connect.Request[syncv1.GetHeadRequest]) (*connect.Response[syncv1.GetHeadResponse], error) {
	return disabledResponse[syncv1.GetHeadResponse]()
}

func (h *DisabledHandler) ListCommits(context.Context, *connect.Request[syncv1.ListCommitsRequest]) (*connect.Response[syncv1.ListCommitsResponse], error) {
	return disabledResponse[syncv1.ListCommitsResponse]()
}

func (h *DisabledHandler) PublishCommit(context.Context, *connect.Request[syncv1.PublishCommitRequest]) (*connect.Response[syncv1.PublishCommitResponse], error) {
	return disabledResponse[syncv1.PublishCommitResponse]()
}

func (h *DisabledHandler) ReserveObjectIds(context.Context, *connect.Request[syncv1.ReserveObjectIdsRequest]) (*connect.Response[syncv1.ReserveObjectIdsResponse], error) {
	return disabledResponse[syncv1.ReserveObjectIdsResponse]()
}

func (h *DisabledHandler) CreateObjectUploadBatch(context.Context, *connect.Request[syncv1.CreateObjectUploadBatchRequest]) (*connect.Response[syncv1.CreateObjectUploadBatchResponse], error) {
	return disabledResponse[syncv1.CreateObjectUploadBatchResponse]()
}

func (h *DisabledHandler) CompleteObjectUploadBatch(context.Context, *connect.Request[syncv1.CompleteObjectUploadBatchRequest]) (*connect.Response[syncv1.CompleteObjectUploadBatchResponse], error) {
	return disabledResponse[syncv1.CompleteObjectUploadBatchResponse]()
}

func (h *DisabledHandler) CreateObjectDownloadBatch(context.Context, *connect.Request[syncv1.CreateObjectDownloadBatchRequest]) (*connect.Response[syncv1.CreateObjectDownloadBatchResponse], error) {
	return disabledResponse[syncv1.CreateObjectDownloadBatchResponse]()
}

func (h *DisabledHandler) DeleteWorkspace(context.Context, *connect.Request[syncv1.DeleteWorkspaceRequest]) (*connect.Response[syncv1.DeleteWorkspaceResponse], error) {
	return disabledResponse[syncv1.DeleteWorkspaceResponse]()
}

func (h *DisabledHandler) UploadObjectBytesDev(context.Context, *connect.Request[syncv1.UploadObjectBytesDevRequest]) (*connect.Response[syncv1.UploadObjectBytesDevResponse], error) {
	return disabledResponse[syncv1.UploadObjectBytesDevResponse]()
}

func (h *DisabledHandler) DownloadObjectBytesDev(context.Context, *connect.Request[syncv1.DownloadObjectBytesDevRequest]) (*connect.Response[syncv1.DownloadObjectBytesDevResponse], error) {
	return disabledResponse[syncv1.DownloadObjectBytesDevResponse]()
}
