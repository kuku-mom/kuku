package sync

import (
	"context"
	"errors"
	"log/slog"
	"sort"
	"strings"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	syncv1 "github.com/kuku-mom/kuku/packages/contract/gen/go/kuku/sync/v1"
	"github.com/kuku-mom/kuku/packages/contract/gen/go/kuku/sync/v1/syncv1connect"

	"github.com/kuku-mom/kuku/apps/server/internal/auth"
	"github.com/kuku-mom/kuku/apps/server/internal/database/sqlc"
	"github.com/kuku-mom/kuku/apps/server/internal/rpcerr"
)

type Handler struct {
	syncv1connect.UnimplementedSyncServiceHandler
	service *Service
	log     *slog.Logger
}

func NewHandler(service *Service, log *slog.Logger) *Handler {
	return &Handler{service: service, log: log}
}

func (h *Handler) GetAccountKeyState(ctx context.Context, req *connect.Request[syncv1.GetAccountKeyStateRequest]) (*connect.Response[syncv1.GetAccountKeyStateResponse], error) {
	userID, _, err := auth.FromContext(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("not authenticated"))
	}
	accountKey, err := h.service.GetAccountKeyState(ctx, userID)
	if err != nil {
		return nil, h.serviceError(ctx, err)
	}
	response := &syncv1.GetAccountKeyStateResponse{}
	if accountKey != nil {
		response.AccountKey = syncAccountKeyToProto(*accountKey)
	}
	return connect.NewResponse(response), nil
}

func (h *Handler) CreateAccountKey(ctx context.Context, req *connect.Request[syncv1.CreateAccountKeyRequest]) (*connect.Response[syncv1.CreateAccountKeyResponse], error) {
	userID, _, err := auth.FromContext(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("not authenticated"))
	}
	result, err := h.service.CreateAccountKey(ctx, userID, CreateAccountKeyParams{
		AccountKeyID:      strings.TrimSpace(req.Msg.GetAccountKeyId()),
		CryptoVersion:     req.Msg.GetCryptoVersion(),
		EnvelopeID:        strings.TrimSpace(req.Msg.GetEnvelopeId()),
		RecipientType:     req.Msg.GetRecipientType(),
		KeyVersion:        req.Msg.GetKeyVersion(),
		KDFParamsJSON:     req.Msg.GetKdfParamsJson(),
		EncryptedEnvelope: req.Msg.GetEncryptedEnvelope(),
	})
	if err != nil {
		return nil, h.serviceError(ctx, err)
	}
	return connect.NewResponse(&syncv1.CreateAccountKeyResponse{
		AccountKey: syncAccountKeyToProto(result.AccountKey),
		Envelope:   syncAccountKeyEnvelopeToProto(result.Envelope),
	}), nil
}

func (h *Handler) ListAccountKeyEnvelopes(ctx context.Context, req *connect.Request[syncv1.ListAccountKeyEnvelopesRequest]) (*connect.Response[syncv1.ListAccountKeyEnvelopesResponse], error) {
	userID, _, err := auth.FromContext(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("not authenticated"))
	}
	envelopes, err := h.service.ListAccountKeyEnvelopes(ctx, userID)
	if err != nil {
		return nil, h.serviceError(ctx, err)
	}
	out := make([]*syncv1.SyncAccountKeyEnvelope, 0, len(envelopes))
	for _, envelope := range envelopes {
		out = append(out, syncAccountKeyEnvelopeToProto(envelope))
	}
	return connect.NewResponse(&syncv1.ListAccountKeyEnvelopesResponse{Envelopes: out}), nil
}

func (h *Handler) PutAccountKeyEnvelope(ctx context.Context, req *connect.Request[syncv1.PutAccountKeyEnvelopeRequest]) (*connect.Response[syncv1.PutAccountKeyEnvelopeResponse], error) {
	userID, _, err := auth.FromContext(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("not authenticated"))
	}
	envelope, err := h.service.PutAccountKeyEnvelope(ctx, userID, PutAccountKeyEnvelopeParams{
		EnvelopeID:        strings.TrimSpace(req.Msg.GetEnvelopeId()),
		RecipientType:     req.Msg.GetRecipientType(),
		KeyVersion:        req.Msg.GetKeyVersion(),
		KDFParamsJSON:     req.Msg.GetKdfParamsJson(),
		EncryptedEnvelope: req.Msg.GetEncryptedEnvelope(),
	})
	if err != nil {
		return nil, h.serviceError(ctx, err)
	}
	return connect.NewResponse(&syncv1.PutAccountKeyEnvelopeResponse{Envelope: syncAccountKeyEnvelopeToProto(envelope)}), nil
}

func (h *Handler) CreateWorkspace(ctx context.Context, req *connect.Request[syncv1.CreateWorkspaceRequest]) (*connect.Response[syncv1.CreateWorkspaceResponse], error) {
	userID, _, err := auth.FromContext(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("not authenticated"))
	}
	workspace, err := h.service.CreateWorkspace(ctx, userID, req.Msg.GetCryptoVersion())
	if err != nil {
		return nil, h.serviceError(ctx, err)
	}
	return connect.NewResponse(&syncv1.CreateWorkspaceResponse{Workspace: syncWorkspaceToProto(workspace)}), nil
}

