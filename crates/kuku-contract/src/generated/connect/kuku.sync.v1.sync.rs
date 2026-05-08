/// Full service name for this service.
pub const SYNC_SERVICE_SERVICE_NAME: &str = "kuku.sync.v1.SyncService";
/// ---------------------------------------------------------------------------
/// SyncService - encrypted sync coordination service
/// ---------------------------------------------------------------------------
///
/// # Implementing handlers
///
/// Handlers receive requests as `OwnedView<FooView<'static>>`, which gives
/// zero-copy borrowed access to fields (e.g. `request.name` is a `&str`
/// into the decoded buffer). The view can be held across `.await` points.
///
/// Implement methods with plain `async fn`; the returned future satisfies
/// the `Send` bound automatically. See the
/// [buffa user guide](https://github.com/anthropics/buffa/blob/main/docs/guide.md#ownedview-in-async-trait-implementations)
/// for zero-copy access patterns and when `to_owned_message()` is needed.
#[allow(clippy::type_complexity)]
pub trait SyncService: Send + Sync + 'static {
    /// Gets account-level sync key state for the authenticated user.
    fn get_account_key_state(
        &self,
        ctx: ::connectrpc::Context,
        request: ::buffa::view::OwnedView<
            crate::proto::kuku::sync::v1::GetAccountKeyStateRequestView<'static>,
        >,
    ) -> impl ::std::future::Future<
        Output = Result<
            (
                crate::proto::kuku::sync::v1::GetAccountKeyStateResponse,
                ::connectrpc::Context,
            ),
            ::connectrpc::ConnectError,
        >,
    > + Send;
    /// Creates account-level sync key state and its first encrypted envelope.
    fn create_account_key(
        &self,
        ctx: ::connectrpc::Context,
        request: ::buffa::view::OwnedView<
            crate::proto::kuku::sync::v1::CreateAccountKeyRequestView<'static>,
        >,
    ) -> impl ::std::future::Future<
        Output = Result<
            (
                crate::proto::kuku::sync::v1::CreateAccountKeyResponse,
                ::connectrpc::Context,
            ),
            ::connectrpc::ConnectError,
        >,
    > + Send;
    /// Lists encrypted account root key envelopes.
    fn list_account_key_envelopes(
        &self,
        ctx: ::connectrpc::Context,
        request: ::buffa::view::OwnedView<
            crate::proto::kuku::sync::v1::ListAccountKeyEnvelopesRequestView<'static>,
        >,
    ) -> impl ::std::future::Future<
        Output = Result<
            (
                crate::proto::kuku::sync::v1::ListAccountKeyEnvelopesResponse,
                ::connectrpc::Context,
            ),
            ::connectrpc::ConnectError,
        >,
    > + Send;
    /// Stores or replaces an encrypted account root key envelope.
    fn put_account_key_envelope(
        &self,
        ctx: ::connectrpc::Context,
        request: ::buffa::view::OwnedView<
            crate::proto::kuku::sync::v1::PutAccountKeyEnvelopeRequestView<'static>,
        >,
    ) -> impl ::std::future::Future<
        Output = Result<
            (
                crate::proto::kuku::sync::v1::PutAccountKeyEnvelopeResponse,
                ::connectrpc::Context,
            ),
            ::connectrpc::ConnectError,
        >,
    > + Send;
    /// Creates an encrypted sync workspace owned by the authenticated user.
    fn create_workspace(
        &self,
        ctx: ::connectrpc::Context,
        request: ::buffa::view::OwnedView<
            crate::proto::kuku::sync::v1::CreateWorkspaceRequestView<'static>,
        >,
    ) -> impl ::std::future::Future<
        Output = Result<
            (
                crate::proto::kuku::sync::v1::CreateWorkspaceResponse,
                ::connectrpc::Context,
            ),
            ::connectrpc::ConnectError,
        >,
    > + Send;
    /// Lists sync workspaces owned by the authenticated user.
    fn list_workspaces(
        &self,
        ctx: ::connectrpc::Context,
        request: ::buffa::view::OwnedView<
            crate::proto::kuku::sync::v1::ListWorkspacesRequestView<'static>,
        >,
    ) -> impl ::std::future::Future<
        Output = Result<
            (
                crate::proto::kuku::sync::v1::ListWorkspacesResponse,
                ::connectrpc::Context,
            ),
            ::connectrpc::ConnectError,
        >,
    > + Send;
    /// Gets server-visible metadata for a sync workspace.
    fn get_workspace(
        &self,
        ctx: ::connectrpc::Context,
        request: ::buffa::view::OwnedView<
            crate::proto::kuku::sync::v1::GetWorkspaceRequestView<'static>,
        >,
    ) -> impl ::std::future::Future<
        Output = Result<
            (crate::proto::kuku::sync::v1::GetWorkspaceResponse, ::connectrpc::Context),
            ::connectrpc::ConnectError,
        >,
    > + Send;
    /// Updates encrypted account-level workspace display metadata.
    fn update_workspace_metadata(
        &self,
        ctx: ::connectrpc::Context,
        request: ::buffa::view::OwnedView<
            crate::proto::kuku::sync::v1::UpdateWorkspaceMetadataRequestView<'static>,
        >,
    ) -> impl ::std::future::Future<
        Output = Result<
            (
                crate::proto::kuku::sync::v1::UpdateWorkspaceMetadataResponse,
                ::connectrpc::Context,
            ),
            ::connectrpc::ConnectError,
        >,
    > + Send;
    /// Updates the account-wrapped workspace key for a workspace.
    fn update_workspace_key(
        &self,
        ctx: ::connectrpc::Context,
        request: ::buffa::view::OwnedView<
            crate::proto::kuku::sync::v1::UpdateWorkspaceKeyRequestView<'static>,
        >,
    ) -> impl ::std::future::Future<
        Output = Result<
            (
                crate::proto::kuku::sync::v1::UpdateWorkspaceKeyResponse,
                ::connectrpc::Context,
            ),
            ::connectrpc::ConnectError,
        >,
    > + Send;
    /// Registers a device signing key for a workspace.
    fn register_device(
        &self,
        ctx: ::connectrpc::Context,
        request: ::buffa::view::OwnedView<
            crate::proto::kuku::sync::v1::RegisterDeviceRequestView<'static>,
        >,
    ) -> impl ::std::future::Future<
        Output = Result<
            (
                crate::proto::kuku::sync::v1::RegisterDeviceResponse,
                ::connectrpc::Context,
            ),
            ::connectrpc::ConnectError,
        >,
    > + Send;
    /// Updates encrypted device display metadata after registration.
    fn update_device_metadata(
        &self,
        ctx: ::connectrpc::Context,
        request: ::buffa::view::OwnedView<
            crate::proto::kuku::sync::v1::UpdateDeviceMetadataRequestView<'static>,
        >,
    ) -> impl ::std::future::Future<
        Output = Result<
            (
                crate::proto::kuku::sync::v1::UpdateDeviceMetadataResponse,
                ::connectrpc::Context,
            ),
            ::connectrpc::ConnectError,
        >,
    > + Send;
    /// Lists encrypted workspace key envelopes.
    fn list_key_envelopes(
        &self,
        ctx: ::connectrpc::Context,
        request: ::buffa::view::OwnedView<
            crate::proto::kuku::sync::v1::ListKeyEnvelopesRequestView<'static>,
        >,
    ) -> impl ::std::future::Future<
        Output = Result<
            (
                crate::proto::kuku::sync::v1::ListKeyEnvelopesResponse,
                ::connectrpc::Context,
            ),
            ::connectrpc::ConnectError,
        >,
    > + Send;
    /// Stores or replaces an encrypted workspace key envelope.
    fn put_key_envelope(
        &self,
        ctx: ::connectrpc::Context,
        request: ::buffa::view::OwnedView<
            crate::proto::kuku::sync::v1::PutKeyEnvelopeRequestView<'static>,
        >,
    ) -> impl ::std::future::Future<
        Output = Result<
            (
                crate::proto::kuku::sync::v1::PutKeyEnvelopeResponse,
                ::connectrpc::Context,
            ),
            ::connectrpc::ConnectError,
        >,
    > + Send;
    /// Gets the current single-head sync log pointer.
    fn get_head(
        &self,
        ctx: ::connectrpc::Context,
        request: ::buffa::view::OwnedView<
            crate::proto::kuku::sync::v1::GetHeadRequestView<'static>,
        >,
    ) -> impl ::std::future::Future<
        Output = Result<
            (crate::proto::kuku::sync::v1::GetHeadResponse, ::connectrpc::Context),
            ::connectrpc::ConnectError,
        >,
    > + Send;
    /// Lists server-visible commit headers and object references.
    fn list_commits(
        &self,
        ctx: ::connectrpc::Context,
        request: ::buffa::view::OwnedView<
            crate::proto::kuku::sync::v1::ListCommitsRequestView<'static>,
        >,
    ) -> impl ::std::future::Future<
        Output = Result<
            (crate::proto::kuku::sync::v1::ListCommitsResponse, ::connectrpc::Context),
            ::connectrpc::ConnectError,
        >,
    > + Send;
    /// Publishes a commit header with single-head compare-and-swap semantics.
    /// The encrypted commit body bytes are uploaded separately as an object.
    fn publish_commit(
        &self,
        ctx: ::connectrpc::Context,
        request: ::buffa::view::OwnedView<
            crate::proto::kuku::sync::v1::PublishCommitRequestView<'static>,
        >,
    ) -> impl ::std::future::Future<
        Output = Result<
            (crate::proto::kuku::sync::v1::PublishCommitResponse, ::connectrpc::Context),
            ::connectrpc::ConnectError,
        >,
    > + Send;
    /// Reserves opaque server-generated object ids before client-side encryption.
    fn reserve_object_ids(
        &self,
        ctx: ::connectrpc::Context,
        request: ::buffa::view::OwnedView<
            crate::proto::kuku::sync::v1::ReserveObjectIdsRequestView<'static>,
        >,
    ) -> impl ::std::future::Future<
        Output = Result<
            (
                crate::proto::kuku::sync::v1::ReserveObjectIdsResponse,
                ::connectrpc::Context,
            ),
            ::connectrpc::ConnectError,
        >,
    > + Send;
    /// Creates presigned upload targets for reserved encrypted objects.
    fn create_object_upload_batch(
        &self,
        ctx: ::connectrpc::Context,
        request: ::buffa::view::OwnedView<
            crate::proto::kuku::sync::v1::CreateObjectUploadBatchRequestView<'static>,
        >,
    ) -> impl ::std::future::Future<
        Output = Result<
            (
                crate::proto::kuku::sync::v1::CreateObjectUploadBatchResponse,
                ::connectrpc::Context,
            ),
            ::connectrpc::ConnectError,
        >,
    > + Send;
    /// Completes encrypted object uploads and marks verified objects available.
    fn complete_object_upload_batch(
        &self,
        ctx: ::connectrpc::Context,
        request: ::buffa::view::OwnedView<
            crate::proto::kuku::sync::v1::CompleteObjectUploadBatchRequestView<'static>,
        >,
    ) -> impl ::std::future::Future<
        Output = Result<
            (
                crate::proto::kuku::sync::v1::CompleteObjectUploadBatchResponse,
                ::connectrpc::Context,
            ),
            ::connectrpc::ConnectError,
        >,
    > + Send;
    /// Creates presigned download targets for available encrypted objects.
    fn create_object_download_batch(
        &self,
        ctx: ::connectrpc::Context,
        request: ::buffa::view::OwnedView<
            crate::proto::kuku::sync::v1::CreateObjectDownloadBatchRequestView<'static>,
        >,
    ) -> impl ::std::future::Future<
        Output = Result<
            (
                crate::proto::kuku::sync::v1::CreateObjectDownloadBatchResponse,
                ::connectrpc::Context,
            ),
            ::connectrpc::ConnectError,
        >,
    > + Send;
    /// Deletes or disables a sync workspace. Destructive behavior is server policy.
    fn delete_workspace(
        &self,
        ctx: ::connectrpc::Context,
        request: ::buffa::view::OwnedView<
            crate::proto::kuku::sync::v1::DeleteWorkspaceRequestView<'static>,
        >,
    ) -> impl ::std::future::Future<
        Output = Result<
            (
                crate::proto::kuku::sync::v1::DeleteWorkspaceResponse,
                ::connectrpc::Context,
            ),
            ::connectrpc::ConnectError,
        >,
    > + Send;
    /// Uploads encrypted object bytes through the API for local development only.
    /// Production handlers must reject this RPC by config.
    fn upload_object_bytes_dev(
        &self,
        ctx: ::connectrpc::Context,
        request: ::buffa::view::OwnedView<
            crate::proto::kuku::sync::v1::UploadObjectBytesDevRequestView<'static>,
        >,
    ) -> impl ::std::future::Future<
        Output = Result<
            (
                crate::proto::kuku::sync::v1::UploadObjectBytesDevResponse,
                ::connectrpc::Context,
            ),
            ::connectrpc::ConnectError,
        >,
    > + Send;
    /// Downloads encrypted object bytes through the API for local development only.
    /// Production handlers must reject this RPC by config.
    fn download_object_bytes_dev(
        &self,
        ctx: ::connectrpc::Context,
        request: ::buffa::view::OwnedView<
            crate::proto::kuku::sync::v1::DownloadObjectBytesDevRequestView<'static>,
        >,
    ) -> impl ::std::future::Future<
        Output = Result<
            (
                crate::proto::kuku::sync::v1::DownloadObjectBytesDevResponse,
                ::connectrpc::Context,
            ),
            ::connectrpc::ConnectError,
        >,
    > + Send;
}
/// Extension trait for registering a service implementation with a Router.
///
/// This trait is automatically implemented for all types that implement the service trait.
///
/// # Example
///
/// ```rust,ignore
/// use std::sync::Arc;
///
/// let service = Arc::new(MyServiceImpl);
/// let router = service.register(Router::new());
/// ```
pub trait SyncServiceExt: SyncService {
    /// Register this service implementation with a Router.
    ///
    /// Takes ownership of the `Arc<Self>` and returns a new Router with
    /// this service's methods registered.
    fn register(
        self: ::std::sync::Arc<Self>,
        router: ::connectrpc::Router,
    ) -> ::connectrpc::Router;
}
impl<S: SyncService> SyncServiceExt for S {
    fn register(
        self: ::std::sync::Arc<Self>,
        router: ::connectrpc::Router,
    ) -> ::connectrpc::Router {
        router
            .route_view(
                SYNC_SERVICE_SERVICE_NAME,
                "GetAccountKeyState",
                {
                    let svc = ::std::sync::Arc::clone(&self);
                    ::connectrpc::view_handler_fn(move |ctx, req| {
                        let svc = ::std::sync::Arc::clone(&svc);
                        async move { svc.get_account_key_state(ctx, req).await }
                    })
                },
            )
            .route_view(
                SYNC_SERVICE_SERVICE_NAME,
                "CreateAccountKey",
                {
                    let svc = ::std::sync::Arc::clone(&self);
                    ::connectrpc::view_handler_fn(move |ctx, req| {
                        let svc = ::std::sync::Arc::clone(&svc);
                        async move { svc.create_account_key(ctx, req).await }
                    })
                },
            )
            .route_view(
                SYNC_SERVICE_SERVICE_NAME,
                "ListAccountKeyEnvelopes",
                {
                    let svc = ::std::sync::Arc::clone(&self);
                    ::connectrpc::view_handler_fn(move |ctx, req| {
                        let svc = ::std::sync::Arc::clone(&svc);
                        async move { svc.list_account_key_envelopes(ctx, req).await }
                    })
                },
            )
            .route_view(
                SYNC_SERVICE_SERVICE_NAME,
                "PutAccountKeyEnvelope",
                {
                    let svc = ::std::sync::Arc::clone(&self);
                    ::connectrpc::view_handler_fn(move |ctx, req| {
                        let svc = ::std::sync::Arc::clone(&svc);
                        async move { svc.put_account_key_envelope(ctx, req).await }
                    })
                },
            )
            .route_view(
                SYNC_SERVICE_SERVICE_NAME,
                "CreateWorkspace",
                {
                    let svc = ::std::sync::Arc::clone(&self);
                    ::connectrpc::view_handler_fn(move |ctx, req| {
                        let svc = ::std::sync::Arc::clone(&svc);
                        async move { svc.create_workspace(ctx, req).await }
                    })
                },
            )
            .route_view(
                SYNC_SERVICE_SERVICE_NAME,
                "ListWorkspaces",
                {
                    let svc = ::std::sync::Arc::clone(&self);
                    ::connectrpc::view_handler_fn(move |ctx, req| {
                        let svc = ::std::sync::Arc::clone(&svc);
                        async move { svc.list_workspaces(ctx, req).await }
                    })
                },
            )
            .route_view(
                SYNC_SERVICE_SERVICE_NAME,
                "GetWorkspace",
                {
                    let svc = ::std::sync::Arc::clone(&self);
                    ::connectrpc::view_handler_fn(move |ctx, req| {
                        let svc = ::std::sync::Arc::clone(&svc);
                        async move { svc.get_workspace(ctx, req).await }
                    })
                },
            )
            .route_view(
                SYNC_SERVICE_SERVICE_NAME,
                "UpdateWorkspaceMetadata",
                {
                    let svc = ::std::sync::Arc::clone(&self);
                    ::connectrpc::view_handler_fn(move |ctx, req| {
                        let svc = ::std::sync::Arc::clone(&svc);
                        async move { svc.update_workspace_metadata(ctx, req).await }
                    })
                },
            )
            .route_view(
                SYNC_SERVICE_SERVICE_NAME,
                "UpdateWorkspaceKey",
                {
                    let svc = ::std::sync::Arc::clone(&self);
                    ::connectrpc::view_handler_fn(move |ctx, req| {
                        let svc = ::std::sync::Arc::clone(&svc);
                        async move { svc.update_workspace_key(ctx, req).await }
                    })
                },
            )
            .route_view(
                SYNC_SERVICE_SERVICE_NAME,
                "RegisterDevice",
                {
                    let svc = ::std::sync::Arc::clone(&self);
                    ::connectrpc::view_handler_fn(move |ctx, req| {
                        let svc = ::std::sync::Arc::clone(&svc);
                        async move { svc.register_device(ctx, req).await }
                    })
                },
            )
            .route_view(
                SYNC_SERVICE_SERVICE_NAME,
                "UpdateDeviceMetadata",
                {
                    let svc = ::std::sync::Arc::clone(&self);
                    ::connectrpc::view_handler_fn(move |ctx, req| {
                        let svc = ::std::sync::Arc::clone(&svc);
                        async move { svc.update_device_metadata(ctx, req).await }
                    })
                },
            )
            .route_view(
                SYNC_SERVICE_SERVICE_NAME,
                "ListKeyEnvelopes",
                {
                    let svc = ::std::sync::Arc::clone(&self);
                    ::connectrpc::view_handler_fn(move |ctx, req| {
                        let svc = ::std::sync::Arc::clone(&svc);
                        async move { svc.list_key_envelopes(ctx, req).await }
                    })
                },
            )
            .route_view(
                SYNC_SERVICE_SERVICE_NAME,
                "PutKeyEnvelope",
                {
                    let svc = ::std::sync::Arc::clone(&self);
                    ::connectrpc::view_handler_fn(move |ctx, req| {
                        let svc = ::std::sync::Arc::clone(&svc);
                        async move { svc.put_key_envelope(ctx, req).await }
                    })
                },
            )
            .route_view(
                SYNC_SERVICE_SERVICE_NAME,
                "GetHead",
                {
                    let svc = ::std::sync::Arc::clone(&self);
                    ::connectrpc::view_handler_fn(move |ctx, req| {
                        let svc = ::std::sync::Arc::clone(&svc);
                        async move { svc.get_head(ctx, req).await }
                    })
                },
            )
            .route_view(
                SYNC_SERVICE_SERVICE_NAME,
                "ListCommits",
                {
                    let svc = ::std::sync::Arc::clone(&self);
                    ::connectrpc::view_handler_fn(move |ctx, req| {
                        let svc = ::std::sync::Arc::clone(&svc);
                        async move { svc.list_commits(ctx, req).await }
                    })
                },
            )
            .route_view(
                SYNC_SERVICE_SERVICE_NAME,
                "PublishCommit",
                {
                    let svc = ::std::sync::Arc::clone(&self);
                    ::connectrpc::view_handler_fn(move |ctx, req| {
                        let svc = ::std::sync::Arc::clone(&svc);
                        async move { svc.publish_commit(ctx, req).await }
                    })
                },
            )
            .route_view(
                SYNC_SERVICE_SERVICE_NAME,
                "ReserveObjectIds",
                {
                    let svc = ::std::sync::Arc::clone(&self);
                    ::connectrpc::view_handler_fn(move |ctx, req| {
                        let svc = ::std::sync::Arc::clone(&svc);
                        async move { svc.reserve_object_ids(ctx, req).await }
                    })
                },
            )
            .route_view(
                SYNC_SERVICE_SERVICE_NAME,
                "CreateObjectUploadBatch",
                {
                    let svc = ::std::sync::Arc::clone(&self);
                    ::connectrpc::view_handler_fn(move |ctx, req| {
                        let svc = ::std::sync::Arc::clone(&svc);
                        async move { svc.create_object_upload_batch(ctx, req).await }
                    })
                },
            )
            .route_view(
                SYNC_SERVICE_SERVICE_NAME,
                "CompleteObjectUploadBatch",
                {
                    let svc = ::std::sync::Arc::clone(&self);
                    ::connectrpc::view_handler_fn(move |ctx, req| {
                        let svc = ::std::sync::Arc::clone(&svc);
                        async move { svc.complete_object_upload_batch(ctx, req).await }
                    })
                },
            )
            .route_view(
                SYNC_SERVICE_SERVICE_NAME,
                "CreateObjectDownloadBatch",
                {
                    let svc = ::std::sync::Arc::clone(&self);
                    ::connectrpc::view_handler_fn(move |ctx, req| {
                        let svc = ::std::sync::Arc::clone(&svc);
                        async move { svc.create_object_download_batch(ctx, req).await }
                    })
                },
            )
            .route_view(
                SYNC_SERVICE_SERVICE_NAME,
                "DeleteWorkspace",
                {
                    let svc = ::std::sync::Arc::clone(&self);
                    ::connectrpc::view_handler_fn(move |ctx, req| {
                        let svc = ::std::sync::Arc::clone(&svc);
                        async move { svc.delete_workspace(ctx, req).await }
                    })
                },
            )
            .route_view(
                SYNC_SERVICE_SERVICE_NAME,
                "UploadObjectBytesDev",
                {
                    let svc = ::std::sync::Arc::clone(&self);
                    ::connectrpc::view_handler_fn(move |ctx, req| {
                        let svc = ::std::sync::Arc::clone(&svc);
                        async move { svc.upload_object_bytes_dev(ctx, req).await }
                    })
                },
            )
            .route_view(
                SYNC_SERVICE_SERVICE_NAME,
                "DownloadObjectBytesDev",
                {
                    let svc = ::std::sync::Arc::clone(&self);
                    ::connectrpc::view_handler_fn(move |ctx, req| {
                        let svc = ::std::sync::Arc::clone(&svc);
                        async move { svc.download_object_bytes_dev(ctx, req).await }
                    })
                },
            )
    }
}
/// Monomorphic dispatcher for `SyncService`.
///
/// Unlike `.register(Router)` which type-erases each method into an `Arc<dyn ErasedHandler>` stored in a `HashMap`, this struct dispatches via a compile-time `match` on method name: no vtable, no hash lookup.
///
/// # Example
///
/// ```rust,ignore
/// use connectrpc::ConnectRpcService;
///
/// let server = SyncServiceServer::new(MyImpl);
/// let service = ConnectRpcService::new(server);
/// // hand `service` to axum/hyper as a fallback_service
/// ```
pub struct SyncServiceServer<T> {
    inner: ::std::sync::Arc<T>,
}
impl<T: SyncService> SyncServiceServer<T> {
    /// Wrap a service implementation in a monomorphic dispatcher.
    pub fn new(service: T) -> Self {
        Self {
            inner: ::std::sync::Arc::new(service),
        }
    }
    /// Wrap an already-`Arc`'d service implementation.
    pub fn from_arc(inner: ::std::sync::Arc<T>) -> Self {
        Self { inner }
    }
}
impl<T> Clone for SyncServiceServer<T> {
    fn clone(&self) -> Self {
        Self {
            inner: ::std::sync::Arc::clone(&self.inner),
        }
    }
}
impl<T: SyncService> ::connectrpc::Dispatcher for SyncServiceServer<T> {
    #[inline]
    fn lookup(
        &self,
        path: &str,
    ) -> Option<::connectrpc::dispatcher::codegen::MethodDescriptor> {
        let method = path.strip_prefix("kuku.sync.v1.SyncService/")?;
        match method {
            "GetAccountKeyState" => {
                Some(::connectrpc::dispatcher::codegen::MethodDescriptor::unary(false))
            }
            "CreateAccountKey" => {
                Some(::connectrpc::dispatcher::codegen::MethodDescriptor::unary(false))
            }
            "ListAccountKeyEnvelopes" => {
                Some(::connectrpc::dispatcher::codegen::MethodDescriptor::unary(false))
            }
            "PutAccountKeyEnvelope" => {
                Some(::connectrpc::dispatcher::codegen::MethodDescriptor::unary(false))
            }
            "CreateWorkspace" => {
                Some(::connectrpc::dispatcher::codegen::MethodDescriptor::unary(false))
            }
            "ListWorkspaces" => {
                Some(::connectrpc::dispatcher::codegen::MethodDescriptor::unary(false))
            }
            "GetWorkspace" => {
                Some(::connectrpc::dispatcher::codegen::MethodDescriptor::unary(false))
            }
            "UpdateWorkspaceMetadata" => {
                Some(::connectrpc::dispatcher::codegen::MethodDescriptor::unary(false))
            }
            "UpdateWorkspaceKey" => {
                Some(::connectrpc::dispatcher::codegen::MethodDescriptor::unary(false))
            }
            "RegisterDevice" => {
                Some(::connectrpc::dispatcher::codegen::MethodDescriptor::unary(false))
            }
            "UpdateDeviceMetadata" => {
                Some(::connectrpc::dispatcher::codegen::MethodDescriptor::unary(false))
            }
            "ListKeyEnvelopes" => {
                Some(::connectrpc::dispatcher::codegen::MethodDescriptor::unary(false))
            }
            "PutKeyEnvelope" => {
                Some(::connectrpc::dispatcher::codegen::MethodDescriptor::unary(false))
            }
            "GetHead" => {
                Some(::connectrpc::dispatcher::codegen::MethodDescriptor::unary(false))
            }
            "ListCommits" => {
                Some(::connectrpc::dispatcher::codegen::MethodDescriptor::unary(false))
            }
            "PublishCommit" => {
                Some(::connectrpc::dispatcher::codegen::MethodDescriptor::unary(false))
            }
            "ReserveObjectIds" => {
                Some(::connectrpc::dispatcher::codegen::MethodDescriptor::unary(false))
            }
            "CreateObjectUploadBatch" => {
                Some(::connectrpc::dispatcher::codegen::MethodDescriptor::unary(false))
            }
            "CompleteObjectUploadBatch" => {
                Some(::connectrpc::dispatcher::codegen::MethodDescriptor::unary(false))
            }
            "CreateObjectDownloadBatch" => {
                Some(::connectrpc::dispatcher::codegen::MethodDescriptor::unary(false))
            }
            "DeleteWorkspace" => {
                Some(::connectrpc::dispatcher::codegen::MethodDescriptor::unary(false))
            }
            "UploadObjectBytesDev" => {
                Some(::connectrpc::dispatcher::codegen::MethodDescriptor::unary(false))
            }
            "DownloadObjectBytesDev" => {
                Some(::connectrpc::dispatcher::codegen::MethodDescriptor::unary(false))
            }
            _ => None,
        }
    }
    fn call_unary(
        &self,
        path: &str,
        ctx: ::connectrpc::Context,
        request: ::buffa::bytes::Bytes,
        format: ::connectrpc::CodecFormat,
    ) -> ::connectrpc::dispatcher::codegen::UnaryResult {
        let Some(method) = path.strip_prefix("kuku.sync.v1.SyncService/") else {
            return ::connectrpc::dispatcher::codegen::unimplemented_unary(path);
        };
        let _ = (&ctx, &request, &format);
        match method {
            "GetAccountKeyState" => {
                let svc = ::std::sync::Arc::clone(&self.inner);
                Box::pin(async move {
                    let req = ::connectrpc::dispatcher::codegen::decode_request_view::<
                        crate::proto::kuku::sync::v1::GetAccountKeyStateRequestView,
                    >(request, format)?;
                    let (res, ctx) = svc.get_account_key_state(ctx, req).await?;
                    let bytes = ::connectrpc::dispatcher::codegen::encode_response(
                        &res,
                        format,
                    )?;
                    Ok((bytes, ctx))
                })
            }
            "CreateAccountKey" => {
                let svc = ::std::sync::Arc::clone(&self.inner);
                Box::pin(async move {
                    let req = ::connectrpc::dispatcher::codegen::decode_request_view::<
                        crate::proto::kuku::sync::v1::CreateAccountKeyRequestView,
                    >(request, format)?;
                    let (res, ctx) = svc.create_account_key(ctx, req).await?;
                    let bytes = ::connectrpc::dispatcher::codegen::encode_response(
                        &res,
                        format,
                    )?;
                    Ok((bytes, ctx))
                })
            }
            "ListAccountKeyEnvelopes" => {
                let svc = ::std::sync::Arc::clone(&self.inner);
                Box::pin(async move {
                    let req = ::connectrpc::dispatcher::codegen::decode_request_view::<
                        crate::proto::kuku::sync::v1::ListAccountKeyEnvelopesRequestView,
                    >(request, format)?;
                    let (res, ctx) = svc.list_account_key_envelopes(ctx, req).await?;
                    let bytes = ::connectrpc::dispatcher::codegen::encode_response(
                        &res,
                        format,
                    )?;
                    Ok((bytes, ctx))
                })
            }
            "PutAccountKeyEnvelope" => {
                let svc = ::std::sync::Arc::clone(&self.inner);
                Box::pin(async move {
                    let req = ::connectrpc::dispatcher::codegen::decode_request_view::<
                        crate::proto::kuku::sync::v1::PutAccountKeyEnvelopeRequestView,
                    >(request, format)?;
                    let (res, ctx) = svc.put_account_key_envelope(ctx, req).await?;
                    let bytes = ::connectrpc::dispatcher::codegen::encode_response(
                        &res,
                        format,
                    )?;
                    Ok((bytes, ctx))
                })
            }
            "CreateWorkspace" => {
                let svc = ::std::sync::Arc::clone(&self.inner);
                Box::pin(async move {
                    let req = ::connectrpc::dispatcher::codegen::decode_request_view::<
                        crate::proto::kuku::sync::v1::CreateWorkspaceRequestView,
                    >(request, format)?;
                    let (res, ctx) = svc.create_workspace(ctx, req).await?;
                    let bytes = ::connectrpc::dispatcher::codegen::encode_response(
                        &res,
                        format,
                    )?;
                    Ok((bytes, ctx))
                })
            }
            "ListWorkspaces" => {
                let svc = ::std::sync::Arc::clone(&self.inner);
                Box::pin(async move {
                    let req = ::connectrpc::dispatcher::codegen::decode_request_view::<
                        crate::proto::kuku::sync::v1::ListWorkspacesRequestView,
                    >(request, format)?;
                    let (res, ctx) = svc.list_workspaces(ctx, req).await?;
                    let bytes = ::connectrpc::dispatcher::codegen::encode_response(
                        &res,
                        format,
                    )?;
                    Ok((bytes, ctx))
                })
            }
            "GetWorkspace" => {
                let svc = ::std::sync::Arc::clone(&self.inner);
                Box::pin(async move {
                    let req = ::connectrpc::dispatcher::codegen::decode_request_view::<
                        crate::proto::kuku::sync::v1::GetWorkspaceRequestView,
                    >(request, format)?;
                    let (res, ctx) = svc.get_workspace(ctx, req).await?;
                    let bytes = ::connectrpc::dispatcher::codegen::encode_response(
                        &res,
                        format,
                    )?;
                    Ok((bytes, ctx))
                })
            }
            "UpdateWorkspaceMetadata" => {
                let svc = ::std::sync::Arc::clone(&self.inner);
                Box::pin(async move {
                    let req = ::connectrpc::dispatcher::codegen::decode_request_view::<
                        crate::proto::kuku::sync::v1::UpdateWorkspaceMetadataRequestView,
                    >(request, format)?;
                    let (res, ctx) = svc.update_workspace_metadata(ctx, req).await?;
                    let bytes = ::connectrpc::dispatcher::codegen::encode_response(
                        &res,
                        format,
                    )?;
                    Ok((bytes, ctx))
                })
            }
            "UpdateWorkspaceKey" => {
                let svc = ::std::sync::Arc::clone(&self.inner);
                Box::pin(async move {
                    let req = ::connectrpc::dispatcher::codegen::decode_request_view::<
                        crate::proto::kuku::sync::v1::UpdateWorkspaceKeyRequestView,
                    >(request, format)?;
                    let (res, ctx) = svc.update_workspace_key(ctx, req).await?;
                    let bytes = ::connectrpc::dispatcher::codegen::encode_response(
                        &res,
                        format,
                    )?;
                    Ok((bytes, ctx))
                })
            }
            "RegisterDevice" => {
                let svc = ::std::sync::Arc::clone(&self.inner);
                Box::pin(async move {
                    let req = ::connectrpc::dispatcher::codegen::decode_request_view::<
                        crate::proto::kuku::sync::v1::RegisterDeviceRequestView,
                    >(request, format)?;
                    let (res, ctx) = svc.register_device(ctx, req).await?;
                    let bytes = ::connectrpc::dispatcher::codegen::encode_response(
                        &res,
                        format,
                    )?;
                    Ok((bytes, ctx))
                })
            }
            "UpdateDeviceMetadata" => {
                let svc = ::std::sync::Arc::clone(&self.inner);
                Box::pin(async move {
                    let req = ::connectrpc::dispatcher::codegen::decode_request_view::<
                        crate::proto::kuku::sync::v1::UpdateDeviceMetadataRequestView,
                    >(request, format)?;
                    let (res, ctx) = svc.update_device_metadata(ctx, req).await?;
                    let bytes = ::connectrpc::dispatcher::codegen::encode_response(
                        &res,
                        format,
                    )?;
                    Ok((bytes, ctx))
                })
            }
            "ListKeyEnvelopes" => {
                let svc = ::std::sync::Arc::clone(&self.inner);
                Box::pin(async move {
                    let req = ::connectrpc::dispatcher::codegen::decode_request_view::<
                        crate::proto::kuku::sync::v1::ListKeyEnvelopesRequestView,
                    >(request, format)?;
                    let (res, ctx) = svc.list_key_envelopes(ctx, req).await?;
                    let bytes = ::connectrpc::dispatcher::codegen::encode_response(
                        &res,
                        format,
                    )?;
                    Ok((bytes, ctx))
                })
            }
            "PutKeyEnvelope" => {
                let svc = ::std::sync::Arc::clone(&self.inner);
                Box::pin(async move {
                    let req = ::connectrpc::dispatcher::codegen::decode_request_view::<
                        crate::proto::kuku::sync::v1::PutKeyEnvelopeRequestView,
                    >(request, format)?;
                    let (res, ctx) = svc.put_key_envelope(ctx, req).await?;
                    let bytes = ::connectrpc::dispatcher::codegen::encode_response(
                        &res,
                        format,
                    )?;
                    Ok((bytes, ctx))
                })
            }
            "GetHead" => {
                let svc = ::std::sync::Arc::clone(&self.inner);
                Box::pin(async move {
                    let req = ::connectrpc::dispatcher::codegen::decode_request_view::<
                        crate::proto::kuku::sync::v1::GetHeadRequestView,
                    >(request, format)?;
                    let (res, ctx) = svc.get_head(ctx, req).await?;
                    let bytes = ::connectrpc::dispatcher::codegen::encode_response(
                        &res,
                        format,
                    )?;
                    Ok((bytes, ctx))
                })
            }
            "ListCommits" => {
                let svc = ::std::sync::Arc::clone(&self.inner);
                Box::pin(async move {
                    let req = ::connectrpc::dispatcher::codegen::decode_request_view::<
                        crate::proto::kuku::sync::v1::ListCommitsRequestView,
                    >(request, format)?;
                    let (res, ctx) = svc.list_commits(ctx, req).await?;
                    let bytes = ::connectrpc::dispatcher::codegen::encode_response(
                        &res,
                        format,
                    )?;
                    Ok((bytes, ctx))
                })
            }
            "PublishCommit" => {
                let svc = ::std::sync::Arc::clone(&self.inner);
                Box::pin(async move {
                    let req = ::connectrpc::dispatcher::codegen::decode_request_view::<
                        crate::proto::kuku::sync::v1::PublishCommitRequestView,
                    >(request, format)?;
                    let (res, ctx) = svc.publish_commit(ctx, req).await?;
                    let bytes = ::connectrpc::dispatcher::codegen::encode_response(
                        &res,
                        format,
                    )?;
                    Ok((bytes, ctx))
                })
            }
            "ReserveObjectIds" => {
                let svc = ::std::sync::Arc::clone(&self.inner);
                Box::pin(async move {
                    let req = ::connectrpc::dispatcher::codegen::decode_request_view::<
                        crate::proto::kuku::sync::v1::ReserveObjectIdsRequestView,
                    >(request, format)?;
                    let (res, ctx) = svc.reserve_object_ids(ctx, req).await?;
                    let bytes = ::connectrpc::dispatcher::codegen::encode_response(
                        &res,
                        format,
                    )?;
                    Ok((bytes, ctx))
                })
            }
            "CreateObjectUploadBatch" => {
                let svc = ::std::sync::Arc::clone(&self.inner);
                Box::pin(async move {
                    let req = ::connectrpc::dispatcher::codegen::decode_request_view::<
                        crate::proto::kuku::sync::v1::CreateObjectUploadBatchRequestView,
                    >(request, format)?;
                    let (res, ctx) = svc.create_object_upload_batch(ctx, req).await?;
                    let bytes = ::connectrpc::dispatcher::codegen::encode_response(
                        &res,
                        format,
                    )?;
                    Ok((bytes, ctx))
                })
            }
            "CompleteObjectUploadBatch" => {
                let svc = ::std::sync::Arc::clone(&self.inner);
                Box::pin(async move {
                    let req = ::connectrpc::dispatcher::codegen::decode_request_view::<
                        crate::proto::kuku::sync::v1::CompleteObjectUploadBatchRequestView,
                    >(request, format)?;
                    let (res, ctx) = svc.complete_object_upload_batch(ctx, req).await?;
                    let bytes = ::connectrpc::dispatcher::codegen::encode_response(
                        &res,
                        format,
                    )?;
                    Ok((bytes, ctx))
                })
            }
            "CreateObjectDownloadBatch" => {
                let svc = ::std::sync::Arc::clone(&self.inner);
                Box::pin(async move {
                    let req = ::connectrpc::dispatcher::codegen::decode_request_view::<
                        crate::proto::kuku::sync::v1::CreateObjectDownloadBatchRequestView,
                    >(request, format)?;
                    let (res, ctx) = svc.create_object_download_batch(ctx, req).await?;
                    let bytes = ::connectrpc::dispatcher::codegen::encode_response(
                        &res,
                        format,
                    )?;
                    Ok((bytes, ctx))
                })
            }
            "DeleteWorkspace" => {
                let svc = ::std::sync::Arc::clone(&self.inner);
                Box::pin(async move {
                    let req = ::connectrpc::dispatcher::codegen::decode_request_view::<
                        crate::proto::kuku::sync::v1::DeleteWorkspaceRequestView,
                    >(request, format)?;
                    let (res, ctx) = svc.delete_workspace(ctx, req).await?;
                    let bytes = ::connectrpc::dispatcher::codegen::encode_response(
                        &res,
                        format,
                    )?;
                    Ok((bytes, ctx))
                })
            }
            "UploadObjectBytesDev" => {
                let svc = ::std::sync::Arc::clone(&self.inner);
                Box::pin(async move {
                    let req = ::connectrpc::dispatcher::codegen::decode_request_view::<
                        crate::proto::kuku::sync::v1::UploadObjectBytesDevRequestView,
                    >(request, format)?;
                    let (res, ctx) = svc.upload_object_bytes_dev(ctx, req).await?;
                    let bytes = ::connectrpc::dispatcher::codegen::encode_response(
                        &res,
                        format,
                    )?;
                    Ok((bytes, ctx))
                })
            }
            "DownloadObjectBytesDev" => {
                let svc = ::std::sync::Arc::clone(&self.inner);
                Box::pin(async move {
                    let req = ::connectrpc::dispatcher::codegen::decode_request_view::<
                        crate::proto::kuku::sync::v1::DownloadObjectBytesDevRequestView,
                    >(request, format)?;
                    let (res, ctx) = svc.download_object_bytes_dev(ctx, req).await?;
                    let bytes = ::connectrpc::dispatcher::codegen::encode_response(
                        &res,
                        format,
                    )?;
                    Ok((bytes, ctx))
                })
            }
            _ => ::connectrpc::dispatcher::codegen::unimplemented_unary(path),
        }
    }
    fn call_server_streaming(
        &self,
        path: &str,
        ctx: ::connectrpc::Context,
        request: ::buffa::bytes::Bytes,
        format: ::connectrpc::CodecFormat,
    ) -> ::connectrpc::dispatcher::codegen::StreamingResult {
        let Some(method) = path.strip_prefix("kuku.sync.v1.SyncService/") else {
            return ::connectrpc::dispatcher::codegen::unimplemented_streaming(path);
        };
        let _ = (&ctx, &request, &format);
        match method {
            _ => ::connectrpc::dispatcher::codegen::unimplemented_streaming(path),
        }
    }
    fn call_client_streaming(
        &self,
        path: &str,
        ctx: ::connectrpc::Context,
        requests: ::connectrpc::dispatcher::codegen::RequestStream,
        format: ::connectrpc::CodecFormat,
    ) -> ::connectrpc::dispatcher::codegen::UnaryResult {
        let Some(method) = path.strip_prefix("kuku.sync.v1.SyncService/") else {
            return ::connectrpc::dispatcher::codegen::unimplemented_unary(path);
        };
        let _ = (&ctx, &requests, &format);
        match method {
            _ => ::connectrpc::dispatcher::codegen::unimplemented_unary(path),
        }
    }
    fn call_bidi_streaming(
        &self,
        path: &str,
        ctx: ::connectrpc::Context,
        requests: ::connectrpc::dispatcher::codegen::RequestStream,
        format: ::connectrpc::CodecFormat,
    ) -> ::connectrpc::dispatcher::codegen::StreamingResult {
        let Some(method) = path.strip_prefix("kuku.sync.v1.SyncService/") else {
            return ::connectrpc::dispatcher::codegen::unimplemented_streaming(path);
        };
        let _ = (&ctx, &requests, &format);
        match method {
            _ => ::connectrpc::dispatcher::codegen::unimplemented_streaming(path),
        }
    }
}
/// Client for this service.
///
/// Generic over `T: ClientTransport`. For **gRPC** (HTTP/2), use
/// `Http2Connection` — it has honest `poll_ready` and composes with
/// `tower::balance` for multi-connection load balancing. For **Connect
/// over HTTP/1.1** (or unknown protocol), use `HttpClient`.
///
/// # Example (gRPC / HTTP/2)
///
/// ```rust,ignore
/// use connectrpc::client::{Http2Connection, ClientConfig};
/// use connectrpc::Protocol;
///
/// let uri: http::Uri = "http://localhost:8080".parse()?;
/// let conn = Http2Connection::connect_plaintext(uri.clone()).await?.shared(1024);
/// let config = ClientConfig::new(uri).protocol(Protocol::Grpc);
///
/// let client = SyncServiceClient::new(conn, config);
/// let response = client.get_account_key_state(request).await?;
/// ```
///
/// # Example (Connect / HTTP/1.1 or ALPN)
///
/// ```rust,ignore
/// use connectrpc::client::{HttpClient, ClientConfig};
///
/// let http = HttpClient::plaintext();  // cleartext http:// only
/// let config = ClientConfig::new("http://localhost:8080".parse()?);
///
/// let client = SyncServiceClient::new(http, config);
/// let response = client.get_account_key_state(request).await?;
/// ```
///
/// # Working with the response
///
/// Unary calls return [`UnaryResponse<OwnedView<FooView>>`](::connectrpc::client::UnaryResponse).
/// The `OwnedView` derefs to the view, so field access is zero-copy:
///
/// ```rust,ignore
/// let resp = client.get_account_key_state(request).await?.into_view();
/// let name: &str = resp.name;  // borrow into the response buffer
/// ```
///
/// If you need the owned struct (e.g. to store or pass by value), use
/// [`into_owned()`](::connectrpc::client::UnaryResponse::into_owned):
///
/// ```rust,ignore
/// let owned = client.get_account_key_state(request).await?.into_owned();
/// ```
#[derive(Clone)]
pub struct SyncServiceClient<T> {
    transport: T,
    config: ::connectrpc::client::ClientConfig,
}
impl<T> SyncServiceClient<T>
where
    T: ::connectrpc::client::ClientTransport,
    <T::ResponseBody as ::http_body::Body>::Error: ::std::fmt::Display,
{
    /// Create a new client with the given transport and configuration.
    pub fn new(transport: T, config: ::connectrpc::client::ClientConfig) -> Self {
        Self { transport, config }
    }
    /// Get the client configuration.
    pub fn config(&self) -> &::connectrpc::client::ClientConfig {
        &self.config
    }
    /// Get a mutable reference to the client configuration.
    pub fn config_mut(&mut self) -> &mut ::connectrpc::client::ClientConfig {
        &mut self.config
    }
    /// Call the GetAccountKeyState RPC. Sends a request to /kuku.sync.v1.SyncService/GetAccountKeyState.
    pub async fn get_account_key_state(
        &self,
        request: crate::proto::kuku::sync::v1::GetAccountKeyStateRequest,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::sync::v1::GetAccountKeyStateResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        self.get_account_key_state_with_options(
                request,
                ::connectrpc::client::CallOptions::default(),
            )
            .await
    }
    /// Call the GetAccountKeyState RPC with explicit per-call options. Options override [`connectrpc::client::ClientConfig`] defaults.
    pub async fn get_account_key_state_with_options(
        &self,
        request: crate::proto::kuku::sync::v1::GetAccountKeyStateRequest,
        options: ::connectrpc::client::CallOptions,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::sync::v1::GetAccountKeyStateResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        ::connectrpc::client::call_unary(
                &self.transport,
                &self.config,
                SYNC_SERVICE_SERVICE_NAME,
                "GetAccountKeyState",
                request,
                options,
            )
            .await
    }
    /// Call the CreateAccountKey RPC. Sends a request to /kuku.sync.v1.SyncService/CreateAccountKey.
    pub async fn create_account_key(
        &self,
        request: crate::proto::kuku::sync::v1::CreateAccountKeyRequest,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::sync::v1::CreateAccountKeyResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        self.create_account_key_with_options(
                request,
                ::connectrpc::client::CallOptions::default(),
            )
            .await
    }
    /// Call the CreateAccountKey RPC with explicit per-call options. Options override [`connectrpc::client::ClientConfig`] defaults.
    pub async fn create_account_key_with_options(
        &self,
        request: crate::proto::kuku::sync::v1::CreateAccountKeyRequest,
        options: ::connectrpc::client::CallOptions,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::sync::v1::CreateAccountKeyResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        ::connectrpc::client::call_unary(
                &self.transport,
                &self.config,
                SYNC_SERVICE_SERVICE_NAME,
                "CreateAccountKey",
                request,
                options,
            )
            .await
    }
    /// Call the ListAccountKeyEnvelopes RPC. Sends a request to /kuku.sync.v1.SyncService/ListAccountKeyEnvelopes.
    pub async fn list_account_key_envelopes(
        &self,
        request: crate::proto::kuku::sync::v1::ListAccountKeyEnvelopesRequest,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::sync::v1::ListAccountKeyEnvelopesResponseView<
                    'static,
                >,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        self.list_account_key_envelopes_with_options(
                request,
                ::connectrpc::client::CallOptions::default(),
            )
            .await
    }
    /// Call the ListAccountKeyEnvelopes RPC with explicit per-call options. Options override [`connectrpc::client::ClientConfig`] defaults.
    pub async fn list_account_key_envelopes_with_options(
        &self,
        request: crate::proto::kuku::sync::v1::ListAccountKeyEnvelopesRequest,
        options: ::connectrpc::client::CallOptions,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::sync::v1::ListAccountKeyEnvelopesResponseView<
                    'static,
                >,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        ::connectrpc::client::call_unary(
                &self.transport,
                &self.config,
                SYNC_SERVICE_SERVICE_NAME,
                "ListAccountKeyEnvelopes",
                request,
                options,
            )
            .await
    }
    /// Call the PutAccountKeyEnvelope RPC. Sends a request to /kuku.sync.v1.SyncService/PutAccountKeyEnvelope.
    pub async fn put_account_key_envelope(
        &self,
        request: crate::proto::kuku::sync::v1::PutAccountKeyEnvelopeRequest,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::sync::v1::PutAccountKeyEnvelopeResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        self.put_account_key_envelope_with_options(
                request,
                ::connectrpc::client::CallOptions::default(),
            )
            .await
    }
    /// Call the PutAccountKeyEnvelope RPC with explicit per-call options. Options override [`connectrpc::client::ClientConfig`] defaults.
    pub async fn put_account_key_envelope_with_options(
        &self,
        request: crate::proto::kuku::sync::v1::PutAccountKeyEnvelopeRequest,
        options: ::connectrpc::client::CallOptions,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::sync::v1::PutAccountKeyEnvelopeResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        ::connectrpc::client::call_unary(
                &self.transport,
                &self.config,
                SYNC_SERVICE_SERVICE_NAME,
                "PutAccountKeyEnvelope",
                request,
                options,
            )
            .await
    }
    /// Call the CreateWorkspace RPC. Sends a request to /kuku.sync.v1.SyncService/CreateWorkspace.
    pub async fn create_workspace(
        &self,
        request: crate::proto::kuku::sync::v1::CreateWorkspaceRequest,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::sync::v1::CreateWorkspaceResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        self.create_workspace_with_options(
                request,
                ::connectrpc::client::CallOptions::default(),
            )
            .await
    }
    /// Call the CreateWorkspace RPC with explicit per-call options. Options override [`connectrpc::client::ClientConfig`] defaults.
    pub async fn create_workspace_with_options(
        &self,
        request: crate::proto::kuku::sync::v1::CreateWorkspaceRequest,
        options: ::connectrpc::client::CallOptions,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::sync::v1::CreateWorkspaceResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        ::connectrpc::client::call_unary(
                &self.transport,
                &self.config,
                SYNC_SERVICE_SERVICE_NAME,
                "CreateWorkspace",
                request,
                options,
            )
            .await
    }
    /// Call the ListWorkspaces RPC. Sends a request to /kuku.sync.v1.SyncService/ListWorkspaces.
    pub async fn list_workspaces(
        &self,
        request: crate::proto::kuku::sync::v1::ListWorkspacesRequest,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::sync::v1::ListWorkspacesResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        self.list_workspaces_with_options(
                request,
                ::connectrpc::client::CallOptions::default(),
            )
            .await
    }
    /// Call the ListWorkspaces RPC with explicit per-call options. Options override [`connectrpc::client::ClientConfig`] defaults.
    pub async fn list_workspaces_with_options(
        &self,
        request: crate::proto::kuku::sync::v1::ListWorkspacesRequest,
        options: ::connectrpc::client::CallOptions,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::sync::v1::ListWorkspacesResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        ::connectrpc::client::call_unary(
                &self.transport,
                &self.config,
                SYNC_SERVICE_SERVICE_NAME,
                "ListWorkspaces",
                request,
                options,
            )
            .await
    }
    /// Call the GetWorkspace RPC. Sends a request to /kuku.sync.v1.SyncService/GetWorkspace.
    pub async fn get_workspace(
        &self,
        request: crate::proto::kuku::sync::v1::GetWorkspaceRequest,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::sync::v1::GetWorkspaceResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        self.get_workspace_with_options(
                request,
                ::connectrpc::client::CallOptions::default(),
            )
            .await
    }
    /// Call the GetWorkspace RPC with explicit per-call options. Options override [`connectrpc::client::ClientConfig`] defaults.
    pub async fn get_workspace_with_options(
        &self,
        request: crate::proto::kuku::sync::v1::GetWorkspaceRequest,
        options: ::connectrpc::client::CallOptions,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::sync::v1::GetWorkspaceResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        ::connectrpc::client::call_unary(
                &self.transport,
                &self.config,
                SYNC_SERVICE_SERVICE_NAME,
                "GetWorkspace",
                request,
                options,
            )
            .await
    }
    /// Call the UpdateWorkspaceMetadata RPC. Sends a request to /kuku.sync.v1.SyncService/UpdateWorkspaceMetadata.
    pub async fn update_workspace_metadata(
        &self,
        request: crate::proto::kuku::sync::v1::UpdateWorkspaceMetadataRequest,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::sync::v1::UpdateWorkspaceMetadataResponseView<
                    'static,
                >,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        self.update_workspace_metadata_with_options(
                request,
                ::connectrpc::client::CallOptions::default(),
            )
            .await
    }
    /// Call the UpdateWorkspaceMetadata RPC with explicit per-call options. Options override [`connectrpc::client::ClientConfig`] defaults.
    pub async fn update_workspace_metadata_with_options(
        &self,
        request: crate::proto::kuku::sync::v1::UpdateWorkspaceMetadataRequest,
        options: ::connectrpc::client::CallOptions,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::sync::v1::UpdateWorkspaceMetadataResponseView<
                    'static,
                >,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        ::connectrpc::client::call_unary(
                &self.transport,
                &self.config,
                SYNC_SERVICE_SERVICE_NAME,
                "UpdateWorkspaceMetadata",
                request,
                options,
            )
            .await
    }
    /// Call the UpdateWorkspaceKey RPC. Sends a request to /kuku.sync.v1.SyncService/UpdateWorkspaceKey.
    pub async fn update_workspace_key(
        &self,
        request: crate::proto::kuku::sync::v1::UpdateWorkspaceKeyRequest,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::sync::v1::UpdateWorkspaceKeyResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        self.update_workspace_key_with_options(
                request,
                ::connectrpc::client::CallOptions::default(),
            )
            .await
    }
    /// Call the UpdateWorkspaceKey RPC with explicit per-call options. Options override [`connectrpc::client::ClientConfig`] defaults.
    pub async fn update_workspace_key_with_options(
        &self,
        request: crate::proto::kuku::sync::v1::UpdateWorkspaceKeyRequest,
        options: ::connectrpc::client::CallOptions,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::sync::v1::UpdateWorkspaceKeyResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        ::connectrpc::client::call_unary(
                &self.transport,
                &self.config,
                SYNC_SERVICE_SERVICE_NAME,
                "UpdateWorkspaceKey",
                request,
                options,
            )
            .await
    }
    /// Call the RegisterDevice RPC. Sends a request to /kuku.sync.v1.SyncService/RegisterDevice.
    pub async fn register_device(
        &self,
        request: crate::proto::kuku::sync::v1::RegisterDeviceRequest,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::sync::v1::RegisterDeviceResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        self.register_device_with_options(
                request,
                ::connectrpc::client::CallOptions::default(),
            )
            .await
    }
    /// Call the RegisterDevice RPC with explicit per-call options. Options override [`connectrpc::client::ClientConfig`] defaults.
    pub async fn register_device_with_options(
        &self,
        request: crate::proto::kuku::sync::v1::RegisterDeviceRequest,
        options: ::connectrpc::client::CallOptions,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::sync::v1::RegisterDeviceResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        ::connectrpc::client::call_unary(
                &self.transport,
                &self.config,
                SYNC_SERVICE_SERVICE_NAME,
                "RegisterDevice",
                request,
                options,
            )
            .await
    }
    /// Call the UpdateDeviceMetadata RPC. Sends a request to /kuku.sync.v1.SyncService/UpdateDeviceMetadata.
    pub async fn update_device_metadata(
        &self,
        request: crate::proto::kuku::sync::v1::UpdateDeviceMetadataRequest,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::sync::v1::UpdateDeviceMetadataResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        self.update_device_metadata_with_options(
                request,
                ::connectrpc::client::CallOptions::default(),
            )
            .await
    }
    /// Call the UpdateDeviceMetadata RPC with explicit per-call options. Options override [`connectrpc::client::ClientConfig`] defaults.
    pub async fn update_device_metadata_with_options(
        &self,
        request: crate::proto::kuku::sync::v1::UpdateDeviceMetadataRequest,
        options: ::connectrpc::client::CallOptions,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::sync::v1::UpdateDeviceMetadataResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        ::connectrpc::client::call_unary(
                &self.transport,
                &self.config,
                SYNC_SERVICE_SERVICE_NAME,
                "UpdateDeviceMetadata",
                request,
                options,
            )
            .await
    }
    /// Call the ListKeyEnvelopes RPC. Sends a request to /kuku.sync.v1.SyncService/ListKeyEnvelopes.
    pub async fn list_key_envelopes(
        &self,
        request: crate::proto::kuku::sync::v1::ListKeyEnvelopesRequest,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::sync::v1::ListKeyEnvelopesResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        self.list_key_envelopes_with_options(
                request,
                ::connectrpc::client::CallOptions::default(),
            )
            .await
    }
    /// Call the ListKeyEnvelopes RPC with explicit per-call options. Options override [`connectrpc::client::ClientConfig`] defaults.
    pub async fn list_key_envelopes_with_options(
        &self,
        request: crate::proto::kuku::sync::v1::ListKeyEnvelopesRequest,
        options: ::connectrpc::client::CallOptions,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::sync::v1::ListKeyEnvelopesResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        ::connectrpc::client::call_unary(
                &self.transport,
                &self.config,
                SYNC_SERVICE_SERVICE_NAME,
                "ListKeyEnvelopes",
                request,
                options,
            )
            .await
    }
    /// Call the PutKeyEnvelope RPC. Sends a request to /kuku.sync.v1.SyncService/PutKeyEnvelope.
    pub async fn put_key_envelope(
        &self,
        request: crate::proto::kuku::sync::v1::PutKeyEnvelopeRequest,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::sync::v1::PutKeyEnvelopeResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        self.put_key_envelope_with_options(
                request,
                ::connectrpc::client::CallOptions::default(),
            )
            .await
    }
    /// Call the PutKeyEnvelope RPC with explicit per-call options. Options override [`connectrpc::client::ClientConfig`] defaults.
    pub async fn put_key_envelope_with_options(
        &self,
        request: crate::proto::kuku::sync::v1::PutKeyEnvelopeRequest,
        options: ::connectrpc::client::CallOptions,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::sync::v1::PutKeyEnvelopeResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        ::connectrpc::client::call_unary(
                &self.transport,
                &self.config,
                SYNC_SERVICE_SERVICE_NAME,
                "PutKeyEnvelope",
                request,
                options,
            )
            .await
    }
    /// Call the GetHead RPC. Sends a request to /kuku.sync.v1.SyncService/GetHead.
    pub async fn get_head(
        &self,
        request: crate::proto::kuku::sync::v1::GetHeadRequest,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::sync::v1::GetHeadResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        self.get_head_with_options(request, ::connectrpc::client::CallOptions::default())
            .await
    }
    /// Call the GetHead RPC with explicit per-call options. Options override [`connectrpc::client::ClientConfig`] defaults.
    pub async fn get_head_with_options(
        &self,
        request: crate::proto::kuku::sync::v1::GetHeadRequest,
        options: ::connectrpc::client::CallOptions,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::sync::v1::GetHeadResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        ::connectrpc::client::call_unary(
                &self.transport,
                &self.config,
                SYNC_SERVICE_SERVICE_NAME,
                "GetHead",
                request,
                options,
            )
            .await
    }
    /// Call the ListCommits RPC. Sends a request to /kuku.sync.v1.SyncService/ListCommits.
    pub async fn list_commits(
        &self,
        request: crate::proto::kuku::sync::v1::ListCommitsRequest,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::sync::v1::ListCommitsResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        self.list_commits_with_options(
                request,
                ::connectrpc::client::CallOptions::default(),
            )
            .await
    }
    /// Call the ListCommits RPC with explicit per-call options. Options override [`connectrpc::client::ClientConfig`] defaults.
    pub async fn list_commits_with_options(
        &self,
        request: crate::proto::kuku::sync::v1::ListCommitsRequest,
        options: ::connectrpc::client::CallOptions,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::sync::v1::ListCommitsResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        ::connectrpc::client::call_unary(
                &self.transport,
                &self.config,
                SYNC_SERVICE_SERVICE_NAME,
                "ListCommits",
                request,
                options,
            )
            .await
    }
    /// Call the PublishCommit RPC. Sends a request to /kuku.sync.v1.SyncService/PublishCommit.
    pub async fn publish_commit(
        &self,
        request: crate::proto::kuku::sync::v1::PublishCommitRequest,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::sync::v1::PublishCommitResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        self.publish_commit_with_options(
                request,
                ::connectrpc::client::CallOptions::default(),
            )
            .await
    }
    /// Call the PublishCommit RPC with explicit per-call options. Options override [`connectrpc::client::ClientConfig`] defaults.
    pub async fn publish_commit_with_options(
        &self,
        request: crate::proto::kuku::sync::v1::PublishCommitRequest,
        options: ::connectrpc::client::CallOptions,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::sync::v1::PublishCommitResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        ::connectrpc::client::call_unary(
                &self.transport,
                &self.config,
                SYNC_SERVICE_SERVICE_NAME,
                "PublishCommit",
                request,
                options,
            )
            .await
    }
    /// Call the ReserveObjectIds RPC. Sends a request to /kuku.sync.v1.SyncService/ReserveObjectIds.
    pub async fn reserve_object_ids(
        &self,
        request: crate::proto::kuku::sync::v1::ReserveObjectIdsRequest,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::sync::v1::ReserveObjectIdsResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        self.reserve_object_ids_with_options(
                request,
                ::connectrpc::client::CallOptions::default(),
            )
            .await
    }
    /// Call the ReserveObjectIds RPC with explicit per-call options. Options override [`connectrpc::client::ClientConfig`] defaults.
    pub async fn reserve_object_ids_with_options(
        &self,
        request: crate::proto::kuku::sync::v1::ReserveObjectIdsRequest,
        options: ::connectrpc::client::CallOptions,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::sync::v1::ReserveObjectIdsResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        ::connectrpc::client::call_unary(
                &self.transport,
                &self.config,
                SYNC_SERVICE_SERVICE_NAME,
                "ReserveObjectIds",
                request,
                options,
            )
            .await
    }
    /// Call the CreateObjectUploadBatch RPC. Sends a request to /kuku.sync.v1.SyncService/CreateObjectUploadBatch.
    pub async fn create_object_upload_batch(
        &self,
        request: crate::proto::kuku::sync::v1::CreateObjectUploadBatchRequest,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::sync::v1::CreateObjectUploadBatchResponseView<
                    'static,
                >,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        self.create_object_upload_batch_with_options(
                request,
                ::connectrpc::client::CallOptions::default(),
            )
            .await
    }
    /// Call the CreateObjectUploadBatch RPC with explicit per-call options. Options override [`connectrpc::client::ClientConfig`] defaults.
    pub async fn create_object_upload_batch_with_options(
        &self,
        request: crate::proto::kuku::sync::v1::CreateObjectUploadBatchRequest,
        options: ::connectrpc::client::CallOptions,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::sync::v1::CreateObjectUploadBatchResponseView<
                    'static,
                >,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        ::connectrpc::client::call_unary(
                &self.transport,
                &self.config,
                SYNC_SERVICE_SERVICE_NAME,
                "CreateObjectUploadBatch",
                request,
                options,
            )
            .await
    }
    /// Call the CompleteObjectUploadBatch RPC. Sends a request to /kuku.sync.v1.SyncService/CompleteObjectUploadBatch.
    pub async fn complete_object_upload_batch(
        &self,
        request: crate::proto::kuku::sync::v1::CompleteObjectUploadBatchRequest,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::sync::v1::CompleteObjectUploadBatchResponseView<
                    'static,
                >,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        self.complete_object_upload_batch_with_options(
                request,
                ::connectrpc::client::CallOptions::default(),
            )
            .await
    }
    /// Call the CompleteObjectUploadBatch RPC with explicit per-call options. Options override [`connectrpc::client::ClientConfig`] defaults.
    pub async fn complete_object_upload_batch_with_options(
        &self,
        request: crate::proto::kuku::sync::v1::CompleteObjectUploadBatchRequest,
        options: ::connectrpc::client::CallOptions,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::sync::v1::CompleteObjectUploadBatchResponseView<
                    'static,
                >,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        ::connectrpc::client::call_unary(
                &self.transport,
                &self.config,
                SYNC_SERVICE_SERVICE_NAME,
                "CompleteObjectUploadBatch",
                request,
                options,
            )
            .await
    }
    /// Call the CreateObjectDownloadBatch RPC. Sends a request to /kuku.sync.v1.SyncService/CreateObjectDownloadBatch.
    pub async fn create_object_download_batch(
        &self,
        request: crate::proto::kuku::sync::v1::CreateObjectDownloadBatchRequest,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::sync::v1::CreateObjectDownloadBatchResponseView<
                    'static,
                >,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        self.create_object_download_batch_with_options(
                request,
                ::connectrpc::client::CallOptions::default(),
            )
            .await
    }
    /// Call the CreateObjectDownloadBatch RPC with explicit per-call options. Options override [`connectrpc::client::ClientConfig`] defaults.
    pub async fn create_object_download_batch_with_options(
        &self,
        request: crate::proto::kuku::sync::v1::CreateObjectDownloadBatchRequest,
        options: ::connectrpc::client::CallOptions,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::sync::v1::CreateObjectDownloadBatchResponseView<
                    'static,
                >,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        ::connectrpc::client::call_unary(
                &self.transport,
                &self.config,
                SYNC_SERVICE_SERVICE_NAME,
                "CreateObjectDownloadBatch",
                request,
                options,
            )
            .await
    }
    /// Call the DeleteWorkspace RPC. Sends a request to /kuku.sync.v1.SyncService/DeleteWorkspace.
    pub async fn delete_workspace(
        &self,
        request: crate::proto::kuku::sync::v1::DeleteWorkspaceRequest,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::sync::v1::DeleteWorkspaceResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        self.delete_workspace_with_options(
                request,
                ::connectrpc::client::CallOptions::default(),
            )
            .await
    }
    /// Call the DeleteWorkspace RPC with explicit per-call options. Options override [`connectrpc::client::ClientConfig`] defaults.
    pub async fn delete_workspace_with_options(
        &self,
        request: crate::proto::kuku::sync::v1::DeleteWorkspaceRequest,
        options: ::connectrpc::client::CallOptions,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::sync::v1::DeleteWorkspaceResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        ::connectrpc::client::call_unary(
                &self.transport,
                &self.config,
                SYNC_SERVICE_SERVICE_NAME,
                "DeleteWorkspace",
                request,
                options,
            )
            .await
    }
    /// Call the UploadObjectBytesDev RPC. Sends a request to /kuku.sync.v1.SyncService/UploadObjectBytesDev.
    pub async fn upload_object_bytes_dev(
        &self,
        request: crate::proto::kuku::sync::v1::UploadObjectBytesDevRequest,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::sync::v1::UploadObjectBytesDevResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        self.upload_object_bytes_dev_with_options(
                request,
                ::connectrpc::client::CallOptions::default(),
            )
            .await
    }
    /// Call the UploadObjectBytesDev RPC with explicit per-call options. Options override [`connectrpc::client::ClientConfig`] defaults.
    pub async fn upload_object_bytes_dev_with_options(
        &self,
        request: crate::proto::kuku::sync::v1::UploadObjectBytesDevRequest,
        options: ::connectrpc::client::CallOptions,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::sync::v1::UploadObjectBytesDevResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        ::connectrpc::client::call_unary(
                &self.transport,
                &self.config,
                SYNC_SERVICE_SERVICE_NAME,
                "UploadObjectBytesDev",
                request,
                options,
            )
            .await
    }
    /// Call the DownloadObjectBytesDev RPC. Sends a request to /kuku.sync.v1.SyncService/DownloadObjectBytesDev.
    pub async fn download_object_bytes_dev(
        &self,
        request: crate::proto::kuku::sync::v1::DownloadObjectBytesDevRequest,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::sync::v1::DownloadObjectBytesDevResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        self.download_object_bytes_dev_with_options(
                request,
                ::connectrpc::client::CallOptions::default(),
            )
            .await
    }
    /// Call the DownloadObjectBytesDev RPC with explicit per-call options. Options override [`connectrpc::client::ClientConfig`] defaults.
    pub async fn download_object_bytes_dev_with_options(
        &self,
        request: crate::proto::kuku::sync::v1::DownloadObjectBytesDevRequest,
        options: ::connectrpc::client::CallOptions,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::sync::v1::DownloadObjectBytesDevResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        ::connectrpc::client::call_unary(
                &self.transport,
                &self.config,
                SYNC_SERVICE_SERVICE_NAME,
                "DownloadObjectBytesDev",
                request,
                options,
            )
            .await
    }
}
