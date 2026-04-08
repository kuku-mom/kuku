/// Full service name for this service.
pub const AUTH_SERVICE_SERVICE_NAME: &str = "kuku.auth.v1.AuthService";
/// ---------------------------------------------------------------------------
/// AuthService - authentication service
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
pub trait AuthService: Send + Sync + 'static {
    /// Creates a Google OAuth authorization URL.
    /// - The client redirects to the returned URL to start Google login.
    /// - After login, the server sets cookies and redirects to the original page.
    /// - Error: ERROR_CODE_RATE_LIMITED when too many requests are made.
    fn google_auth_url(
        &self,
        ctx: ::connectrpc::Context,
        request: ::buffa::view::OwnedView<
            crate::proto::kuku::auth::v1::GoogleAuthURLRequestView<'static>,
        >,
    ) -> impl ::std::future::Future<
        Output = Result<
            (crate::proto::kuku::auth::v1::GoogleAuthURLResponse, ::connectrpc::Context),
            ::connectrpc::ConnectError,
        >,
    > + Send;
    /// Creates a GitHub OAuth authorization URL.
    /// - The client redirects to the returned URL to start GitHub login.
    /// - After login, the server sets cookies and redirects to the original page.
    /// - Error: ERROR_CODE_RATE_LIMITED when too many requests are made.
    fn github_auth_url(
        &self,
        ctx: ::connectrpc::Context,
        request: ::buffa::view::OwnedView<
            crate::proto::kuku::auth::v1::GithubAuthURLRequestView<'static>,
        >,
    ) -> impl ::std::future::Future<
        Output = Result<
            (crate::proto::kuku::auth::v1::GithubAuthURLResponse, ::connectrpc::Context),
            ::connectrpc::ConnectError,
        >,
    > + Send;
    /// Creates a desktop authentication URL.
    /// - The desktop app opens this URL in a browser for user authentication.
    /// - After login, the user receives a token through the web flow.
    /// - Error: ERROR_CODE_RATE_LIMITED when too many requests are made.
    fn desktop_auth_url(
        &self,
        ctx: ::connectrpc::Context,
        request: ::buffa::view::OwnedView<
            crate::proto::kuku::auth::v1::DesktopAuthURLRequestView<'static>,
        >,
    ) -> impl ::std::future::Future<
        Output = Result<
            (
                crate::proto::kuku::auth::v1::DesktopAuthURLResponse,
                ::connectrpc::Context,
            ),
            ::connectrpc::ConnectError,
        >,
    > + Send;
    /// Exchanges a desktop one-time token.
    /// - Exchanges the token received after web authentication for JWT tokens.
    /// - Returns an access token and refresh token for desktop API calls.
    /// - Errors: ERROR_CODE_INVALID_CODE for invalid tokens, ERROR_CODE_CODE_EXPIRED for expired tokens.
    fn exchange_desktop_token(
        &self,
        ctx: ::connectrpc::Context,
        request: ::buffa::view::OwnedView<
            crate::proto::kuku::auth::v1::ExchangeDesktopTokenRequestView<'static>,
        >,
    ) -> impl ::std::future::Future<
        Output = Result<
            (
                crate::proto::kuku::auth::v1::ExchangeDesktopTokenResponse,
                ::connectrpc::Context,
            ),
            ::connectrpc::ConnectError,
        >,
    > + Send;
    /// Refreshes desktop API tokens.
    /// - Rotates the refresh token and returns a new access token and refresh token.
    /// - Errors: ERROR_CODE_INVALID_TOKEN for invalid tokens, ERROR_CODE_TOKEN_EXPIRED for expired tokens.
    fn refresh_desktop_token(
        &self,
        ctx: ::connectrpc::Context,
        request: ::buffa::view::OwnedView<
            crate::proto::kuku::auth::v1::RefreshDesktopTokenRequestView<'static>,
        >,
    ) -> impl ::std::future::Future<
        Output = Result<
            (
                crate::proto::kuku::auth::v1::RefreshDesktopTokenResponse,
                ::connectrpc::Context,
            ),
            ::connectrpc::ConnectError,
        >,
    > + Send;
    /// Creates a desktop one-time token.
    /// - Creates the token passed back to the desktop app after web authentication.
    /// - Requires cookie authentication.
    /// - The returned token is used for deep link redirection.
    fn create_desktop_token(
        &self,
        ctx: ::connectrpc::Context,
        request: ::buffa::view::OwnedView<
            crate::proto::kuku::auth::v1::CreateDesktopTokenRequestView<'static>,
        >,
    ) -> impl ::std::future::Future<
        Output = Result<
            (
                crate::proto::kuku::auth::v1::CreateDesktopTokenResponse,
                ::connectrpc::Context,
            ),
            ::connectrpc::ConnectError,
        >,
    > + Send;
    /// Requests email authentication.
    /// - New users are registered and receive a verification code.
    /// - Existing users receive a login verification code.
    /// - Success returns 200 OK after the email is sent.
    /// - Errors: ERROR_CODE_EMAIL_FORBIDDEN for forbidden emails, ERROR_CODE_RATE_LIMITED for rate limits.
    fn email_auth(
        &self,
        ctx: ::connectrpc::Context,
        request: ::buffa::view::OwnedView<
            crate::proto::kuku::auth::v1::EmailAuthRequestView<'static>,
        >,
    ) -> impl ::std::future::Future<
        Output = Result<
            (crate::proto::kuku::auth::v1::EmailAuthResponse, ::connectrpc::Context),
            ::connectrpc::ConnectError,
        >,
    > + Send;
    /// Verifies an email authentication code.
    /// - Accepts the six-digit code delivered by email.
    /// - On success, the server sets a session cookie.
    /// - Errors: ERROR_CODE_INVALID_CODE, ERROR_CODE_CODE_EXPIRED.
    fn email_verify(
        &self,
        ctx: ::connectrpc::Context,
        request: ::buffa::view::OwnedView<
            crate::proto::kuku::auth::v1::EmailVerifyRequestView<'static>,
        >,
    ) -> impl ::std::future::Future<
        Output = Result<
            (crate::proto::kuku::auth::v1::EmailVerifyResponse, ::connectrpc::Context),
            ::connectrpc::ConnectError,
        >,
    > + Send;
    /// Resends the authentication code.
    /// - Sends a new code to the email address from the previous EmailAuth request.
    /// - Invalidates the previous code.
    /// - Error: ERROR_CODE_RATE_LIMITED.
    fn email_resend(
        &self,
        ctx: ::connectrpc::Context,
        request: ::buffa::view::OwnedView<
            crate::proto::kuku::auth::v1::EmailResendRequestView<'static>,
        >,
    ) -> impl ::std::future::Future<
        Output = Result<
            (crate::proto::kuku::auth::v1::EmailResendResponse, ::connectrpc::Context),
            ::connectrpc::ConnectError,
        >,
    > + Send;
    /// Signs out the current user.
    /// - Invalidates the current session cookie.
    fn sign_out(
        &self,
        ctx: ::connectrpc::Context,
        request: ::buffa::view::OwnedView<
            crate::proto::kuku::auth::v1::SignOutRequestView<'static>,
        >,
    ) -> impl ::std::future::Future<
        Output = Result<
            (crate::proto::kuku::auth::v1::SignOutResponse, ::connectrpc::Context),
            ::connectrpc::ConnectError,
        >,
    > + Send;
    /// Gets the current user's profile.
    /// - Returns the currently authenticated user's information.
    /// - Requires cookie authentication.
    fn profile(
        &self,
        ctx: ::connectrpc::Context,
        request: ::buffa::view::OwnedView<
            crate::proto::kuku::auth::v1::ProfileRequestView<'static>,
        >,
    ) -> impl ::std::future::Future<
        Output = Result<
            (crate::proto::kuku::auth::v1::ProfileResponse, ::connectrpc::Context),
            ::connectrpc::ConnectError,
        >,
    > + Send;
    /// Updates the current user's profile.
    /// - Changes the currently authenticated user's name.
    /// - Requires cookie authentication.
    fn profile_update(
        &self,
        ctx: ::connectrpc::Context,
        request: ::buffa::view::OwnedView<
            crate::proto::kuku::auth::v1::ProfileUpdateRequestView<'static>,
        >,
    ) -> impl ::std::future::Future<
        Output = Result<
            (crate::proto::kuku::auth::v1::ProfileUpdateResponse, ::connectrpc::Context),
            ::connectrpc::ConnectError,
        >,
    > + Send;
    /// Deletes the current user's account.
    /// - Permanently deletes the currently authenticated user's account.
    /// - Requires cookie authentication.
    /// - Warning: this cannot be undone.
    fn account_delete(
        &self,
        ctx: ::connectrpc::Context,
        request: ::buffa::view::OwnedView<
            crate::proto::kuku::auth::v1::AccountDeleteRequestView<'static>,
        >,
    ) -> impl ::std::future::Future<
        Output = Result<
            (crate::proto::kuku::auth::v1::AccountDeleteResponse, ::connectrpc::Context),
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
pub trait AuthServiceExt: AuthService {
    /// Register this service implementation with a Router.
    ///
    /// Takes ownership of the `Arc<Self>` and returns a new Router with
    /// this service's methods registered.
    fn register(
        self: ::std::sync::Arc<Self>,
        router: ::connectrpc::Router,
    ) -> ::connectrpc::Router;
}
impl<S: AuthService> AuthServiceExt for S {
    fn register(
        self: ::std::sync::Arc<Self>,
        router: ::connectrpc::Router,
    ) -> ::connectrpc::Router {
        router
            .route_view(
                AUTH_SERVICE_SERVICE_NAME,
                "GoogleAuthURL",
                {
                    let svc = ::std::sync::Arc::clone(&self);
                    ::connectrpc::view_handler_fn(move |ctx, req| {
                        let svc = ::std::sync::Arc::clone(&svc);
                        async move { svc.google_auth_url(ctx, req).await }
                    })
                },
            )
            .route_view(
                AUTH_SERVICE_SERVICE_NAME,
                "GithubAuthURL",
                {
                    let svc = ::std::sync::Arc::clone(&self);
                    ::connectrpc::view_handler_fn(move |ctx, req| {
                        let svc = ::std::sync::Arc::clone(&svc);
                        async move { svc.github_auth_url(ctx, req).await }
                    })
                },
            )
            .route_view(
                AUTH_SERVICE_SERVICE_NAME,
                "DesktopAuthURL",
                {
                    let svc = ::std::sync::Arc::clone(&self);
                    ::connectrpc::view_handler_fn(move |ctx, req| {
                        let svc = ::std::sync::Arc::clone(&svc);
                        async move { svc.desktop_auth_url(ctx, req).await }
                    })
                },
            )
            .route_view(
                AUTH_SERVICE_SERVICE_NAME,
                "ExchangeDesktopToken",
                {
                    let svc = ::std::sync::Arc::clone(&self);
                    ::connectrpc::view_handler_fn(move |ctx, req| {
                        let svc = ::std::sync::Arc::clone(&svc);
                        async move { svc.exchange_desktop_token(ctx, req).await }
                    })
                },
            )
            .route_view(
                AUTH_SERVICE_SERVICE_NAME,
                "RefreshDesktopToken",
                {
                    let svc = ::std::sync::Arc::clone(&self);
                    ::connectrpc::view_handler_fn(move |ctx, req| {
                        let svc = ::std::sync::Arc::clone(&svc);
                        async move { svc.refresh_desktop_token(ctx, req).await }
                    })
                },
            )
            .route_view(
                AUTH_SERVICE_SERVICE_NAME,
                "CreateDesktopToken",
                {
                    let svc = ::std::sync::Arc::clone(&self);
                    ::connectrpc::view_handler_fn(move |ctx, req| {
                        let svc = ::std::sync::Arc::clone(&svc);
                        async move { svc.create_desktop_token(ctx, req).await }
                    })
                },
            )
            .route_view(
                AUTH_SERVICE_SERVICE_NAME,
                "EmailAuth",
                {
                    let svc = ::std::sync::Arc::clone(&self);
                    ::connectrpc::view_handler_fn(move |ctx, req| {
                        let svc = ::std::sync::Arc::clone(&svc);
                        async move { svc.email_auth(ctx, req).await }
                    })
                },
            )
            .route_view(
                AUTH_SERVICE_SERVICE_NAME,
                "EmailVerify",
                {
                    let svc = ::std::sync::Arc::clone(&self);
                    ::connectrpc::view_handler_fn(move |ctx, req| {
                        let svc = ::std::sync::Arc::clone(&svc);
                        async move { svc.email_verify(ctx, req).await }
                    })
                },
            )
            .route_view(
                AUTH_SERVICE_SERVICE_NAME,
                "EmailResend",
                {
                    let svc = ::std::sync::Arc::clone(&self);
                    ::connectrpc::view_handler_fn(move |ctx, req| {
                        let svc = ::std::sync::Arc::clone(&svc);
                        async move { svc.email_resend(ctx, req).await }
                    })
                },
            )
            .route_view(
                AUTH_SERVICE_SERVICE_NAME,
                "SignOut",
                {
                    let svc = ::std::sync::Arc::clone(&self);
                    ::connectrpc::view_handler_fn(move |ctx, req| {
                        let svc = ::std::sync::Arc::clone(&svc);
                        async move { svc.sign_out(ctx, req).await }
                    })
                },
            )
            .route_view(
                AUTH_SERVICE_SERVICE_NAME,
                "Profile",
                {
                    let svc = ::std::sync::Arc::clone(&self);
                    ::connectrpc::view_handler_fn(move |ctx, req| {
                        let svc = ::std::sync::Arc::clone(&svc);
                        async move { svc.profile(ctx, req).await }
                    })
                },
            )
            .route_view(
                AUTH_SERVICE_SERVICE_NAME,
                "ProfileUpdate",
                {
                    let svc = ::std::sync::Arc::clone(&self);
                    ::connectrpc::view_handler_fn(move |ctx, req| {
                        let svc = ::std::sync::Arc::clone(&svc);
                        async move { svc.profile_update(ctx, req).await }
                    })
                },
            )
            .route_view(
                AUTH_SERVICE_SERVICE_NAME,
                "AccountDelete",
                {
                    let svc = ::std::sync::Arc::clone(&self);
                    ::connectrpc::view_handler_fn(move |ctx, req| {
                        let svc = ::std::sync::Arc::clone(&svc);
                        async move { svc.account_delete(ctx, req).await }
                    })
                },
            )
    }
}
/// Monomorphic dispatcher for `AuthService`.
///
/// Unlike `.register(Router)` which type-erases each method into an `Arc<dyn ErasedHandler>` stored in a `HashMap`, this struct dispatches via a compile-time `match` on method name: no vtable, no hash lookup.
///
/// # Example
///
/// ```rust,ignore
/// use connectrpc::ConnectRpcService;
///
/// let server = AuthServiceServer::new(MyImpl);
/// let service = ConnectRpcService::new(server);
/// // hand `service` to axum/hyper as a fallback_service
/// ```
pub struct AuthServiceServer<T> {
    inner: ::std::sync::Arc<T>,
}
impl<T: AuthService> AuthServiceServer<T> {
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
impl<T> Clone for AuthServiceServer<T> {
    fn clone(&self) -> Self {
        Self {
            inner: ::std::sync::Arc::clone(&self.inner),
        }
    }
}
impl<T: AuthService> ::connectrpc::Dispatcher for AuthServiceServer<T> {
    #[inline]
    fn lookup(
        &self,
        path: &str,
    ) -> Option<::connectrpc::dispatcher::codegen::MethodDescriptor> {
        let method = path.strip_prefix("kuku.auth.v1.AuthService/")?;
        match method {
            "GoogleAuthURL" => {
                Some(::connectrpc::dispatcher::codegen::MethodDescriptor::unary(false))
            }
            "GithubAuthURL" => {
                Some(::connectrpc::dispatcher::codegen::MethodDescriptor::unary(false))
            }
            "DesktopAuthURL" => {
                Some(::connectrpc::dispatcher::codegen::MethodDescriptor::unary(false))
            }
            "ExchangeDesktopToken" => {
                Some(::connectrpc::dispatcher::codegen::MethodDescriptor::unary(false))
            }
            "RefreshDesktopToken" => {
                Some(::connectrpc::dispatcher::codegen::MethodDescriptor::unary(false))
            }
            "CreateDesktopToken" => {
                Some(::connectrpc::dispatcher::codegen::MethodDescriptor::unary(false))
            }
            "EmailAuth" => {
                Some(::connectrpc::dispatcher::codegen::MethodDescriptor::unary(false))
            }
            "EmailVerify" => {
                Some(::connectrpc::dispatcher::codegen::MethodDescriptor::unary(false))
            }
            "EmailResend" => {
                Some(::connectrpc::dispatcher::codegen::MethodDescriptor::unary(false))
            }
            "SignOut" => {
                Some(::connectrpc::dispatcher::codegen::MethodDescriptor::unary(false))
            }
            "Profile" => {
                Some(::connectrpc::dispatcher::codegen::MethodDescriptor::unary(false))
            }
            "ProfileUpdate" => {
                Some(::connectrpc::dispatcher::codegen::MethodDescriptor::unary(false))
            }
            "AccountDelete" => {
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
        let Some(method) = path.strip_prefix("kuku.auth.v1.AuthService/") else {
            return ::connectrpc::dispatcher::codegen::unimplemented_unary(path);
        };
        let _ = (&ctx, &request, &format);
        match method {
            "GoogleAuthURL" => {
                let svc = ::std::sync::Arc::clone(&self.inner);
                Box::pin(async move {
                    let req = ::connectrpc::dispatcher::codegen::decode_request_view::<
                        crate::proto::kuku::auth::v1::GoogleAuthURLRequestView,
                    >(request, format)?;
                    let (res, ctx) = svc.google_auth_url(ctx, req).await?;
                    let bytes = ::connectrpc::dispatcher::codegen::encode_response(
                        &res,
                        format,
                    )?;
                    Ok((bytes, ctx))
                })
            }
            "GithubAuthURL" => {
                let svc = ::std::sync::Arc::clone(&self.inner);
                Box::pin(async move {
                    let req = ::connectrpc::dispatcher::codegen::decode_request_view::<
                        crate::proto::kuku::auth::v1::GithubAuthURLRequestView,
                    >(request, format)?;
                    let (res, ctx) = svc.github_auth_url(ctx, req).await?;
                    let bytes = ::connectrpc::dispatcher::codegen::encode_response(
                        &res,
                        format,
                    )?;
                    Ok((bytes, ctx))
                })
            }
            "DesktopAuthURL" => {
                let svc = ::std::sync::Arc::clone(&self.inner);
                Box::pin(async move {
                    let req = ::connectrpc::dispatcher::codegen::decode_request_view::<
                        crate::proto::kuku::auth::v1::DesktopAuthURLRequestView,
                    >(request, format)?;
                    let (res, ctx) = svc.desktop_auth_url(ctx, req).await?;
                    let bytes = ::connectrpc::dispatcher::codegen::encode_response(
                        &res,
                        format,
                    )?;
                    Ok((bytes, ctx))
                })
            }
            "ExchangeDesktopToken" => {
                let svc = ::std::sync::Arc::clone(&self.inner);
                Box::pin(async move {
                    let req = ::connectrpc::dispatcher::codegen::decode_request_view::<
                        crate::proto::kuku::auth::v1::ExchangeDesktopTokenRequestView,
                    >(request, format)?;
                    let (res, ctx) = svc.exchange_desktop_token(ctx, req).await?;
                    let bytes = ::connectrpc::dispatcher::codegen::encode_response(
                        &res,
                        format,
                    )?;
                    Ok((bytes, ctx))
                })
            }
            "RefreshDesktopToken" => {
                let svc = ::std::sync::Arc::clone(&self.inner);
                Box::pin(async move {
                    let req = ::connectrpc::dispatcher::codegen::decode_request_view::<
                        crate::proto::kuku::auth::v1::RefreshDesktopTokenRequestView,
                    >(request, format)?;
                    let (res, ctx) = svc.refresh_desktop_token(ctx, req).await?;
                    let bytes = ::connectrpc::dispatcher::codegen::encode_response(
                        &res,
                        format,
                    )?;
                    Ok((bytes, ctx))
                })
            }
            "CreateDesktopToken" => {
                let svc = ::std::sync::Arc::clone(&self.inner);
                Box::pin(async move {
                    let req = ::connectrpc::dispatcher::codegen::decode_request_view::<
                        crate::proto::kuku::auth::v1::CreateDesktopTokenRequestView,
                    >(request, format)?;
                    let (res, ctx) = svc.create_desktop_token(ctx, req).await?;
                    let bytes = ::connectrpc::dispatcher::codegen::encode_response(
                        &res,
                        format,
                    )?;
                    Ok((bytes, ctx))
                })
            }
            "EmailAuth" => {
                let svc = ::std::sync::Arc::clone(&self.inner);
                Box::pin(async move {
                    let req = ::connectrpc::dispatcher::codegen::decode_request_view::<
                        crate::proto::kuku::auth::v1::EmailAuthRequestView,
                    >(request, format)?;
                    let (res, ctx) = svc.email_auth(ctx, req).await?;
                    let bytes = ::connectrpc::dispatcher::codegen::encode_response(
                        &res,
                        format,
                    )?;
                    Ok((bytes, ctx))
                })
            }
            "EmailVerify" => {
                let svc = ::std::sync::Arc::clone(&self.inner);
                Box::pin(async move {
                    let req = ::connectrpc::dispatcher::codegen::decode_request_view::<
                        crate::proto::kuku::auth::v1::EmailVerifyRequestView,
                    >(request, format)?;
                    let (res, ctx) = svc.email_verify(ctx, req).await?;
                    let bytes = ::connectrpc::dispatcher::codegen::encode_response(
                        &res,
                        format,
                    )?;
                    Ok((bytes, ctx))
                })
            }
            "EmailResend" => {
                let svc = ::std::sync::Arc::clone(&self.inner);
                Box::pin(async move {
                    let req = ::connectrpc::dispatcher::codegen::decode_request_view::<
                        crate::proto::kuku::auth::v1::EmailResendRequestView,
                    >(request, format)?;
                    let (res, ctx) = svc.email_resend(ctx, req).await?;
                    let bytes = ::connectrpc::dispatcher::codegen::encode_response(
                        &res,
                        format,
                    )?;
                    Ok((bytes, ctx))
                })
            }
            "SignOut" => {
                let svc = ::std::sync::Arc::clone(&self.inner);
                Box::pin(async move {
                    let req = ::connectrpc::dispatcher::codegen::decode_request_view::<
                        crate::proto::kuku::auth::v1::SignOutRequestView,
                    >(request, format)?;
                    let (res, ctx) = svc.sign_out(ctx, req).await?;
                    let bytes = ::connectrpc::dispatcher::codegen::encode_response(
                        &res,
                        format,
                    )?;
                    Ok((bytes, ctx))
                })
            }
            "Profile" => {
                let svc = ::std::sync::Arc::clone(&self.inner);
                Box::pin(async move {
                    let req = ::connectrpc::dispatcher::codegen::decode_request_view::<
                        crate::proto::kuku::auth::v1::ProfileRequestView,
                    >(request, format)?;
                    let (res, ctx) = svc.profile(ctx, req).await?;
                    let bytes = ::connectrpc::dispatcher::codegen::encode_response(
                        &res,
                        format,
                    )?;
                    Ok((bytes, ctx))
                })
            }
            "ProfileUpdate" => {
                let svc = ::std::sync::Arc::clone(&self.inner);
                Box::pin(async move {
                    let req = ::connectrpc::dispatcher::codegen::decode_request_view::<
                        crate::proto::kuku::auth::v1::ProfileUpdateRequestView,
                    >(request, format)?;
                    let (res, ctx) = svc.profile_update(ctx, req).await?;
                    let bytes = ::connectrpc::dispatcher::codegen::encode_response(
                        &res,
                        format,
                    )?;
                    Ok((bytes, ctx))
                })
            }
            "AccountDelete" => {
                let svc = ::std::sync::Arc::clone(&self.inner);
                Box::pin(async move {
                    let req = ::connectrpc::dispatcher::codegen::decode_request_view::<
                        crate::proto::kuku::auth::v1::AccountDeleteRequestView,
                    >(request, format)?;
                    let (res, ctx) = svc.account_delete(ctx, req).await?;
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
        let Some(method) = path.strip_prefix("kuku.auth.v1.AuthService/") else {
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
        let Some(method) = path.strip_prefix("kuku.auth.v1.AuthService/") else {
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
        let Some(method) = path.strip_prefix("kuku.auth.v1.AuthService/") else {
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
/// let client = AuthServiceClient::new(conn, config);
/// let response = client.google_auth_url(request).await?;
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
/// let client = AuthServiceClient::new(http, config);
/// let response = client.google_auth_url(request).await?;
/// ```
///
/// # Working with the response
///
/// Unary calls return [`UnaryResponse<OwnedView<FooView>>`](::connectrpc::client::UnaryResponse).
/// The `OwnedView` derefs to the view, so field access is zero-copy:
///
/// ```rust,ignore
/// let resp = client.google_auth_url(request).await?.into_view();
/// let name: &str = resp.name;  // borrow into the response buffer
/// ```
///
/// If you need the owned struct (e.g. to store or pass by value), use
/// [`into_owned()`](::connectrpc::client::UnaryResponse::into_owned):
///
/// ```rust,ignore
/// let owned = client.google_auth_url(request).await?.into_owned();
/// ```
#[derive(Clone)]
pub struct AuthServiceClient<T> {
    transport: T,
    config: ::connectrpc::client::ClientConfig,
}
impl<T> AuthServiceClient<T>
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
    /// Call the GoogleAuthURL RPC. Sends a request to /kuku.auth.v1.AuthService/GoogleAuthURL.
    pub async fn google_auth_url(
        &self,
        request: crate::proto::kuku::auth::v1::GoogleAuthURLRequest,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::auth::v1::GoogleAuthURLResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        self.google_auth_url_with_options(
                request,
                ::connectrpc::client::CallOptions::default(),
            )
            .await
    }
    /// Call the GoogleAuthURL RPC with explicit per-call options. Options override [`connectrpc::client::ClientConfig`] defaults.
    pub async fn google_auth_url_with_options(
        &self,
        request: crate::proto::kuku::auth::v1::GoogleAuthURLRequest,
        options: ::connectrpc::client::CallOptions,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::auth::v1::GoogleAuthURLResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        ::connectrpc::client::call_unary(
                &self.transport,
                &self.config,
                AUTH_SERVICE_SERVICE_NAME,
                "GoogleAuthURL",
                request,
                options,
            )
            .await
    }
    /// Call the GithubAuthURL RPC. Sends a request to /kuku.auth.v1.AuthService/GithubAuthURL.
    pub async fn github_auth_url(
        &self,
        request: crate::proto::kuku::auth::v1::GithubAuthURLRequest,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::auth::v1::GithubAuthURLResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        self.github_auth_url_with_options(
                request,
                ::connectrpc::client::CallOptions::default(),
            )
            .await
    }
    /// Call the GithubAuthURL RPC with explicit per-call options. Options override [`connectrpc::client::ClientConfig`] defaults.
    pub async fn github_auth_url_with_options(
        &self,
        request: crate::proto::kuku::auth::v1::GithubAuthURLRequest,
        options: ::connectrpc::client::CallOptions,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::auth::v1::GithubAuthURLResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        ::connectrpc::client::call_unary(
                &self.transport,
                &self.config,
                AUTH_SERVICE_SERVICE_NAME,
                "GithubAuthURL",
                request,
                options,
            )
            .await
    }
    /// Call the DesktopAuthURL RPC. Sends a request to /kuku.auth.v1.AuthService/DesktopAuthURL.
    pub async fn desktop_auth_url(
        &self,
        request: crate::proto::kuku::auth::v1::DesktopAuthURLRequest,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::auth::v1::DesktopAuthURLResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        self.desktop_auth_url_with_options(
                request,
                ::connectrpc::client::CallOptions::default(),
            )
            .await
    }
    /// Call the DesktopAuthURL RPC with explicit per-call options. Options override [`connectrpc::client::ClientConfig`] defaults.
    pub async fn desktop_auth_url_with_options(
        &self,
        request: crate::proto::kuku::auth::v1::DesktopAuthURLRequest,
        options: ::connectrpc::client::CallOptions,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::auth::v1::DesktopAuthURLResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        ::connectrpc::client::call_unary(
                &self.transport,
                &self.config,
                AUTH_SERVICE_SERVICE_NAME,
                "DesktopAuthURL",
                request,
                options,
            )
            .await
    }
    /// Call the ExchangeDesktopToken RPC. Sends a request to /kuku.auth.v1.AuthService/ExchangeDesktopToken.
    pub async fn exchange_desktop_token(
        &self,
        request: crate::proto::kuku::auth::v1::ExchangeDesktopTokenRequest,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::auth::v1::ExchangeDesktopTokenResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        self.exchange_desktop_token_with_options(
                request,
                ::connectrpc::client::CallOptions::default(),
            )
            .await
    }
    /// Call the ExchangeDesktopToken RPC with explicit per-call options. Options override [`connectrpc::client::ClientConfig`] defaults.
    pub async fn exchange_desktop_token_with_options(
        &self,
        request: crate::proto::kuku::auth::v1::ExchangeDesktopTokenRequest,
        options: ::connectrpc::client::CallOptions,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::auth::v1::ExchangeDesktopTokenResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        ::connectrpc::client::call_unary(
                &self.transport,
                &self.config,
                AUTH_SERVICE_SERVICE_NAME,
                "ExchangeDesktopToken",
                request,
                options,
            )
            .await
    }
    /// Call the RefreshDesktopToken RPC. Sends a request to /kuku.auth.v1.AuthService/RefreshDesktopToken.
    pub async fn refresh_desktop_token(
        &self,
        request: crate::proto::kuku::auth::v1::RefreshDesktopTokenRequest,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::auth::v1::RefreshDesktopTokenResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        self.refresh_desktop_token_with_options(
                request,
                ::connectrpc::client::CallOptions::default(),
            )
            .await
    }
    /// Call the RefreshDesktopToken RPC with explicit per-call options. Options override [`connectrpc::client::ClientConfig`] defaults.
    pub async fn refresh_desktop_token_with_options(
        &self,
        request: crate::proto::kuku::auth::v1::RefreshDesktopTokenRequest,
        options: ::connectrpc::client::CallOptions,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::auth::v1::RefreshDesktopTokenResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        ::connectrpc::client::call_unary(
                &self.transport,
                &self.config,
                AUTH_SERVICE_SERVICE_NAME,
                "RefreshDesktopToken",
                request,
                options,
            )
            .await
    }
    /// Call the CreateDesktopToken RPC. Sends a request to /kuku.auth.v1.AuthService/CreateDesktopToken.
    pub async fn create_desktop_token(
        &self,
        request: crate::proto::kuku::auth::v1::CreateDesktopTokenRequest,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::auth::v1::CreateDesktopTokenResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        self.create_desktop_token_with_options(
                request,
                ::connectrpc::client::CallOptions::default(),
            )
            .await
    }
    /// Call the CreateDesktopToken RPC with explicit per-call options. Options override [`connectrpc::client::ClientConfig`] defaults.
    pub async fn create_desktop_token_with_options(
        &self,
        request: crate::proto::kuku::auth::v1::CreateDesktopTokenRequest,
        options: ::connectrpc::client::CallOptions,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::auth::v1::CreateDesktopTokenResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        ::connectrpc::client::call_unary(
                &self.transport,
                &self.config,
                AUTH_SERVICE_SERVICE_NAME,
                "CreateDesktopToken",
                request,
                options,
            )
            .await
    }
    /// Call the EmailAuth RPC. Sends a request to /kuku.auth.v1.AuthService/EmailAuth.
    pub async fn email_auth(
        &self,
        request: crate::proto::kuku::auth::v1::EmailAuthRequest,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::auth::v1::EmailAuthResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        self.email_auth_with_options(
                request,
                ::connectrpc::client::CallOptions::default(),
            )
            .await
    }
    /// Call the EmailAuth RPC with explicit per-call options. Options override [`connectrpc::client::ClientConfig`] defaults.
    pub async fn email_auth_with_options(
        &self,
        request: crate::proto::kuku::auth::v1::EmailAuthRequest,
        options: ::connectrpc::client::CallOptions,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::auth::v1::EmailAuthResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        ::connectrpc::client::call_unary(
                &self.transport,
                &self.config,
                AUTH_SERVICE_SERVICE_NAME,
                "EmailAuth",
                request,
                options,
            )
            .await
    }
    /// Call the EmailVerify RPC. Sends a request to /kuku.auth.v1.AuthService/EmailVerify.
    pub async fn email_verify(
        &self,
        request: crate::proto::kuku::auth::v1::EmailVerifyRequest,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::auth::v1::EmailVerifyResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        self.email_verify_with_options(
                request,
                ::connectrpc::client::CallOptions::default(),
            )
            .await
    }
    /// Call the EmailVerify RPC with explicit per-call options. Options override [`connectrpc::client::ClientConfig`] defaults.
    pub async fn email_verify_with_options(
        &self,
        request: crate::proto::kuku::auth::v1::EmailVerifyRequest,
        options: ::connectrpc::client::CallOptions,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::auth::v1::EmailVerifyResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        ::connectrpc::client::call_unary(
                &self.transport,
                &self.config,
                AUTH_SERVICE_SERVICE_NAME,
                "EmailVerify",
                request,
                options,
            )
            .await
    }
    /// Call the EmailResend RPC. Sends a request to /kuku.auth.v1.AuthService/EmailResend.
    pub async fn email_resend(
        &self,
        request: crate::proto::kuku::auth::v1::EmailResendRequest,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::auth::v1::EmailResendResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        self.email_resend_with_options(
                request,
                ::connectrpc::client::CallOptions::default(),
            )
            .await
    }
    /// Call the EmailResend RPC with explicit per-call options. Options override [`connectrpc::client::ClientConfig`] defaults.
    pub async fn email_resend_with_options(
        &self,
        request: crate::proto::kuku::auth::v1::EmailResendRequest,
        options: ::connectrpc::client::CallOptions,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::auth::v1::EmailResendResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        ::connectrpc::client::call_unary(
                &self.transport,
                &self.config,
                AUTH_SERVICE_SERVICE_NAME,
                "EmailResend",
                request,
                options,
            )
            .await
    }
    /// Call the SignOut RPC. Sends a request to /kuku.auth.v1.AuthService/SignOut.
    pub async fn sign_out(
        &self,
        request: crate::proto::kuku::auth::v1::SignOutRequest,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::auth::v1::SignOutResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        self.sign_out_with_options(request, ::connectrpc::client::CallOptions::default())
            .await
    }
    /// Call the SignOut RPC with explicit per-call options. Options override [`connectrpc::client::ClientConfig`] defaults.
    pub async fn sign_out_with_options(
        &self,
        request: crate::proto::kuku::auth::v1::SignOutRequest,
        options: ::connectrpc::client::CallOptions,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::auth::v1::SignOutResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        ::connectrpc::client::call_unary(
                &self.transport,
                &self.config,
                AUTH_SERVICE_SERVICE_NAME,
                "SignOut",
                request,
                options,
            )
            .await
    }
    /// Call the Profile RPC. Sends a request to /kuku.auth.v1.AuthService/Profile.
    pub async fn profile(
        &self,
        request: crate::proto::kuku::auth::v1::ProfileRequest,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::auth::v1::ProfileResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        self.profile_with_options(request, ::connectrpc::client::CallOptions::default())
            .await
    }
    /// Call the Profile RPC with explicit per-call options. Options override [`connectrpc::client::ClientConfig`] defaults.
    pub async fn profile_with_options(
        &self,
        request: crate::proto::kuku::auth::v1::ProfileRequest,
        options: ::connectrpc::client::CallOptions,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::auth::v1::ProfileResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        ::connectrpc::client::call_unary(
                &self.transport,
                &self.config,
                AUTH_SERVICE_SERVICE_NAME,
                "Profile",
                request,
                options,
            )
            .await
    }
    /// Call the ProfileUpdate RPC. Sends a request to /kuku.auth.v1.AuthService/ProfileUpdate.
    pub async fn profile_update(
        &self,
        request: crate::proto::kuku::auth::v1::ProfileUpdateRequest,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::auth::v1::ProfileUpdateResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        self.profile_update_with_options(
                request,
                ::connectrpc::client::CallOptions::default(),
            )
            .await
    }
    /// Call the ProfileUpdate RPC with explicit per-call options. Options override [`connectrpc::client::ClientConfig`] defaults.
    pub async fn profile_update_with_options(
        &self,
        request: crate::proto::kuku::auth::v1::ProfileUpdateRequest,
        options: ::connectrpc::client::CallOptions,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::auth::v1::ProfileUpdateResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        ::connectrpc::client::call_unary(
                &self.transport,
                &self.config,
                AUTH_SERVICE_SERVICE_NAME,
                "ProfileUpdate",
                request,
                options,
            )
            .await
    }
    /// Call the AccountDelete RPC. Sends a request to /kuku.auth.v1.AuthService/AccountDelete.
    pub async fn account_delete(
        &self,
        request: crate::proto::kuku::auth::v1::AccountDeleteRequest,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::auth::v1::AccountDeleteResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        self.account_delete_with_options(
                request,
                ::connectrpc::client::CallOptions::default(),
            )
            .await
    }
    /// Call the AccountDelete RPC with explicit per-call options. Options override [`connectrpc::client::ClientConfig`] defaults.
    pub async fn account_delete_with_options(
        &self,
        request: crate::proto::kuku::auth::v1::AccountDeleteRequest,
        options: ::connectrpc::client::CallOptions,
    ) -> Result<
        ::connectrpc::client::UnaryResponse<
            ::buffa::view::OwnedView<
                crate::proto::kuku::auth::v1::AccountDeleteResponseView<'static>,
            >,
        >,
        ::connectrpc::ConnectError,
    > {
        ::connectrpc::client::call_unary(
                &self.transport,
                &self.config,
                AUTH_SERVICE_SERVICE_NAME,
                "AccountDelete",
                request,
                options,
            )
            .await
    }
}