func (h *Handler) ListWorkspaces(ctx context.Context, req *connect.Request[syncv1.ListWorkspacesRequest]) (*connect.Response[syncv1.ListWorkspacesResponse], error) {
	userID, _, err := auth.FromContext(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("not authenticated"))
	}
	workspaces, err := h.service.ListWorkspaces(ctx, userID)
	if err != nil {
		return nil, h.serviceError(ctx, err)
	}
	out := make([]*syncv1.SyncWorkspace, 0, len(workspaces))
	for _, workspace := range workspaces {
		out = append(out, syncWorkspaceToProto(workspace))
	}
	return connect.NewResponse(&syncv1.ListWorkspacesResponse{Workspaces: out}), nil
}

func (h *Handler) GetWorkspace(ctx context.Context, req *connect.Request[syncv1.GetWorkspaceRequest]) (*connect.Response[syncv1.GetWorkspaceResponse], error) {
	userID, _, err := auth.FromContext(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("not authenticated"))
	}
	workspaceID, err := parseUUID(req.Msg.GetWorkspaceId(), "workspace_id")
	if err != nil {
		return nil, err
	}
	workspace, err := h.service.GetWorkspace(ctx, userID, workspaceID)
	if err != nil {
		return nil, h.serviceError(ctx, err)
	}
	return connect.NewResponse(&syncv1.GetWorkspaceResponse{Workspace: syncWorkspaceToProto(workspace)}), nil
}

func (h *Handler) UpdateWorkspaceMetadata(ctx context.Context, req *connect.Request[syncv1.UpdateWorkspaceMetadataRequest]) (*connect.Response[syncv1.UpdateWorkspaceMetadataResponse], error) {
	userID, _, err := auth.FromContext(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("not authenticated"))
	}
	workspaceID, err := parseUUID(req.Msg.GetWorkspaceId(), "workspace_id")
	if err != nil {
		return nil, err
	}
	workspace, err := h.service.UpdateWorkspaceMetadata(ctx, userID, UpdateWorkspaceMetadataParams{
		WorkspaceID:             workspaceID,
		EncryptedMetadata:       req.Msg.GetEncryptedMetadata(),
		MetadataVersion:         req.Msg.GetMetadataVersion(),
		ExpectedMetadataVersion: req.Msg.GetExpectedMetadataVersion(),
	})
	if err != nil {
		return nil, h.serviceError(ctx, err)
	}
	return connect.NewResponse(&syncv1.UpdateWorkspaceMetadataResponse{Workspace: syncWorkspaceToProto(workspace)}), nil
}

func (h *Handler) UpdateWorkspaceKey(ctx context.Context, req *connect.Request[syncv1.UpdateWorkspaceKeyRequest]) (*connect.Response[syncv1.UpdateWorkspaceKeyResponse], error) {
	userID, _, err := auth.FromContext(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("not authenticated"))
	}
	workspaceID, err := parseUUID(req.Msg.GetWorkspaceId(), "workspace_id")
	if err != nil {
		return nil, err
	}
	workspace, err := h.service.UpdateWorkspaceKey(ctx, userID, UpdateWorkspaceKeyParams{
		WorkspaceID:                 workspaceID,
		EncryptedWorkspaceKey:       req.Msg.GetEncryptedWorkspaceKey(),
		WorkspaceKeyVersion:         req.Msg.GetWorkspaceKeyVersion(),
		ExpectedWorkspaceKeyVersion: req.Msg.GetExpectedWorkspaceKeyVersion(),
	})
	if err != nil {
		return nil, h.serviceError(ctx, err)
	}
	return connect.NewResponse(&syncv1.UpdateWorkspaceKeyResponse{Workspace: syncWorkspaceToProto(workspace)}), nil
}

func (h *Handler) RegisterDevice(ctx context.Context, req *connect.Request[syncv1.RegisterDeviceRequest]) (*connect.Response[syncv1.RegisterDeviceResponse], error) {
	userID, _, err := auth.FromContext(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("not authenticated"))
	}
	workspaceID, err := parseUUID(req.Msg.GetWorkspaceId(), "workspace_id")
	if err != nil {
		return nil, err
	}
	device, err := h.service.RegisterDevice(ctx, userID, workspaceID, req.Msg.GetSigningPublicKey(), req.Msg.GetEncryptionPublicKey(), req.Msg.GetEncryptedDeviceName())
	if err != nil {
		return nil, h.serviceError(ctx, err)
	}
	return connect.NewResponse(&syncv1.RegisterDeviceResponse{Device: syncDeviceToProto(device)}), nil
}

func (h *Handler) UpdateDeviceMetadata(ctx context.Context, req *connect.Request[syncv1.UpdateDeviceMetadataRequest]) (*connect.Response[syncv1.UpdateDeviceMetadataResponse], error) {
	userID, _, err := auth.FromContext(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("not authenticated"))
	}
	workspaceID, err := parseUUID(req.Msg.GetWorkspaceId(), "workspace_id")
	if err != nil {
		return nil, err
	}
	deviceID, err := parseUUID(req.Msg.GetDeviceId(), "device_id")
	if err != nil {
		return nil, err
	}
	device, err := h.service.UpdateDeviceMetadata(ctx, userID, UpdateDeviceMetadataParams{
		WorkspaceID:             workspaceID,
		DeviceID:                deviceID,
		EncryptedDeviceName:     req.Msg.GetEncryptedDeviceName(),
		MetadataVersion:         req.Msg.GetMetadataVersion(),
		ExpectedMetadataVersion: req.Msg.GetExpectedMetadataVersion(),
	})
	if err != nil {
		return nil, h.serviceError(ctx, err)
	}
	return connect.NewResponse(&syncv1.UpdateDeviceMetadataResponse{Device: syncDeviceToProto(device)}), nil
}

