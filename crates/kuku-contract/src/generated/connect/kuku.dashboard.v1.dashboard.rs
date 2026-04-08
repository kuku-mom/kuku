/// Full service name for this service.
pub const DASHBOARD_SERVICE_SERVICE_NAME: &str = "kuku.dashboard.v1.DashboardService";
/// ---------------------------------------------------------------------------
/// DashboardService - dashboard service
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
pub trait DashboardService: Send + Sync + 'static {
    /// Gets subscription information.
    /// - Returns the currently authenticated user's subscription information.
    /// - Requires cookie authentication.
    fn subscription(
        &self,
        ctx: ::connectrpc::Context,
        request: ::buffa::view::OwnedView<
            crate::proto::kuku::dashboard::v1::SubscriptionRequestView<'static>,
        >,
    ) -> impl ::std::future::Future<
        Output = Result<
            (
                crate::proto::kuku::dashboard::v1::SubscriptionResponse,
                ::connectrpc::Context,
            ),
            ::connectrpc::ConnectError,
        >,
    > + Send;
    /// Gets current usage.
    /// - Returns AI request and token usage for the current subscription period.
    /// - Requires cookie authentication.
    fn current_usage(
        &self,
        ctx: ::connectrpc::Context,
        request: ::buffa::view::OwnedView<
            crate::proto::kuku::dashboard::v1::CurrentUsageRequestView<'static>,
        >,
    ) -> impl ::std::future::Future<
        Output = Result<
            (
                crate::proto::kuku::dashboard::v1::CurrentUsageResponse,
                ::connectrpc::Context,
            ),
            ::connectrpc::ConnectError,
        >,
    > + Send;
    /// Gets daily usage statistics.
    /// - Returns daily usage data for analytics charts.
    /// - Requires cookie authentication.
    fn usage_stats(
        &self,
        ctx: ::connectrpc::Context,
        request: ::buffa::view::OwnedView<
            crate::proto::kuku::dashboard::v1::UsageStatsRequestView<'static>,
        >,
    ) -> impl ::std::future::Future<
        Output = Result<
            (
                crate::proto::kuku::dashboard::v1::UsageStatsResponse,
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
pub trait DashboardServiceExt: DashboardService {
    /// Register this service implementation with a Router.
    ///
    /// Takes ownership of the `Arc<Self>` and returns a new Router with
    /// this service's methods registered.
    fn register(
        self: ::std::sync::Arc<Self>,
        router: ::connectrpc::Router,
    ) -> ::connectrpc::Router;
}
impl<S: DashboardService> DashboardServiceExt for S {
    fn register(
        self: ::std::sync::Arc<Self>,
        router: ::connectrpc::Router,
    ) -> ::connectrpc::Router {
        router
            .route_view(
                DASHBOARD_SERVICE_SERVICE_NAME,
                "Subscription",
                {
                    let svc = ::std::sync::Arc::clone(&self);
                    ::connectrpc::view_handler_fn(move |ctx, req| {
                        let svc = ::std::sync::Arc::clone(&svc);
                        async move { svc.subscription(ctx, req).await }
                    })
                },
            )
            .route_view(
                DASHBOARD_SERVICE_SERVICE_NAME,
                "CurrentUsage",
                {
                    let svc = ::std::sync::Arc::clone(&self);
                    ::connectrpc::view_handler_fn(move |ctx, req| {
                        let svc = ::std::sync::Arc::clone(&svc);
                        async move { svc.current_usage(ctx, req).await }
                    })
                },
            )
            .route_view(
                DASHBOARD_SERVICE_SERVICE_NAME,
                "UsageStats",
                {
                    let svc = ::std::sync::Arc::clone(&self);
                    ::connectrpc::view_handler_fn(move |ctx, req| {
                        let svc = ::std::sync::Arc::clone(&svc);
                        async move { svc.usage_stats(ctx, req).await }
                    })
                },
            )
    }
}
/// Monomorphic dispatcher for `DashboardService`.
///
/// Unlike `.register(Router)` which type-erases each method into an `Arc<dyn ErasedHandler>` stored in a `HashMap`, this struct dispatches via a compile-time `match` on method name: no vtable, no hash lookup.
///
/// # Example
///
/// ```rust,ignore
/// use connectrpc::ConnectRpcService;
///
/// let server = DashboardServiceServer::new(MyImpl);
/// let service = ConnectRpcService::new(server);
/// // hand `service` to axum/hyper as a fallback_service
/// ```
pub struct DashboardServiceServer<T> {
    inner: ::std::sync::Arc<T>,
}
impl<T: DashboardService> DashboardServiceServer<T> {
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
impl<T> Clone for DashboardServiceServer<T> {
    fn clone(&self) -> Self {
        Self {
            inner: ::std::sync::Arc::clone(&self.inner),
        }
    }
}
impl<T: DashboardService> ::connectrpc::Dispatcher for DashboardServiceServer<T> {
    #[inline]
    fn lookup(
        &self,
        path: &str,
    ) -> Option<::connectrpc::dispatcher::codegen::MethodDescriptor> {
        let method = path.strip_prefix("kuku.dashboard.v1.DashboardService/")?;
        match method {
            "Subscription" => {
                Some(::connectrpc::dispatcher::codegen::MethodDescriptor::unary(false))
            }
            "CurrentUsage" => {
                Some(::connectrpc::dispatcher::codegen::MethodDescriptor::unary(false))
            }
            "UsageStats" => {
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
        let Some(method) = path.strip_prefix("kuku.dashboard.v1.DashboardService/") else {
            return ::connectrpc::dispatcher::codegen::unimplemented_unary(path);
        };
        let _ = (&ctx, &request, &format);
        match method {
            "Subscription" => {
                let svc = ::std::sync::Arc::clone(&self.inner);
                Box::pin(async move {
                    let req = ::connectrpc::dispatcher::codegen::decode_request_view::<
                        crate::proto::kuku::dashboard::v1::SubscriptionRequestView,
                    >(request, format)?;
                    let (res, ctx) = svc.subscription(ctx, req).await?;
                    let bytes = ::connectrpc::dispatcher::codegen::encode_response(
                        &res,
                        format,
                    )?;
                    Ok((bytes, ctx))
                })
            }
            "CurrentUsage" => {
                let svc = ::std::sync::Arc::clone(&self.inner);
                Box::pin(async move {
                    let req = ::connectrpc::dispatcher::codegen::decode_request_view::<
                        crate::proto::kuku::dashboard::v1::CurrentUsageRequestView,
                    >(request, format)?;
                    let (res, ctx) = svc.current_usage(ctx, req).await?;
                    let bytes = ::connectrpc::dispatcher::codegen::encode_response(
                        &res,
                        format,
                    )?;
                    Ok((bytes, ctx))
                })
            }
            "UsageStats" => {
                let svc = ::std::sync::Arc::clone(&self.inner);
                Box::pin(async move {
                    let req = ::connectrpc::dispatcher::codegen::decode_request_view::<
                        crate::proto::kuku::dashboard::v1::UsageStatsRequestView,
                    >(request, format)?;
                    let (res, ctx) = svc.usage_stats(ctx, req).await?;
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
        let Some(method) = path.strip_prefix("kuku.dashboard.v1.DashboardService/") else {
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
        let Some(method) = path.strip_prefix("kuku.dashboard.v1.DashboardService/") else {
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
        let Some(method) = path.strip_prefix("kuku.dashboard.v1.DashboardService/") else {
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
/// let client = DashboardServiceClient::new(conn, config);
/// let response = client.subscription(request).await?;
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
/// let client = DashboardServiceClient::new(http, config);
/// let response = client.subscription(request).await?;
/// ```
///
/// # Working with the response
///
/// Unary calls return [`UnaryResponse<OwnedView<FooView>>`](::connectrpc::client::UnaryResponse).
/// The `OwnedView` derefs to the view, so field access is zero-copy:
///
/// ```rust,ignore
/// let resp = client.subscription(request).await?.into_view();
/// let name: &str = resp.name;  // borrow into the response buffer
/// ```
///
/// If you need the owned struct (e.g. to store or pass by value), use
/// [`into_owned()`](::connectrpc::client::UnaryResponse::into_owned):
///
/// ```rust,ignore
/// let owned = client.subscription(request).await?.into_owned();
/// ```
#[derive(Clone)]
pub struct DashboardServiceClient<T> {
    transport: T,
    config: ::connectrpc::client::ClientConfig,
}
impl<T> DashboardServiceClient<T>
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
    /// Call the Subscription RPC. Sends a request to /kuku.dashboard.v1.DashboardService/Subscription.
    pub async fn subscription(
        &self,
        request: crate::proto::kuku::dashboard::v1::SubscriptionRequest,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::dashboard::v1::SubscriptionResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        self.subscription_with_options(
                request,
                ::connectrpc::client::CallOptions::default(),
            )
            .await
    }
    /// Call the Subscription RPC with explicit per-call options. Options override [`connectrpc::client::ClientConfig`] defaults.
    pub async fn subscription_with_options(
        &self,
        request: crate::proto::kuku::dashboard::v1::SubscriptionRequest,
        options: ::connectrpc::client::CallOptions,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::dashboard::v1::SubscriptionResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        ::connectrpc::client::call_unary(
                &self.transport,
                &self.config,
                DASHBOARD_SERVICE_SERVICE_NAME,
                "Subscription",
                request,
                options,
            )
            .await
    }
    /// Call the CurrentUsage RPC. Sends a request to /kuku.dashboard.v1.DashboardService/CurrentUsage.
    pub async fn current_usage(
        &self,
        request: crate::proto::kuku::dashboard::v1::CurrentUsageRequest,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::dashboard::v1::CurrentUsageResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        self.current_usage_with_options(
                request,
                ::connectrpc::client::CallOptions::default(),
            )
            .await
    }
    /// Call the CurrentUsage RPC with explicit per-call options. Options override [`connectrpc::client::ClientConfig`] defaults.
    pub async fn current_usage_with_options(
        &self,
        request: crate::proto::kuku::dashboard::v1::CurrentUsageRequest,
        options: ::connectrpc::client::CallOptions,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::dashboard::v1::CurrentUsageResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        ::connectrpc::client::call_unary(
                &self.transport,
                &self.config,
                DASHBOARD_SERVICE_SERVICE_NAME,
                "CurrentUsage",
                request,
                options,
            )
            .await
    }
    /// Call the UsageStats RPC. Sends a request to /kuku.dashboard.v1.DashboardService/UsageStats.
    pub async fn usage_stats(
        &self,
        request: crate::proto::kuku::dashboard::v1::UsageStatsRequest,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::dashboard::v1::UsageStatsResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        self.usage_stats_with_options(
                request,
                ::connectrpc::client::CallOptions::default(),
            )
            .await
    }
    /// Call the UsageStats RPC with explicit per-call options. Options override [`connectrpc::client::ClientConfig`] defaults.
    pub async fn usage_stats_with_options(
        &self,
        request: crate::proto::kuku::dashboard::v1::UsageStatsRequest,
        options: ::connectrpc::client::CallOptions,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::dashboard::v1::UsageStatsResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        ::connectrpc::client::call_unary(
                &self.transport,
                &self.config,
                DASHBOARD_SERVICE_SERVICE_NAME,
                "UsageStats",
                request,
                options,
            )
            .await
    }
}