func (h *Handler) ListKeyEnvelopes(ctx context.Context, req *connect.Request[syncv1.ListKeyEnvelopesRequest]) (*connect.Response[syncv1.ListKeyEnvelopesResponse], error) {
	userID, _, err := auth.FromContext(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("not authenticated"))
	}
	workspaceID, err := parseUUID(req.Msg.GetWorkspaceId(), "workspace_id")
	if err != nil {
		return nil, err
	}
	envelopes, err := h.service.ListKeyEnvelopes(ctx, userID, workspaceID)
	if err != nil {
		return nil, h.serviceError(ctx, err)
	}
	out := make([]*syncv1.SyncKeyEnvelope, 0, len(envelopes))
	for _, envelope := range envelopes {
		out = append(out, syncKeyEnvelopeToProto(envelope))
	}
	return connect.NewResponse(&syncv1.ListKeyEnvelopesResponse{Envelopes: out}), nil
}

func (h *Handler) PutKeyEnvelope(ctx context.Context, req *connect.Request[syncv1.PutKeyEnvelopeRequest]) (*connect.Response[syncv1.PutKeyEnvelopeResponse], error) {
	userID, _, err := auth.FromContext(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("not authenticated"))
	}
	workspaceID, err := parseUUID(req.Msg.GetWorkspaceId(), "workspace_id")
	if err != nil {
		return nil, err
	}
	createdByDeviceID, err := parseUUID(req.Msg.GetCreatedByDeviceId(), "created_by_device_id")
	if err != nil {
		return nil, err
	}
	var recipientDeviceID uuid.UUID
	if strings.TrimSpace(req.Msg.GetRecipientDeviceId()) != "" {
		recipientDeviceID, err = parseUUID(req.Msg.GetRecipientDeviceId(), "recipient_device_id")
		if err != nil {
			return nil, err
		}
	}
	envelope, err := h.service.PutKeyEnvelope(ctx, userID, PutKeyEnvelopeParams{
		WorkspaceID:       workspaceID,
		EnvelopeID:        strings.TrimSpace(req.Msg.GetEnvelopeId()),
		RecipientType:     req.Msg.GetRecipientType(),
		RecipientDeviceID: recipientDeviceID,
		KeyVersion:        req.Msg.GetKeyVersion(),
		KDFParamsJSON:     req.Msg.GetKdfParamsJson(),
		EncryptedEnvelope: req.Msg.GetEncryptedEnvelope(),
		CreatedByDeviceID: createdByDeviceID,
	})
	if err != nil {
		return nil, h.serviceError(ctx, err)
	}
	return connect.NewResponse(&syncv1.PutKeyEnvelopeResponse{Envelope: syncKeyEnvelopeToProto(envelope)}), nil
}

func (h *Handler) GetHead(ctx context.Context, req *connect.Request[syncv1.GetHeadRequest]) (*connect.Response[syncv1.GetHeadResponse], error) {
	userID, _, err := auth.FromContext(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("not authenticated"))
	}
	workspaceID, err := parseUUID(req.Msg.GetWorkspaceId(), "workspace_id")
	if err != nil {
		return nil, err
	}
	workspace, checkpointID, err := h.service.GetHead(ctx, userID, workspaceID)
	if err != nil {
		return nil, h.serviceError(ctx, err)
	}
	return connect.NewResponse(&syncv1.GetHeadResponse{
		CurrentHeadCommitId:      proto.String(textValue(workspace.CurrentHeadCommitID)),
		HeadVersion:              proto.Int64(workspace.HeadVersion),
		LatestCheckpointCommitId: proto.String(checkpointID),
	}), nil
}

func (h *Handler) ListCommits(ctx context.Context, req *connect.Request[syncv1.ListCommitsRequest]) (*connect.Response[syncv1.ListCommitsResponse], error) {
	userID, _, err := auth.FromContext(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("not authenticated"))
	}
	workspaceID, err := parseUUID(req.Msg.GetWorkspaceId(), "workspace_id")
	if err != nil {
		return nil, err
	}
	commits, hasMore, next, err := h.service.ListCommits(ctx, userID, workspaceID, req.Msg.GetAfterServerSeq(), req.Msg.GetPageSize())
	if err != nil {
		return nil, h.serviceError(ctx, err)
	}
	out := make([]*syncv1.SyncCommit, 0, len(commits))
	for _, commit := range commits {
		out = append(out, syncCommitToProto(commit))
	}
	return connect.NewResponse(&syncv1.ListCommitsResponse{
		Commits:            out,
		HasMore:            proto.Bool(hasMore),
		NextAfterServerSeq: proto.Int64(next),
	}), nil
}

func (h *Handler) PublishCommit(ctx context.Context, req *connect.Request[syncv1.PublishCommitRequest]) (*connect.Response[syncv1.PublishCommitResponse], error) {
	userID, _, err := auth.FromContext(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("not authenticated"))
	}
	workspaceID, err := parseUUID(req.Msg.GetWorkspaceId(), "workspace_id")
	if err != nil {
		return nil, err
	}
	authorDeviceID, err := parseUUID(req.Msg.GetAuthorDeviceId(), "author_device_id")
	if err != nil {
		return nil, err
	}
	result, err := h.service.PublishCommit(ctx, userID, PublishCommitParams{
		WorkspaceID:          workspaceID,
		CommitID:             req.Msg.GetCommitId(),
		CommitKind:           req.Msg.GetCommitKind(),
		ExpectedHeadCommitID: req.Msg.GetExpectedHeadCommitId(),
		ParentCommitIDs:      req.Msg.GetParentCommitIds(),
		AuthorDeviceID:       authorDeviceID,
		DeviceSeq:            req.Msg.GetDeviceSeq(),
		BodyObjectID:         req.Msg.GetBodyObjectId(),
		BodyCiphertextSHA256: req.Msg.GetBodyCiphertextSha256(),
		BodySizeBytes:        req.Msg.GetBodySizeBytes(),
		ReferencedObjectIDs:  req.Msg.GetReferencedObjectIds(),
		Signature:            req.Msg.GetSignature(),
	})
	if err != nil {
		return nil, h.serviceError(ctx, err)
	}
	return connect.NewResponse(&syncv1.PublishCommitResponse{
		Commit:      syncCommitToProto(result.Commit),
		HeadVersion: proto.Int64(result.HeadVersion),
		Idempotent:  proto.Bool(result.Idempotent),
	}), nil
}

func (h *Handler) ReserveObjectIds(ctx context.Context, req *connect.Request[syncv1.ReserveObjectIdsRequest]) (*connect.Response[syncv1.ReserveObjectIdsResponse], error) {
	userID, _, err := auth.FromContext(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("not authenticated"))
	}
	workspaceID, err := parseUUID(req.Msg.GetWorkspaceId(), "workspace_id")
	if err != nil {
		return nil, err
	}
	deviceID, err := parseUUID(req.Msg.GetDeviceId(), "device_id")
	if err != nil {
		return nil, err
	}
	requests := make([]ObjectReservationRequest, 0, len(req.Msg.GetObjects()))
	for _, object := range req.Msg.GetObjects() {
		requests = append(requests, ObjectReservationRequest{
			ClientObjectRef: object.GetClientObjectRef(),
			Kind:            object.GetKind(),
		})
	}
	reserved, err := h.service.ReserveObjectIDs(ctx, userID, workspaceID, deviceID, requests)
	if err != nil {
		return nil, h.serviceError(ctx, err)
	}
	out := make([]*syncv1.ObjectReservation, 0, len(reserved))
	for _, object := range reserved {
		out = append(out, &syncv1.ObjectReservation{
			ClientObjectRef: proto.String(object.ClientObjectRef),
			ObjectId:        proto.String(object.Object.ObjectID),
			Kind:            objectKindToProto(object.Object.ObjectKind).Enum(),
			StorageProvider: storageProviderToProto(object.Object.StorageProvider).Enum(),
		})
	}
	return connect.NewResponse(&syncv1.ReserveObjectIdsResponse{Objects: out}), nil
}

func (h *Handler) CreateObjectUploadBatch(ctx context.Context, req *connect.Request[syncv1.CreateObjectUploadBatchRequest]) (*connect.Response[syncv1.CreateObjectUploadBatchResponse], error) {
	userID, _, err := auth.FromContext(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("not authenticated"))
	}
	workspaceID, err := parseUUID(req.Msg.GetWorkspaceId(), "workspace_id")
	if err != nil {
		return nil, err
	}
	deviceID, err := parseUUID(req.Msg.GetDeviceId(), "device_id")
	if err != nil {
		return nil, err
	}
	objects := make([]UploadObjectRequest, 0, len(req.Msg.GetObjects()))
	for _, object := range req.Msg.GetObjects() {
		objects = append(objects, UploadObjectRequest{
			ObjectID:         object.GetObjectId(),
			Kind:             object.GetKind(),
			CiphertextSHA256: object.GetCiphertextSha256(),
			SizeBytes:        object.GetSizeBytes(),
		})
	}
	targets, err := h.service.CreateObjectUploadBatch(ctx, userID, workspaceID, deviceID, req.Msg.GetUploadAttemptId(), objects)
	if err != nil {
		return nil, h.serviceError(ctx, err)
	}
	out := make([]*syncv1.ObjectUploadTarget, 0, len(targets))
	for _, target := range targets {
		out = append(out, &syncv1.ObjectUploadTarget{
			ObjectId:        proto.String(target.ObjectID),
			PutUrl:          proto.String(target.PutURL),
			RequiredHeaders: headersToProto(target.RequiredHeaders),
			ExpiresAt:       timestamppb.New(target.ExpiresAt),
		})
	}
	return connect.NewResponse(&syncv1.CreateObjectUploadBatchResponse{Objects: out}), nil
}

func (h *Handler) CompleteObjectUploadBatch(ctx context.Context, req *connect.Request[syncv1.CompleteObjectUploadBatchRequest]) (*connect.Response[syncv1.CompleteObjectUploadBatchResponse], error) {
	userID, _, err := auth.FromContext(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("not authenticated"))
	}
	workspaceID, err := parseUUID(req.Msg.GetWorkspaceId(), "workspace_id")
	if err != nil {
		return nil, err
	}
	deviceID, err := parseUUID(req.Msg.GetDeviceId(), "device_id")
	if err != nil {
		return nil, err
	}
	objects := make([]CompletedObjectUploadRequest, 0, len(req.Msg.GetObjects()))
	for _, object := range req.Msg.GetObjects() {
		objects = append(objects, CompletedObjectUploadRequest{
			ObjectID:         object.GetObjectId(),
			CiphertextSHA256: object.GetCiphertextSha256(),
			SizeBytes:        object.GetSizeBytes(),
			ProviderETag:     object.GetProviderEtag(),
		})
	}
	results, err := h.service.CompleteObjectUploadBatch(ctx, userID, workspaceID, deviceID, req.Msg.GetUploadAttemptId(), objects)
	if err != nil {
		return nil, h.serviceError(ctx, err)
	}
	out := make([]*syncv1.ObjectUploadResult, 0, len(results))
	for _, result := range results {
		out = append(out, objectUploadResultToProto(result))
	}
	return connect.NewResponse(&syncv1.CompleteObjectUploadBatchResponse{Objects: out}), nil
}

func (h *Handler) CreateObjectDownloadBatch(ctx context.Context, req *connect.Request[syncv1.CreateObjectDownloadBatchRequest]) (*connect.Response[syncv1.CreateObjectDownloadBatchResponse], error) {
	userID, _, err := auth.FromContext(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("not authenticated"))
	}
	workspaceID, err := parseUUID(req.Msg.GetWorkspaceId(), "workspace_id")
	if err != nil {
		return nil, err
	}
	deviceID, err := parseUUID(req.Msg.GetDeviceId(), "device_id")
	if err != nil {
		return nil, err
	}
	targets, err := h.service.CreateObjectDownloadBatch(ctx, userID, workspaceID, deviceID, req.Msg.GetObjectIds())
	if err != nil {
		return nil, h.serviceError(ctx, err)
	}
	out := make([]*syncv1.ObjectDownloadTarget, 0, len(targets))
	for _, target := range targets {
		out = append(out, &syncv1.ObjectDownloadTarget{
			ObjectId:         proto.String(target.Object.ObjectID),
			Kind:             objectKindToProto(target.Object.ObjectKind).Enum(),
			GetUrl:           proto.String(target.GetURL),
			RequiredHeaders:  headersToProto(target.RequiredHeaders),
			CiphertextSha256: proto.String(target.Object.CiphertextSha256),
			SizeBytes:        proto.Int64(target.Object.SizeBytes),
			ExpiresAt:        timestamppb.New(target.ExpiresAt),
		})
	}
	return connect.NewResponse(&syncv1.CreateObjectDownloadBatchResponse{Objects: out}), nil
}

func (h *Handler) DeleteWorkspace(ctx context.Context, req *connect.Request[syncv1.DeleteWorkspaceRequest]) (*connect.Response[syncv1.DeleteWorkspaceResponse], error) {
	userID, _, err := auth.FromContext(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("not authenticated"))
	}
	workspaceID, err := parseUUID(req.Msg.GetWorkspaceId(), "workspace_id")
	if err != nil {
		return nil, err
	}
	if err := h.service.DeleteWorkspace(ctx, userID, workspaceID); err != nil {
		return nil, h.serviceError(ctx, err)
	}
	return connect.NewResponse(&syncv1.DeleteWorkspaceResponse{}), nil
}

func (h *Handler) UploadObjectBytesDev(ctx context.Context, req *connect.Request[syncv1.UploadObjectBytesDevRequest]) (*connect.Response[syncv1.UploadObjectBytesDevResponse], error) {
	userID, _, err := auth.FromContext(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("not authenticated"))
	}
	workspaceID, err := parseUUID(req.Msg.GetWorkspaceId(), "workspace_id")
	if err != nil {
		return nil, err
	}
	deviceID, err := parseUUID(req.Msg.GetDeviceId(), "device_id")
	if err != nil {
		return nil, err
	}
	object, err := h.service.UploadObjectBytesDev(ctx, userID, workspaceID, deviceID, req.Msg.GetObjectId(), req.Msg.GetCiphertextSha256(), req.Msg.GetSizeBytes(), req.Msg.GetEncryptedBlob())
	if err != nil {
		return nil, h.serviceError(ctx, err)
	}
	return connect.NewResponse(&syncv1.UploadObjectBytesDevResponse{Object: syncObjectToProto(object)}), nil
}

func (h *Handler) DownloadObjectBytesDev(ctx context.Context, req *connect.Request[syncv1.DownloadObjectBytesDevRequest]) (*connect.Response[syncv1.DownloadObjectBytesDevResponse], error) {
	userID, _, err := auth.FromContext(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("not authenticated"))
	}
	workspaceID, err := parseUUID(req.Msg.GetWorkspaceId(), "workspace_id")
	if err != nil {
		return nil, err
	}
	deviceID, err := parseUUID(req.Msg.GetDeviceId(), "device_id")
	if err != nil {
		return nil, err
	}
	object, payload, err := h.service.DownloadObjectBytesDev(ctx, userID, workspaceID, deviceID, req.Msg.GetObjectId())
	if err != nil {
		return nil, h.serviceError(ctx, err)
	}
	return connect.NewResponse(&syncv1.DownloadObjectBytesDevResponse{
		Object:        syncObjectToProto(object),
		EncryptedBlob: payload,
	}), nil
}

func (h *Handler) serviceError(ctx context.Context, err error) error {
	var headConflict *HeadConflictError
	var quota *QuotaError
	switch {
	case errors.As(err, &headConflict):
		ce := connect.NewError(connect.CodeAborted, errors.New("sync head conflict"))
		if detail, detailErr := connect.NewErrorDetail(&syncv1.HeadConflictDetail{
			WorkspaceId:         proto.String(headConflict.WorkspaceID),
			CurrentHeadCommitId: proto.String(headConflict.CurrentHeadID),
			HeadVersion:         proto.Int64(headConflict.HeadVersion),
		}); detailErr == nil {
			ce.AddDetail(detail)
		}
		return ce
	case errors.Is(err, ErrMetadataVersionConflict):
		return connect.NewError(connect.CodeAborted, err)
	case errors.As(err, &quota):
		ce := connect.NewError(connect.CodeResourceExhausted, errors.New("sync quota exceeded"))
		if detail, detailErr := connect.NewErrorDetail(&syncv1.QuotaExceededDetail{
			Limit:          quota.Limit.Enum(),
			MaxValue:       proto.Int64(quota.Max),
			CurrentValue:   proto.Int64(quota.Current),
			RequestedValue: proto.Int64(quota.Requested),
		}); detailErr == nil {
			ce.AddDetail(detail)
		}
		return ce
	case errors.Is(err, ErrPermissionDenied):
		return connect.NewError(connect.CodePermissionDenied, errors.New("permission denied"))
	case errors.Is(err, ErrInvalidArgument), errors.Is(err, ErrObjectMetadataMismatch):
		return connect.NewError(connect.CodeInvalidArgument, err)
	case errors.Is(err, ErrDuplicateCommitPayload), errors.Is(err, ErrDuplicateDeviceSeq), errors.Is(err, ErrAccountKeyExists):
		return connect.NewError(connect.CodeAlreadyExists, err)
	case errors.Is(err, ErrDevBytesDisabled), errors.Is(err, ErrAccountKeyNotConfigured):
		return connect.NewError(connect.CodeFailedPrecondition, err)
	case errors.Is(err, ErrObjectNotAvailable), errors.Is(err, ErrInvalidCommitParent), errors.Is(err, ErrInvalidSignature):
		return connect.NewError(connect.CodeFailedPrecondition, err)
	case errors.Is(err, ErrObjectStoreNotFound):
		return connect.NewError(connect.CodeNotFound, err)
	case errors.Is(err, ErrNotImplemented):
		return connect.NewError(connect.CodeUnimplemented, err)
	default:
		return rpcerr.Internal(ctx, h.log, "sync service error", err)
	}
}

func parseUUID(value, field string) (uuid.UUID, error) {
	parsed, err := uuid.Parse(strings.TrimSpace(value))
	if err != nil || parsed == uuid.Nil {
		return uuid.Nil, connect.NewError(connect.CodeInvalidArgument, errors.New(field+" must be a valid uuid"))
	}
	return parsed, nil
}

func syncAccountKeyToProto(accountKey sqlc.KukuSyncAccountKey) *syncv1.SyncAccountKey {
	return &syncv1.SyncAccountKey{
		AccountKeyId:  proto.String(accountKey.AccountKeyID),
		CryptoVersion: proto.String(accountKey.CryptoVersion),
		CreatedAt:     timestamp(accountKey.CreatedAt),
		UpdatedAt:     timestamp(accountKey.UpdatedAt),
	}
}

func syncAccountKeyEnvelopeToProto(envelope sqlc.KukuSyncAccountKeyEnvelope) *syncv1.SyncAccountKeyEnvelope {
	return &syncv1.SyncAccountKeyEnvelope{
		AccountKeyId:      proto.String(envelope.AccountKeyID),
		EnvelopeId:        proto.String(envelope.EnvelopeID),
		RecipientType:     accountKeyRecipientTypeToProto(envelope.RecipientType).Enum(),
		KeyVersion:        proto.Int64(envelope.KeyVersion),
		KdfParamsJson:     proto.String(string(envelope.KdfParams)),
		EncryptedEnvelope: envelope.EncryptedEnvelope,
		CreatedAt:         timestamp(envelope.CreatedAt),
	}
}

func syncWorkspaceToProto(workspace sqlc.KukuSyncWorkspace) *syncv1.SyncWorkspace {
	return &syncv1.SyncWorkspace{
		WorkspaceId:           proto.String(workspace.ID.String()),
		CurrentHeadCommitId:   proto.String(textValue(workspace.CurrentHeadCommitID)),
		HeadVersion:           proto.Int64(workspace.HeadVersion),
		CryptoVersion:         proto.String(workspace.CryptoVersion),
		CreatedAt:             timestamp(workspace.CreatedAt),
		UpdatedAt:             timestamp(workspace.UpdatedAt),
		EncryptedMetadata:     workspace.EncryptedMetadata,
		MetadataVersion:       proto.Int64(workspace.MetadataVersion),
		EncryptedWorkspaceKey: workspace.EncryptedWorkspaceKey,
		WorkspaceKeyVersion:   proto.Int64(workspace.WorkspaceKeyVersion),
	}
}

func syncDeviceToProto(device sqlc.KukuSyncDevice) *syncv1.SyncDevice {
	return &syncv1.SyncDevice{
		DeviceId:            proto.String(device.ID.String()),
		WorkspaceId:         proto.String(device.WorkspaceID.String()),
		SigningPublicKey:    device.SigningPublicKey,
		EncryptionPublicKey: device.EncryptionPublicKey,
		EncryptedDeviceName: device.EncryptedDeviceName,
		LastDeviceSeq:       proto.Int64(device.LastDeviceSeq),
		CreatedAt:           timestamp(device.CreatedAt),
		LastSeenAt:          timestamp(device.LastSeenAt),
		MetadataVersion:     proto.Int64(device.MetadataVersion),
	}
}

func syncKeyEnvelopeToProto(envelope sqlc.KukuSyncKeyEnvelope) *syncv1.SyncKeyEnvelope {
	return &syncv1.SyncKeyEnvelope{
		WorkspaceId:       proto.String(envelope.WorkspaceID.String()),
		EnvelopeId:        proto.String(envelope.EnvelopeID),
		RecipientType:     keyRecipientTypeToProto(envelope.RecipientType).Enum(),
		RecipientDeviceId: proto.String(nullUUIDValue(envelope.RecipientDeviceID)),
		KeyVersion:        proto.Int64(envelope.KeyVersion),
		KdfParamsJson:     proto.String(string(envelope.KdfParams)),
		EncryptedEnvelope: envelope.EncryptedEnvelope,
		CreatedByDeviceId: proto.String(nullUUIDValue(envelope.CreatedByDeviceID)),
		CreatedAt:         timestamp(envelope.CreatedAt),
	}
}

func syncObjectToProto(object sqlc.KukuSyncObject) *syncv1.SyncObject {
	return &syncv1.SyncObject{
		ObjectId:          proto.String(object.ObjectID),
		Kind:              objectKindToProto(object.ObjectKind).Enum(),
		State:             objectStateToProto(object.UploadState).Enum(),
		StorageProvider:   storageProviderToProto(object.StorageProvider).Enum(),
		CiphertextSha256:  proto.String(object.CiphertextSha256),
		SizeBytes:         proto.Int64(object.SizeBytes),
		CreatedByDeviceId: proto.String(nullUUIDValue(object.CreatedByDeviceID)),
		CreatedAt:         timestamp(object.CreatedAt),
		AvailableAt:       timestamp(object.AvailableAt),
		ExpiresAt:         timestamp(object.ExpiresAt),
		ErrorReason:       optionalObjectErrorReasonToProto(object.ErrorReason),
	}
}

func objectUploadResultToProto(result ObjectUploadResult) *syncv1.ObjectUploadResult {
	return &syncv1.ObjectUploadResult{
		Object:      syncObjectToProto(result.Object),
		ErrorReason: optionalObjectErrorReasonToProto(result.ErrorReason),
	}
}

func syncCommitToProto(commit sqlc.KukuSyncCommit) *syncv1.SyncCommit {
	return &syncv1.SyncCommit{
		CommitId:             proto.String(commit.CommitID),
		CommitKind:           commitKindToProto(commit.CommitKind).Enum(),
		ExpectedHeadCommitId: proto.String(textValue(commit.ExpectedHeadCommitID)),
		ParentCommitIds:      commit.ParentCommitIds,
		AuthorDeviceId:       proto.String(commit.AuthorDeviceID.String()),
		DeviceSeq:            proto.Int64(commit.DeviceSeq),
		BodyObjectId:         proto.String(commit.BodyObjectID),
		BodyCiphertextSha256: proto.String(commit.BodyCiphertextSha256),
		BodySizeBytes:        proto.Int64(commit.BodySizeBytes),
		ReferencedObjectIds:  commit.ReferencedObjectIds,
		Signature:            commit.Signature,
		ServerSeq:            proto.Int64(int8Value(commit.ServerSeq)),
		CreatedAt:            timestamp(commit.CreatedAt),
	}
}

func headersToProto(headers map[string]string) []*syncv1.SyncHttpHeader {
	out := make([]*syncv1.SyncHttpHeader, 0, len(headers))
	names := make([]string, 0, len(headers))
	for name := range headers {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		out = append(out, &syncv1.SyncHttpHeader{
			Name:  proto.String(name),
			Value: proto.String(headers[name]),
		})
	}
	return out
}

func objectKindToProto(kind sqlc.KukuSyncObjectKind) syncv1.SyncObjectKind {
	switch kind {
	case sqlc.KukuSyncObjectKindCommitBody:
		return syncv1.SyncObjectKind_SYNC_OBJECT_KIND_COMMIT_BODY
	case sqlc.KukuSyncObjectKindContentPack:
		return syncv1.SyncObjectKind_SYNC_OBJECT_KIND_CONTENT_PACK
	case sqlc.KukuSyncObjectKindCheckpointPack:
		return syncv1.SyncObjectKind_SYNC_OBJECT_KIND_CHECKPOINT_PACK
	case sqlc.KukuSyncObjectKindLargeObject:
		return syncv1.SyncObjectKind_SYNC_OBJECT_KIND_LARGE_OBJECT
	default:
		return syncv1.SyncObjectKind_SYNC_OBJECT_KIND_UNSPECIFIED
	}
}

func objectStateToProto(state sqlc.KukuSyncObjectState) syncv1.SyncObjectState {
	switch state {
	case sqlc.KukuSyncObjectStateReserved:
		return syncv1.SyncObjectState_SYNC_OBJECT_STATE_RESERVED
	case sqlc.KukuSyncObjectStatePending:
		return syncv1.SyncObjectState_SYNC_OBJECT_STATE_PENDING
	case sqlc.KukuSyncObjectStateAvailable:
		return syncv1.SyncObjectState_SYNC_OBJECT_STATE_AVAILABLE
	case sqlc.KukuSyncObjectStateFailed:
		return syncv1.SyncObjectState_SYNC_OBJECT_STATE_FAILED
	case sqlc.KukuSyncObjectStateDeleted:
		return syncv1.SyncObjectState_SYNC_OBJECT_STATE_DELETED
	default:
		return syncv1.SyncObjectState_SYNC_OBJECT_STATE_UNSPECIFIED
	}
}

func objectErrorReasonToProto(reason sqlc.NullKukuSyncObjectErrorReason) syncv1.SyncObjectErrorReason {
	if !reason.Valid {
		return syncv1.SyncObjectErrorReason_SYNC_OBJECT_ERROR_REASON_UNSPECIFIED
	}
	switch reason.KukuSyncObjectErrorReason {
	case sqlc.KukuSyncObjectErrorReasonUploadExpired:
		return syncv1.SyncObjectErrorReason_SYNC_OBJECT_ERROR_REASON_UPLOAD_EXPIRED
	case sqlc.KukuSyncObjectErrorReasonChecksumMismatch:
		return syncv1.SyncObjectErrorReason_SYNC_OBJECT_ERROR_REASON_CHECKSUM_MISMATCH
	case sqlc.KukuSyncObjectErrorReasonSizeMismatch:
		return syncv1.SyncObjectErrorReason_SYNC_OBJECT_ERROR_REASON_SIZE_MISMATCH
	case sqlc.KukuSyncObjectErrorReasonStorageProviderError:
		return syncv1.SyncObjectErrorReason_SYNC_OBJECT_ERROR_REASON_STORAGE_PROVIDER_ERROR
	case sqlc.KukuSyncObjectErrorReasonQuotaExceeded:
		return syncv1.SyncObjectErrorReason_SYNC_OBJECT_ERROR_REASON_QUOTA_EXCEEDED
	case sqlc.KukuSyncObjectErrorReasonCanceled:
		return syncv1.SyncObjectErrorReason_SYNC_OBJECT_ERROR_REASON_CANCELED
	default:
		return syncv1.SyncObjectErrorReason_SYNC_OBJECT_ERROR_REASON_UNSPECIFIED
	}
}

func optionalObjectErrorReasonToProto(reason sqlc.NullKukuSyncObjectErrorReason) *syncv1.SyncObjectErrorReason {
	if !reason.Valid {
		return nil
	}
	return objectErrorReasonToProto(reason).Enum()
}

func storageProviderToProto(provider sqlc.KukuSyncStorageProvider) syncv1.SyncStorageProvider {
	switch provider {
	case sqlc.KukuSyncStorageProviderLocal:
		return syncv1.SyncStorageProvider_SYNC_STORAGE_PROVIDER_LOCAL
	case sqlc.KukuSyncStorageProviderS3Compatible:
		return syncv1.SyncStorageProvider_SYNC_STORAGE_PROVIDER_S3_COMPATIBLE
	default:
		return syncv1.SyncStorageProvider_SYNC_STORAGE_PROVIDER_UNSPECIFIED
	}
}

func keyRecipientTypeToProto(kind sqlc.KukuSyncKeyRecipientType) syncv1.SyncKeyRecipientType {
	switch kind {
	case sqlc.KukuSyncKeyRecipientTypePassphrase:
		return syncv1.SyncKeyRecipientType_SYNC_KEY_RECIPIENT_TYPE_PASSPHRASE
	case sqlc.KukuSyncKeyRecipientTypeDevice:
		return syncv1.SyncKeyRecipientType_SYNC_KEY_RECIPIENT_TYPE_DEVICE
	default:
		return syncv1.SyncKeyRecipientType_SYNC_KEY_RECIPIENT_TYPE_UNSPECIFIED
	}
}

func accountKeyRecipientTypeToProto(kind sqlc.KukuSyncAccountKeyRecipientType) syncv1.SyncAccountKeyRecipientType {
	switch kind {
	case sqlc.KukuSyncAccountKeyRecipientTypeRecoveryPhrase:
		return syncv1.SyncAccountKeyRecipientType_SYNC_ACCOUNT_KEY_RECIPIENT_TYPE_RECOVERY_PHRASE
	case sqlc.KukuSyncAccountKeyRecipientTypeDevice:
		return syncv1.SyncAccountKeyRecipientType_SYNC_ACCOUNT_KEY_RECIPIENT_TYPE_DEVICE
	default:
		return syncv1.SyncAccountKeyRecipientType_SYNC_ACCOUNT_KEY_RECIPIENT_TYPE_UNSPECIFIED
	}
}

func commitKindToProto(kind sqlc.KukuSyncCommitKind) syncv1.SyncCommitKind {
	switch kind {
	case sqlc.KukuSyncCommitKindIncremental:
		return syncv1.SyncCommitKind_SYNC_COMMIT_KIND_INCREMENTAL
	case sqlc.KukuSyncCommitKindMerge:
		return syncv1.SyncCommitKind_SYNC_COMMIT_KIND_MERGE
	case sqlc.KukuSyncCommitKindCheckpoint:
		return syncv1.SyncCommitKind_SYNC_COMMIT_KIND_CHECKPOINT
	default:
		return syncv1.SyncCommitKind_SYNC_COMMIT_KIND_UNSPECIFIED
	}
}

func timestamp(value pgtype.Timestamptz) *timestamppb.Timestamp {
	if !value.Valid {
		return nil
	}
	return timestamppb.New(value.Time)
}

func textValue(value pgtype.Text) string {
	if !value.Valid {
		return ""
	}
	return value.String
}

func int8Value(value pgtype.Int8) int64 {
	if !value.Valid {
		return 0
	}
	return value.Int64
}

func nullUUIDValue(value uuid.NullUUID) string {
	if !value.Valid {
		return ""
	}
	return value.UUID.String()
}
