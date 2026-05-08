#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use reqwest::header::{ETAG, HeaderMap, HeaderName, HeaderValue};
use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;

use super::client::{
    CompletedObjectUploadDescriptor, ConnectSyncClient, HttpHeader, ObjectDownloadTargetDescriptor,
    ObjectReservationInput, ObjectUploadCompletion, ObjectUploadDescriptor,
    ObjectUploadTargetDescriptor, SyncTransferApi, UploadedObjectMetadata,
};
use super::errors::{SyncError, SyncResult};
use kuku_contract::proto::kuku::sync::v1::{SyncObjectErrorReason, SyncObjectKind};

#[derive(Clone)]
pub struct ObjectTransferQueue {
    api: Arc<dyn SyncTransferApi>,
    http: Arc<dyn ObjectTransferHttp>,
    config: TransferQueueConfig,
    progress_sink: Option<Arc<dyn TransferProgressSink>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TransferQueueConfig {
    pub max_upload_concurrency: usize,
    pub max_download_concurrency: usize,
    pub max_attempts: usize,
    pub initial_backoff: Duration,
}

impl Default for TransferQueueConfig {
    fn default() -> Self {
        Self {
            max_upload_concurrency: 4,
            max_download_concurrency: 8,
            max_attempts: 3,
            initial_backoff: Duration::from_millis(250),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EncryptedUploadObject {
    pub client_object_ref: String,
    pub kind: SyncObjectKind,
    pub ciphertext: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReservedEncryptedUploadObject {
    pub object_id: String,
    pub kind: SyncObjectKind,
    pub ciphertext: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DownloadedObject {
    pub object_id: String,
    pub kind: SyncObjectKind,
    pub ciphertext_sha256: String,
    pub ciphertext: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObjectPutRequest {
    pub url: String,
    pub required_headers: Vec<HttpHeader>,
    pub body: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObjectPutResponse {
    pub provider_etag: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObjectGetRequest {
    pub url: String,
    pub required_headers: Vec<HttpHeader>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObjectGetResponse {
    pub body: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ObjectHttpError {
    InvalidHeader(String),
    Network(String),
    Status { status: u16, body: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransferDirection {
    Upload,
    Download,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TransferProgressEvent {
    BatchStarted {
        direction: TransferDirection,
        total_objects: i64,
        attempt: i64,
        max_attempts: i64,
    },
    ObjectCompleted {
        direction: TransferDirection,
    },
    ObjectFailed {
        direction: TransferDirection,
        message: String,
    },
    RetryScheduled {
        direction: TransferDirection,
        next_attempt: i64,
        max_attempts: i64,
        next_retry_at_ms: i64,
        message: String,
    },
    BatchCompleted {
        direction: TransferDirection,
    },
    BatchFailed {
        direction: TransferDirection,
        message: String,
    },
}

pub trait TransferProgressSink: Send + Sync {
    fn on_transfer_progress(&self, event: TransferProgressEvent);
}

#[async_trait]
pub trait ObjectTransferHttp: Send + Sync {
    async fn put(&self, request: ObjectPutRequest) -> Result<ObjectPutResponse, ObjectHttpError>;
    async fn get(&self, request: ObjectGetRequest) -> Result<ObjectGetResponse, ObjectHttpError>;
}

#[derive(Clone, Debug)]
pub struct ReqwestObjectTransferHttp {
    client: reqwest::Client,
}

impl ReqwestObjectTransferHttp {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
        }
    }
}

impl Default for ReqwestObjectTransferHttp {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ObjectTransferHttp for ReqwestObjectTransferHttp {
    async fn put(&self, request: ObjectPutRequest) -> Result<ObjectPutResponse, ObjectHttpError> {
        let response = self
            .client
            .put(request.url)
            .headers(header_map(request.required_headers)?)
            .body(request.body)
            .send()
            .await
            .map_err(|error| ObjectHttpError::Network(error.to_string()))?;
        let status = response.status();
        let provider_etag = response
            .headers()
            .get(ETAG)
            .and_then(|value| value.to_str().ok())
            .map(ToOwned::to_owned);
        if status.is_success() {
            return Ok(ObjectPutResponse { provider_etag });
        }
        let body = response.text().await.unwrap_or_default();
        Err(ObjectHttpError::Status {
            status: status.as_u16(),
            body,
        })
    }

    async fn get(&self, request: ObjectGetRequest) -> Result<ObjectGetResponse, ObjectHttpError> {
        let response = self
            .client
            .get(request.url)
            .headers(header_map(request.required_headers)?)
            .send()
            .await
            .map_err(|error| ObjectHttpError::Network(error.to_string()))?;
        let status = response.status();
        if status.is_success() {
            let body = response
                .bytes()
                .await
                .map_err(|error| ObjectHttpError::Network(error.to_string()))?
                .to_vec();
            return Ok(ObjectGetResponse { body });
        }
        let body = response.text().await.unwrap_or_default();
        Err(ObjectHttpError::Status {
            status: status.as_u16(),
            body,
        })
    }
}

impl ObjectTransferQueue {
    pub fn new(
        api: Arc<dyn SyncTransferApi>,
        http: Arc<dyn ObjectTransferHttp>,
        config: TransferQueueConfig,
    ) -> SyncResult<Self> {
        validate_config(&config)?;
        Ok(Self {
            api,
            http,
            config,
            progress_sink: None,
        })
    }

    pub fn connect(authorization_header: Option<String>) -> SyncResult<Self> {
        let api: Arc<dyn SyncTransferApi> = match authorization_header {
            Some(header) => Arc::new(ConnectSyncClient::with_authorization_header(header)),
            None => Arc::new(ConnectSyncClient::new()),
        };
        Self::new(
            api,
            Arc::new(ReqwestObjectTransferHttp::new()),
            TransferQueueConfig::default(),
        )
    }

    pub fn with_progress_sink(mut self, progress_sink: Arc<dyn TransferProgressSink>) -> Self {
        self.progress_sink = Some(progress_sink);
        self
    }

    fn emit_progress(&self, event: TransferProgressEvent) {
        emit_progress(&self.progress_sink, event);
    }

    pub async fn upload_objects(
        &self,
        workspace_id: &str,
        device_id: &str,
        upload_attempt_id: &str,
        objects: Vec<EncryptedUploadObject>,
    ) -> SyncResult<Vec<UploadedObjectMetadata>> {
        validate_required(workspace_id, "workspace_id")?;
        validate_required(device_id, "device_id")?;
        validate_required(upload_attempt_id, "upload_attempt_id")?;
        if objects.is_empty() {
            return Ok(Vec::new());
        }

        let uploads = self
            .reserve_upload_objects(workspace_id, device_id, objects)
            .await?;
        self.upload_planned_objects(workspace_id, device_id, upload_attempt_id, uploads)
            .await
    }

    pub async fn upload_reserved_objects(
        &self,
        workspace_id: &str,
        device_id: &str,
        upload_attempt_id: &str,
        objects: Vec<ReservedEncryptedUploadObject>,
    ) -> SyncResult<Vec<UploadedObjectMetadata>> {
        validate_required(workspace_id, "workspace_id")?;
        validate_required(device_id, "device_id")?;
        validate_required(upload_attempt_id, "upload_attempt_id")?;
        if objects.is_empty() {
            return Ok(Vec::new());
        }
        let uploads = objects
            .into_iter()
            .map(local_reserved_upload_from)
            .collect::<SyncResult<Vec<_>>>()?;
        self.upload_planned_objects(workspace_id, device_id, upload_attempt_id, uploads)
            .await
    }

    async fn upload_planned_objects(
        &self,
        workspace_id: &str,
        device_id: &str,
        upload_attempt_id: &str,
        uploads: Vec<PlannedUpload>,
    ) -> SyncResult<Vec<UploadedObjectMetadata>> {
        let descriptors = uploads
            .iter()
            .map(|upload| upload.descriptor.clone())
            .collect::<Vec<_>>();
        let total_objects = checked_count(descriptors.len());
        let max_attempts = checked_count(self.config.max_attempts);

        for attempt in 0..self.config.max_attempts {
            let attempt_number = checked_count(attempt + 1);
            self.emit_progress(TransferProgressEvent::BatchStarted {
                direction: TransferDirection::Upload,
                total_objects,
                attempt: attempt_number,
                max_attempts,
            });
            let targets = match self
                .api
                .create_object_upload_batch(
                    workspace_id,
                    device_id,
                    upload_attempt_id,
                    descriptors.clone(),
                )
                .await
            {
                Ok(targets) => targets,
                Err(error) => {
                    self.emit_progress(TransferProgressEvent::BatchFailed {
                        direction: TransferDirection::Upload,
                        message: error.to_string(),
                    });
                    return Err(error);
                }
            };
            match self.upload_attempt(uploads.clone(), targets).await {
                Ok(completed) => {
                    let completions = match self
                        .api
                        .complete_object_upload_batch(
                            workspace_id,
                            device_id,
                            upload_attempt_id,
                            completed,
                        )
                        .await
                    {
                        Ok(completions) => completions,
                        Err(error) => {
                            self.emit_progress(TransferProgressEvent::BatchFailed {
                                direction: TransferDirection::Upload,
                                message: error.to_string(),
                            });
                            return Err(error);
                        }
                    };
                    let uploaded = match validate_upload_completions(completions, &descriptors) {
                        Ok(uploaded) => uploaded,
                        Err(error) => {
                            self.emit_progress(TransferProgressEvent::BatchFailed {
                                direction: TransferDirection::Upload,
                                message: error.to_string(),
                            });
                            return Err(error);
                        }
                    };
                    self.emit_progress(TransferProgressEvent::BatchCompleted {
                        direction: TransferDirection::Upload,
                    });
                    return Ok(uploaded);
                }
                Err(AttemptFailure::Retryable(message))
                    if attempt + 1 < self.config.max_attempts =>
                {
                    let delay = retry_delay(self.config.initial_backoff, attempt);
                    self.emit_progress(TransferProgressEvent::RetryScheduled {
                        direction: TransferDirection::Upload,
                        next_attempt: checked_count(attempt + 2),
                        max_attempts,
                        next_retry_at_ms: now_ms().saturating_add(duration_ms_i64(delay)),
                        message: message.clone(),
                    });
                    wait_for_retry_delay(delay).await;
                    eprintln!("sync upload retry after presigned transfer failure: {message}");
                }
                Err(AttemptFailure::Retryable(message)) => {
                    self.emit_progress(TransferProgressEvent::BatchFailed {
                        direction: TransferDirection::Upload,
                        message: message.clone(),
                    });
                    return Err(SyncError::Transport(format!(
                        "upload transfer failed after retries: {message}"
                    )));
                }
                Err(AttemptFailure::Fatal(error)) => {
                    self.emit_progress(TransferProgressEvent::BatchFailed {
                        direction: TransferDirection::Upload,
                        message: error.to_string(),
                    });
                    return Err(error);
                }
            }
        }

        let error =
            SyncError::Transport("upload transfer failed without running an attempt".into());
        self.emit_progress(TransferProgressEvent::BatchFailed {
            direction: TransferDirection::Upload,
            message: error.to_string(),
        });
        Err(error)
    }

    pub async fn download_objects(
        &self,
        workspace_id: &str,
        device_id: &str,
        object_ids: Vec<String>,
    ) -> SyncResult<Vec<DownloadedObject>> {
        validate_required(workspace_id, "workspace_id")?;
        validate_required(device_id, "device_id")?;
        if object_ids.is_empty() {
            return Ok(Vec::new());
        }
        let total_objects = checked_count(object_ids.len());
        let max_attempts = checked_count(self.config.max_attempts);

        for attempt in 0..self.config.max_attempts {
            let attempt_number = checked_count(attempt + 1);
            self.emit_progress(TransferProgressEvent::BatchStarted {
                direction: TransferDirection::Download,
                total_objects,
                attempt: attempt_number,
                max_attempts,
            });
            let targets = match self
                .api
                .create_object_download_batch(workspace_id, device_id, object_ids.clone())
                .await
            {
                Ok(targets) => targets,
                Err(error) => {
                    self.emit_progress(TransferProgressEvent::BatchFailed {
                        direction: TransferDirection::Download,
                        message: error.to_string(),
                    });
                    return Err(error);
                }
            };
            match self.download_attempt(targets).await {
                Ok(downloads) => {
                    self.emit_progress(TransferProgressEvent::BatchCompleted {
                        direction: TransferDirection::Download,
                    });
                    return Ok(downloads);
                }
                Err(AttemptFailure::Retryable(message))
                    if attempt + 1 < self.config.max_attempts =>
                {
                    let delay = retry_delay(self.config.initial_backoff, attempt);
                    self.emit_progress(TransferProgressEvent::RetryScheduled {
                        direction: TransferDirection::Download,
                        next_attempt: checked_count(attempt + 2),
                        max_attempts,
                        next_retry_at_ms: now_ms().saturating_add(duration_ms_i64(delay)),
                        message: message.clone(),
                    });
                    wait_for_retry_delay(delay).await;
                    eprintln!("sync download retry after presigned transfer failure: {message}");
                }
                Err(AttemptFailure::Retryable(message)) => {
                    self.emit_progress(TransferProgressEvent::BatchFailed {
                        direction: TransferDirection::Download,
                        message: message.clone(),
                    });
                    return Err(SyncError::Transport(format!(
                        "download transfer failed after retries: {message}"
                    )));
                }
                Err(AttemptFailure::Fatal(error)) => {
                    self.emit_progress(TransferProgressEvent::BatchFailed {
                        direction: TransferDirection::Download,
                        message: error.to_string(),
                    });
                    return Err(error);
                }
            }
        }

        let error =
            SyncError::Transport("download transfer failed without running an attempt".into());
        self.emit_progress(TransferProgressEvent::BatchFailed {
            direction: TransferDirection::Download,
            message: error.to_string(),
        });
        Err(error)
    }

    async fn reserve_upload_objects(
        &self,
        workspace_id: &str,
        device_id: &str,
        objects: Vec<EncryptedUploadObject>,
    ) -> SyncResult<Vec<PlannedUpload>> {
        let local = objects
            .into_iter()
            .map(local_upload_from)
            .collect::<SyncResult<Vec<_>>>()?;
        let reservations = self
            .api
            .reserve_object_ids(
                workspace_id,
                device_id,
                local
                    .iter()
                    .map(|upload| ObjectReservationInput {
                        client_object_ref: upload.client_object_ref.clone(),
                        kind: upload.kind,
                    })
                    .collect(),
            )
            .await?;
        let by_ref = reservations
            .into_iter()
            .map(|reservation| (reservation.client_object_ref.clone(), reservation))
            .collect::<HashMap<_, _>>();

        local
            .into_iter()
            .map(|upload| {
                let reservation = by_ref.get(&upload.client_object_ref).ok_or_else(|| {
                    SyncError::Transport(format!(
                        "ReserveObjectIds response missing {}",
                        upload.client_object_ref
                    ))
                })?;
                if reservation.kind != upload.kind {
                    return Err(SyncError::Transport(format!(
                        "reserved object kind mismatch for {}",
                        upload.client_object_ref
                    )));
                }
                Ok(PlannedUpload {
                    descriptor: ObjectUploadDescriptor {
                        object_id: reservation.object_id.clone(),
                        kind: upload.kind,
                        ciphertext_sha256: upload.ciphertext_sha256,
                        size_bytes: upload.size_bytes,
                    },
                    ciphertext: Arc::new(upload.ciphertext),
                })
            })
            .collect()
    }

    async fn upload_attempt(
        &self,
        uploads: Vec<PlannedUpload>,
        targets: Vec<ObjectUploadTargetDescriptor>,
    ) -> Result<Vec<CompletedObjectUploadDescriptor>, AttemptFailure> {
        let targets = targets
            .into_iter()
            .map(|target| (target.object_id.clone(), target))
            .collect::<HashMap<_, _>>();
        let semaphore = Arc::new(Semaphore::new(self.config.max_upload_concurrency));
        let mut handles = Vec::with_capacity(uploads.len());

        for upload in uploads {
            let target = targets
                .get(&upload.descriptor.object_id)
                .cloned()
                .ok_or_else(|| {
                    AttemptFailure::Fatal(SyncError::Transport(format!(
                        "upload batch response missing target for {}",
                        upload.descriptor.object_id
                    )))
                })?;
            let http = self.http.clone();
            let progress_sink = self.progress_sink.clone();
            let permit =
                semaphore.clone().acquire_owned().await.map_err(|error| {
                    AttemptFailure::Fatal(SyncError::Transport(error.to_string()))
                })?;
            handles.push(tokio::spawn(async move {
                let _permit = permit;
                let result = upload_one(http, upload, target).await;
                emit_attempt_progress(&progress_sink, TransferDirection::Upload, &result);
                result
            }));
        }

        let mut completed = Vec::with_capacity(handles.len());
        let mut first_error = None;
        for handle in handles {
            match handle.await {
                Ok(Ok(result)) => completed.push(result),
                Ok(Err(error)) if first_error.is_none() => first_error = Some(error),
                Ok(Err(_)) => {}
                Err(error) if first_error.is_none() => {
                    self.emit_progress(TransferProgressEvent::ObjectFailed {
                        direction: TransferDirection::Upload,
                        message: error.to_string(),
                    });
                    first_error = Some(AttemptFailure::Fatal(SyncError::Transport(
                        error.to_string(),
                    )));
                }
                Err(error) => {
                    self.emit_progress(TransferProgressEvent::ObjectFailed {
                        direction: TransferDirection::Upload,
                        message: error.to_string(),
                    });
                }
            }
        }

        match first_error {
            Some(error) => Err(error),
            None => Ok(completed),
        }
    }

    async fn download_attempt(
        &self,
        targets: Vec<ObjectDownloadTargetDescriptor>,
    ) -> Result<Vec<DownloadedObject>, AttemptFailure> {
        let semaphore = Arc::new(Semaphore::new(self.config.max_download_concurrency));
        let mut handles = Vec::with_capacity(targets.len());

        for target in targets {
            let http = self.http.clone();
            let progress_sink = self.progress_sink.clone();
            let permit =
                semaphore.clone().acquire_owned().await.map_err(|error| {
                    AttemptFailure::Fatal(SyncError::Transport(error.to_string()))
                })?;
            handles.push(tokio::spawn(async move {
                let _permit = permit;
                let result = download_one(http, target).await;
                emit_attempt_progress(&progress_sink, TransferDirection::Download, &result);
                result
            }));
        }

        let mut downloads = Vec::with_capacity(handles.len());
        let mut first_error = None;
        for handle in handles {
            match handle.await {
                Ok(Ok(result)) => downloads.push(result),
                Ok(Err(error)) if first_error.is_none() => first_error = Some(error),
                Ok(Err(_)) => {}
                Err(error) if first_error.is_none() => {
                    self.emit_progress(TransferProgressEvent::ObjectFailed {
                        direction: TransferDirection::Download,
                        message: error.to_string(),
                    });
                    first_error = Some(AttemptFailure::Fatal(SyncError::Transport(
                        error.to_string(),
                    )));
                }
                Err(error) => {
                    self.emit_progress(TransferProgressEvent::ObjectFailed {
                        direction: TransferDirection::Download,
                        message: error.to_string(),
                    });
                }
            }
        }

        match first_error {
            Some(error) => Err(error),
            None => Ok(downloads),
        }
    }
}

#[derive(Clone)]
struct LocalUpload {
    client_object_ref: String,
    kind: SyncObjectKind,
    ciphertext_sha256: String,
    size_bytes: i64,
    ciphertext: Vec<u8>,
}

#[derive(Clone)]
struct PlannedUpload {
    descriptor: ObjectUploadDescriptor,
    ciphertext: Arc<Vec<u8>>,
}

#[derive(Debug)]
enum AttemptFailure {
    Retryable(String),
    Fatal(SyncError),
}

async fn upload_one(
    http: Arc<dyn ObjectTransferHttp>,
    upload: PlannedUpload,
    target: ObjectUploadTargetDescriptor,
) -> Result<CompletedObjectUploadDescriptor, AttemptFailure> {
    let response = http
        .put(ObjectPutRequest {
            url: target.put_url,
            required_headers: target.required_headers,
            body: upload.ciphertext.as_ref().clone(),
        })
        .await
        .map_err(AttemptFailure::from_http)?;

    Ok(CompletedObjectUploadDescriptor {
        object_id: upload.descriptor.object_id,
        ciphertext_sha256: upload.descriptor.ciphertext_sha256,
        size_bytes: upload.descriptor.size_bytes,
        provider_etag: response.provider_etag,
    })
}

async fn download_one(
    http: Arc<dyn ObjectTransferHttp>,
    target: ObjectDownloadTargetDescriptor,
) -> Result<DownloadedObject, AttemptFailure> {
    let response = http
        .get(ObjectGetRequest {
            url: target.get_url,
            required_headers: target.required_headers,
        })
        .await
        .map_err(AttemptFailure::from_http)?;
    let observed_sha256 = sha256_hex(&response.body);
    if observed_sha256 != target.ciphertext_sha256 {
        return Err(AttemptFailure::Fatal(SyncError::Integrity(format!(
            "downloaded object {} hash mismatch: expected {}, got {}",
            target.object_id, target.ciphertext_sha256, observed_sha256
        ))));
    }
    let observed_size = checked_size(response.body.len())?;
    if observed_size != target.size_bytes {
        return Err(AttemptFailure::Fatal(SyncError::Integrity(format!(
            "downloaded object {} size mismatch: expected {}, got {}",
            target.object_id, target.size_bytes, observed_size
        ))));
    }

    Ok(DownloadedObject {
        object_id: target.object_id,
        kind: target.kind,
        ciphertext_sha256: observed_sha256,
        ciphertext: response.body,
    })
}

impl AttemptFailure {
    fn from_http(error: ObjectHttpError) -> Self {
        let message = http_error_message(&error);
        if is_retryable_http_error(&error) {
            Self::Retryable(message)
        } else {
            Self::Fatal(SyncError::Transport(message))
        }
    }

    fn message(&self) -> String {
        match self {
            Self::Retryable(message) => message.clone(),
            Self::Fatal(error) => error.to_string(),
        }
    }
}

fn emit_attempt_progress<T>(
    sink: &Option<Arc<dyn TransferProgressSink>>,
    direction: TransferDirection,
    result: &Result<T, AttemptFailure>,
) {
    match result {
        Ok(_) => emit_progress(sink, TransferProgressEvent::ObjectCompleted { direction }),
        Err(error) => emit_progress(
            sink,
            TransferProgressEvent::ObjectFailed {
                direction,
                message: error.message(),
            },
        ),
    }
}

fn emit_progress(sink: &Option<Arc<dyn TransferProgressSink>>, event: TransferProgressEvent) {
    if let Some(sink) = sink {
        sink.on_transfer_progress(event);
    }
}

fn local_upload_from(object: EncryptedUploadObject) -> SyncResult<LocalUpload> {
    validate_required(&object.client_object_ref, "client_object_ref")?;
    Ok(LocalUpload {
        client_object_ref: object.client_object_ref,
        kind: object.kind,
        ciphertext_sha256: sha256_hex(&object.ciphertext),
        size_bytes: checked_size(object.ciphertext.len()).map_err(|failure| match failure {
            AttemptFailure::Fatal(error) => error,
            AttemptFailure::Retryable(message) => SyncError::Transport(message),
        })?,
        ciphertext: object.ciphertext,
    })
}

fn local_reserved_upload_from(object: ReservedEncryptedUploadObject) -> SyncResult<PlannedUpload> {
    validate_required(&object.object_id, "object_id")?;
    let ciphertext_sha256 = sha256_hex(&object.ciphertext);
    let size_bytes = checked_size(object.ciphertext.len()).map_err(|failure| match failure {
        AttemptFailure::Fatal(error) => error,
        AttemptFailure::Retryable(message) => SyncError::Transport(message),
    })?;
    Ok(PlannedUpload {
        descriptor: ObjectUploadDescriptor {
            object_id: object.object_id,
            kind: object.kind,
            ciphertext_sha256,
            size_bytes,
        },
        ciphertext: Arc::new(object.ciphertext),
    })
}

fn validate_upload_completions(
    completions: Vec<ObjectUploadCompletion>,
    descriptors: &[ObjectUploadDescriptor],
) -> SyncResult<Vec<UploadedObjectMetadata>> {
    if completions.len() != descriptors.len() {
        return Err(SyncError::Transport(format!(
            "complete upload response count mismatch: expected {}, got {}",
            descriptors.len(),
            completions.len()
        )));
    }
    let expected = descriptors
        .iter()
        .map(|descriptor| (descriptor.object_id.as_str(), descriptor))
        .collect::<HashMap<_, _>>();
    let mut uploaded = Vec::with_capacity(completions.len());

    for completion in completions {
        if let Some(reason) = completion.error_reason {
            return Err(SyncError::Transport(format!(
                "object upload completion failed: {}",
                object_error_reason_name(reason)
            )));
        }
        let object = completion.object.ok_or_else(|| {
            SyncError::Transport("complete upload response missing object metadata".into())
        })?;
        let descriptor = expected.get(object.object_id.as_str()).ok_or_else(|| {
            SyncError::Transport(format!(
                "complete upload response included unknown object {}",
                object.object_id
            ))
        })?;
        if object.ciphertext_sha256 != descriptor.ciphertext_sha256 {
            return Err(SyncError::Integrity(format!(
                "completed object {} hash mismatch: expected {}, got {}",
                object.object_id, descriptor.ciphertext_sha256, object.ciphertext_sha256
            )));
        }
        if object.size_bytes != descriptor.size_bytes {
            return Err(SyncError::Integrity(format!(
                "completed object {} size mismatch: expected {}, got {}",
                object.object_id, descriptor.size_bytes, object.size_bytes
            )));
        }
        uploaded.push(object);
    }

    Ok(uploaded)
}

fn validate_config(config: &TransferQueueConfig) -> SyncResult<()> {
    if config.max_upload_concurrency == 0 {
        return Err(SyncError::InvalidArgument(
            "max_upload_concurrency must be at least 1".into(),
        ));
    }
    if config.max_download_concurrency == 0 {
        return Err(SyncError::InvalidArgument(
            "max_download_concurrency must be at least 1".into(),
        ));
    }
    if config.max_attempts == 0 {
        return Err(SyncError::InvalidArgument(
            "max_attempts must be at least 1".into(),
        ));
    }
    Ok(())
}

fn validate_required(value: &str, field: &str) -> SyncResult<()> {
    if value.trim().is_empty() {
        return Err(SyncError::InvalidArgument(format!("{field} is required")));
    }
    Ok(())
}

fn checked_size(size: usize) -> Result<i64, AttemptFailure> {
    i64::try_from(size).map_err(|_| {
        AttemptFailure::Fatal(SyncError::InvalidArgument(
            "object is too large to describe".into(),
        ))
    })
}

fn checked_count(count: usize) -> i64 {
    i64::try_from(count).unwrap_or(i64::MAX)
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn header_map(headers: Vec<HttpHeader>) -> Result<HeaderMap, ObjectHttpError> {
    let mut output = HeaderMap::new();
    for header in headers {
        let name = HeaderName::from_bytes(header.name.as_bytes()).map_err(|error| {
            ObjectHttpError::InvalidHeader(format!("invalid transfer header name: {error}"))
        })?;
        let value = HeaderValue::from_str(&header.value).map_err(|error| {
            ObjectHttpError::InvalidHeader(format!("invalid transfer header value: {error}"))
        })?;
        output.insert(name, value);
    }
    Ok(output)
}

fn is_retryable_http_error(error: &ObjectHttpError) -> bool {
    match error {
        ObjectHttpError::Network(_) => true,
        ObjectHttpError::Status { status, .. } => {
            matches!(*status, 401 | 403 | 408 | 429 | 500..=599)
        }
        ObjectHttpError::InvalidHeader(_) => false,
    }
}

fn http_error_message(error: &ObjectHttpError) -> String {
    match error {
        ObjectHttpError::InvalidHeader(message) => message.clone(),
        ObjectHttpError::Network(message) => message.clone(),
        ObjectHttpError::Status { status, body } => {
            if body.trim().is_empty() {
                format!("object transfer returned HTTP {status}")
            } else {
                format!("object transfer returned HTTP {status}: {body}")
            }
        }
    }
}

fn object_error_reason_name(reason: SyncObjectErrorReason) -> &'static str {
    match reason {
        SyncObjectErrorReason::SYNC_OBJECT_ERROR_REASON_UNSPECIFIED => "unspecified",
        SyncObjectErrorReason::SYNC_OBJECT_ERROR_REASON_UPLOAD_EXPIRED => "upload_expired",
        SyncObjectErrorReason::SYNC_OBJECT_ERROR_REASON_CHECKSUM_MISMATCH => "checksum_mismatch",
        SyncObjectErrorReason::SYNC_OBJECT_ERROR_REASON_SIZE_MISMATCH => "size_mismatch",
        SyncObjectErrorReason::SYNC_OBJECT_ERROR_REASON_STORAGE_PROVIDER_ERROR => {
            "storage_provider_error"
        }
        SyncObjectErrorReason::SYNC_OBJECT_ERROR_REASON_QUOTA_EXCEEDED => "quota_exceeded",
        SyncObjectErrorReason::SYNC_OBJECT_ERROR_REASON_CANCELED => "canceled",
    }
}

async fn wait_for_retry_delay(delay: Duration) {
    if delay.is_zero() {
        return;
    }
    tokio::time::sleep(delay).await;
}

fn retry_delay(initial_backoff: Duration, attempt: usize) -> Duration {
    if initial_backoff.is_zero() {
        return Duration::ZERO;
    }
    let multiplier = u32::try_from(attempt + 1).unwrap_or(u32::MAX);
    let base = initial_backoff.saturating_mul(multiplier);
    let jitter_cap_ms = (base.as_millis() / 4).min(1_000);
    if jitter_cap_ms == 0 {
        return base;
    }
    let jitter_seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| u128::from(duration.subsec_nanos()))
        .unwrap_or(0);
    let jitter_ms = (jitter_seed % (jitter_cap_ms + 1)) as u64;
    base.saturating_add(Duration::from_millis(jitter_ms))
}

fn duration_ms_i64(duration: Duration) -> i64 {
    i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use parking_lot::Mutex;
    use tokio::runtime::Builder;

    use super::super::client::{
        ObjectDownloadTargetDescriptor, ReservedObject, UploadedObjectMetadata,
    };
    use super::*;

    #[test]
    fn upload_queue_reserves_uploads_and_completes_with_bounded_concurrency() {
        let api = Arc::new(FakeSyncApi::default());
        let http = Arc::new(FakeObjectHttp::with_delay(Duration::from_millis(20)));
        let queue = queue(api.clone(), http.clone(), 2, 2, 1);

        let uploaded = block_on(queue.upload_objects(
            "workspace",
            "device",
            "attempt-1",
            vec![
                upload("a", b"alpha"),
                upload("b", b"bravo"),
                upload("c", b"charlie"),
            ],
        ))
        .unwrap();

        assert_eq!(uploaded.len(), 3);
        assert_eq!(api.inner.lock().reserve_calls, 1);
        assert_eq!(api.inner.lock().upload_batch_calls, 1);
        assert_eq!(api.inner.lock().complete_calls, 1);
        assert_eq!(http.inner.lock().put_urls.len(), 3);
        assert_eq!(http.max_in_flight.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn upload_reissues_batch_when_presigned_url_expired() {
        let api = Arc::new(FakeSyncApi::default());
        {
            let mut inner = api.inner.lock();
            inner.upload_targets_by_call = vec![
                vec![upload_target("object-a", "expired-put")],
                vec![upload_target("object-a", "fresh-put")],
            ];
        }
        let http = Arc::new(FakeObjectHttp::default());
        http.fail_put(
            "expired-put",
            ObjectHttpError::Status {
                status: 403,
                body: "expired".into(),
            },
        );
        let queue = queue(api.clone(), http.clone(), 4, 4, 2);

        let uploaded = block_on(queue.upload_objects(
            "workspace",
            "device",
            "attempt-1",
            vec![upload("a", b"alpha")],
        ))
        .unwrap();

        assert_eq!(uploaded.len(), 1);
        assert_eq!(api.inner.lock().upload_batch_calls, 2);
        assert_eq!(api.inner.lock().complete_calls, 1);
        assert_eq!(
            http.inner.lock().put_urls,
            vec!["expired-put".to_string(), "fresh-put".to_string()]
        );
    }

    #[test]
    fn download_reissues_batch_when_presigned_url_expired() {
        let api = Arc::new(FakeSyncApi::default());
        {
            let mut inner = api.inner.lock();
            inner.download_targets_by_call = vec![
                vec![download_target("object-a", "expired-get", b"alpha")],
                vec![download_target("object-a", "fresh-get", b"alpha")],
            ];
        }
        let http = Arc::new(FakeObjectHttp::default());
        http.fail_get(
            "expired-get",
            ObjectHttpError::Status {
                status: 403,
                body: "expired".into(),
            },
        );
        http.get_body("fresh-get", b"alpha");
        let queue = queue(api.clone(), http.clone(), 4, 4, 2);

        let downloads =
            block_on(queue.download_objects("workspace", "device", vec!["object-a".into()]))
                .unwrap();

        assert_eq!(downloads.len(), 1);
        assert_eq!(downloads[0].ciphertext, b"alpha");
        assert_eq!(api.inner.lock().download_batch_calls, 2);
        assert_eq!(
            http.inner.lock().get_urls,
            vec!["expired-get".to_string(), "fresh-get".to_string()]
        );
    }

    #[test]
    fn download_queue_applies_bounded_concurrency() {
        let api = Arc::new(FakeSyncApi::default());
        {
            let mut inner = api.inner.lock();
            inner.download_targets_by_call = vec![vec![
                download_target("object-a", "get-a", b"alpha"),
                download_target("object-b", "get-b", b"bravo"),
                download_target("object-c", "get-c", b"charlie"),
            ]];
        }
        let http = Arc::new(FakeObjectHttp::with_delay(Duration::from_millis(20)));
        http.get_body("get-a", b"alpha");
        http.get_body("get-b", b"bravo");
        http.get_body("get-c", b"charlie");
        let queue = queue(api, http.clone(), 4, 2, 1);

        let downloads = block_on(queue.download_objects(
            "workspace",
            "device",
            vec!["object-a".into(), "object-b".into(), "object-c".into()],
        ))
        .unwrap();

        assert_eq!(downloads.len(), 3);
        assert_eq!(http.max_in_flight.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn download_rejects_ciphertext_hash_mismatch_without_retry() {
        let api = Arc::new(FakeSyncApi::default());
        {
            let mut inner = api.inner.lock();
            inner.download_targets_by_call =
                vec![vec![download_target("object-a", "fresh-get", b"expected")]];
        }
        let http = Arc::new(FakeObjectHttp::default());
        http.get_body("fresh-get", b"tampered");
        let queue = queue(api.clone(), http, 4, 4, 2);

        let err = block_on(queue.download_objects("workspace", "device", vec!["object-a".into()]))
            .unwrap_err();

        assert!(matches!(err, SyncError::Integrity(message) if message.contains("hash mismatch")));
        assert_eq!(api.inner.lock().download_batch_calls, 1);
    }

    #[test]
    fn upload_progress_reports_retry_and_completion() {
        let api = Arc::new(FakeSyncApi::default());
        {
            let mut inner = api.inner.lock();
            inner.upload_targets_by_call = vec![
                vec![upload_target("object-a", "expired-put")],
                vec![upload_target("object-a", "fresh-put")],
            ];
        }
        let http = Arc::new(FakeObjectHttp::default());
        http.fail_put(
            "expired-put",
            ObjectHttpError::Status {
                status: 403,
                body: "expired".into(),
            },
        );
        let sink = Arc::new(RecordingProgressSink::default());
        let queue = queue(api, http, 4, 4, 2).with_progress_sink(sink.clone());

        let uploaded = block_on(queue.upload_objects(
            "workspace",
            "device",
            "attempt-1",
            vec![upload("a", b"alpha")],
        ))
        .unwrap();

        assert_eq!(uploaded.len(), 1);
        let events = sink.events();
        assert_eq!(
            events.first(),
            Some(&TransferProgressEvent::BatchStarted {
                direction: TransferDirection::Upload,
                total_objects: 1,
                attempt: 1,
                max_attempts: 2,
            })
        );
        assert!(events.iter().any(|event| matches!(
            event,
            TransferProgressEvent::ObjectFailed {
                direction: TransferDirection::Upload,
                ..
            }
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            TransferProgressEvent::RetryScheduled {
                direction: TransferDirection::Upload,
                next_attempt: 2,
                max_attempts: 2,
                ..
            }
        )));
        assert!(events.iter().any(|event| {
            event
                == &TransferProgressEvent::BatchStarted {
                    direction: TransferDirection::Upload,
                    total_objects: 1,
                    attempt: 2,
                    max_attempts: 2,
                }
        }));
        assert!(events.iter().any(|event| {
            event
                == &TransferProgressEvent::ObjectCompleted {
                    direction: TransferDirection::Upload,
                }
        }));
        assert_eq!(
            events.last(),
            Some(&TransferProgressEvent::BatchCompleted {
                direction: TransferDirection::Upload,
            })
        );
    }

    #[test]
    fn download_progress_reports_retry_and_completion() {
        let api = Arc::new(FakeSyncApi::default());
        {
            let mut inner = api.inner.lock();
            inner.download_targets_by_call = vec![
                vec![download_target("object-a", "expired-get", b"alpha")],
                vec![download_target("object-a", "fresh-get", b"alpha")],
            ];
        }
        let http = Arc::new(FakeObjectHttp::default());
        http.fail_get(
            "expired-get",
            ObjectHttpError::Status {
                status: 403,
                body: "expired".into(),
            },
        );
        http.get_body("fresh-get", b"alpha");
        let sink = Arc::new(RecordingProgressSink::default());
        let queue = queue(api, http, 4, 4, 2).with_progress_sink(sink.clone());

        let downloads =
            block_on(queue.download_objects("workspace", "device", vec!["object-a".into()]))
                .unwrap();

        assert_eq!(downloads.len(), 1);
        let events = sink.events();
        assert!(events.iter().any(|event| matches!(
            event,
            TransferProgressEvent::RetryScheduled {
                direction: TransferDirection::Download,
                next_attempt: 2,
                max_attempts: 2,
                ..
            }
        )));
        assert_eq!(
            events.last(),
            Some(&TransferProgressEvent::BatchCompleted {
                direction: TransferDirection::Download,
            })
        );
    }

    #[test]
    fn upload_progress_reports_batch_failed_when_presign_fails() {
        let api = Arc::new(FakeSyncApi::default());
        api.inner
            .lock()
            .upload_batch_errors
            .push(SyncError::Transport("presign failed".into()));
        let http = Arc::new(FakeObjectHttp::default());
        let sink = Arc::new(RecordingProgressSink::default());
        let queue = queue(api, http, 4, 4, 1).with_progress_sink(sink.clone());

        let err = block_on(queue.upload_objects(
            "workspace",
            "device",
            "attempt-1",
            vec![upload("a", b"alpha")],
        ))
        .unwrap_err();

        assert!(matches!(err, SyncError::Transport(message) if message == "presign failed"));
        assert!(matches!(
            sink.events().last(),
            Some(TransferProgressEvent::BatchFailed {
                direction: TransferDirection::Upload,
                message,
            }) if message.contains("presign failed")
        ));
    }

    fn queue(
        api: Arc<FakeSyncApi>,
        http: Arc<FakeObjectHttp>,
        upload_concurrency: usize,
        download_concurrency: usize,
        max_attempts: usize,
    ) -> ObjectTransferQueue {
        ObjectTransferQueue::new(
            api,
            http,
            TransferQueueConfig {
                max_upload_concurrency: upload_concurrency,
                max_download_concurrency: download_concurrency,
                max_attempts,
                initial_backoff: Duration::ZERO,
            },
        )
        .unwrap()
    }

    fn block_on<T>(future: impl Future<Output = T>) -> T {
        Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap()
            .block_on(future)
    }

    #[derive(Default)]
    struct RecordingProgressSink {
        events: Mutex<Vec<TransferProgressEvent>>,
    }

    impl RecordingProgressSink {
        fn events(&self) -> Vec<TransferProgressEvent> {
            self.events.lock().clone()
        }
    }

    impl TransferProgressSink for RecordingProgressSink {
        fn on_transfer_progress(&self, event: TransferProgressEvent) {
            self.events.lock().push(event);
        }
    }

    fn upload(client_object_ref: &str, bytes: &[u8]) -> EncryptedUploadObject {
        EncryptedUploadObject {
            client_object_ref: client_object_ref.into(),
            kind: SyncObjectKind::SYNC_OBJECT_KIND_CONTENT_PACK,
            ciphertext: bytes.to_vec(),
        }
    }

    fn upload_target(object_id: &str, url: &str) -> ObjectUploadTargetDescriptor {
        ObjectUploadTargetDescriptor {
            object_id: object_id.into(),
            put_url: url.into(),
            required_headers: Vec::new(),
        }
    }

    fn download_target(
        object_id: &str,
        url: &str,
        expected: &[u8],
    ) -> ObjectDownloadTargetDescriptor {
        ObjectDownloadTargetDescriptor {
            object_id: object_id.into(),
            kind: SyncObjectKind::SYNC_OBJECT_KIND_CONTENT_PACK,
            get_url: url.into(),
            required_headers: Vec::new(),
            ciphertext_sha256: sha256_hex(expected),
            size_bytes: i64::try_from(expected.len()).unwrap(),
        }
    }

    #[derive(Default)]
    struct FakeSyncApi {
        inner: Mutex<FakeSyncApiInner>,
    }

    #[derive(Default)]
    struct FakeSyncApiInner {
        reserve_calls: usize,
        upload_batch_calls: usize,
        complete_calls: usize,
        download_batch_calls: usize,
        upload_targets_by_call: Vec<Vec<ObjectUploadTargetDescriptor>>,
        download_targets_by_call: Vec<Vec<ObjectDownloadTargetDescriptor>>,
        upload_batch_errors: Vec<SyncError>,
        upload_descriptors: Vec<Vec<ObjectUploadDescriptor>>,
        completed_uploads: Vec<Vec<CompletedObjectUploadDescriptor>>,
    }

    #[async_trait]
    impl SyncTransferApi for FakeSyncApi {
        async fn reserve_object_ids(
            &self,
            _workspace_id: &str,
            _device_id: &str,
            objects: Vec<ObjectReservationInput>,
        ) -> SyncResult<Vec<ReservedObject>> {
            self.inner.lock().reserve_calls += 1;
            Ok(objects
                .into_iter()
                .map(|object| ReservedObject {
                    object_id: format!("object-{}", object.client_object_ref),
                    client_object_ref: object.client_object_ref,
                    kind: object.kind,
                })
                .collect())
        }

        async fn create_object_upload_batch(
            &self,
            _workspace_id: &str,
            _device_id: &str,
            _upload_attempt_id: &str,
            objects: Vec<ObjectUploadDescriptor>,
        ) -> SyncResult<Vec<ObjectUploadTargetDescriptor>> {
            let mut inner = self.inner.lock();
            inner.upload_batch_calls += 1;
            inner.upload_descriptors.push(objects.clone());
            if !inner.upload_batch_errors.is_empty() {
                return Err(inner.upload_batch_errors.remove(0));
            }
            if !inner.upload_targets_by_call.is_empty() {
                return Ok(inner.upload_targets_by_call.remove(0));
            }
            Ok(objects
                .into_iter()
                .map(|object| {
                    upload_target(&object.object_id, &format!("put://{}", object.object_id))
                })
                .collect())
        }

        async fn complete_object_upload_batch(
            &self,
            _workspace_id: &str,
            _device_id: &str,
            _upload_attempt_id: &str,
            objects: Vec<CompletedObjectUploadDescriptor>,
        ) -> SyncResult<Vec<ObjectUploadCompletion>> {
            let mut inner = self.inner.lock();
            inner.complete_calls += 1;
            inner.completed_uploads.push(objects.clone());
            Ok(objects
                .into_iter()
                .map(|object| ObjectUploadCompletion {
                    object: Some(UploadedObjectMetadata {
                        object_id: object.object_id,
                        ciphertext_sha256: object.ciphertext_sha256,
                        size_bytes: object.size_bytes,
                    }),
                    error_reason: None,
                })
                .collect())
        }

        async fn create_object_download_batch(
            &self,
            _workspace_id: &str,
            _device_id: &str,
            object_ids: Vec<String>,
        ) -> SyncResult<Vec<ObjectDownloadTargetDescriptor>> {
            let mut inner = self.inner.lock();
            inner.download_batch_calls += 1;
            if !inner.download_targets_by_call.is_empty() {
                return Ok(inner.download_targets_by_call.remove(0));
            }
            Ok(object_ids
                .into_iter()
                .map(|object_id| download_target(&object_id, &format!("get://{object_id}"), b""))
                .collect())
        }
    }

    #[derive(Default)]
    struct FakeObjectHttp {
        inner: Mutex<FakeHttpInner>,
        in_flight: AtomicUsize,
        max_in_flight: AtomicUsize,
        delay: Duration,
    }

    #[derive(Default)]
    struct FakeHttpInner {
        put_urls: Vec<String>,
        get_urls: Vec<String>,
        put_failures: HashMap<String, Vec<ObjectHttpError>>,
        get_failures: HashMap<String, Vec<ObjectHttpError>>,
        get_bodies: HashMap<String, Vec<u8>>,
    }

    impl FakeObjectHttp {
        fn with_delay(delay: Duration) -> Self {
            Self {
                delay,
                ..Default::default()
            }
        }

        fn fail_put(&self, url: &str, error: ObjectHttpError) {
            self.inner
                .lock()
                .put_failures
                .entry(url.into())
                .or_default()
                .push(error);
        }

        fn fail_get(&self, url: &str, error: ObjectHttpError) {
            self.inner
                .lock()
                .get_failures
                .entry(url.into())
                .or_default()
                .push(error);
        }

        fn get_body(&self, url: &str, body: &[u8]) {
            self.inner
                .lock()
                .get_bodies
                .insert(url.into(), body.to_vec());
        }

        fn enter(&self) {
            let current = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
            loop {
                let max = self.max_in_flight.load(Ordering::SeqCst);
                if current <= max {
                    break;
                }
                if self
                    .max_in_flight
                    .compare_exchange(max, current, Ordering::SeqCst, Ordering::SeqCst)
                    .is_ok()
                {
                    break;
                }
            }
        }

        fn exit(&self) {
            self.in_flight.fetch_sub(1, Ordering::SeqCst);
        }
    }

    #[async_trait]
    impl ObjectTransferHttp for FakeObjectHttp {
        async fn put(
            &self,
            request: ObjectPutRequest,
        ) -> Result<ObjectPutResponse, ObjectHttpError> {
            self.enter();
            if !self.delay.is_zero() {
                tokio::time::sleep(self.delay).await;
            }
            let result = {
                let mut inner = self.inner.lock();
                inner.put_urls.push(request.url.clone());
                match inner.put_failures.get_mut(&request.url) {
                    Some(failures) if !failures.is_empty() => Err(failures.remove(0)),
                    _ => Ok(ObjectPutResponse {
                        provider_etag: Some(format!("etag-{}", request.url)),
                    }),
                }
            };
            self.exit();
            result
        }

        async fn get(
            &self,
            request: ObjectGetRequest,
        ) -> Result<ObjectGetResponse, ObjectHttpError> {
            self.enter();
            if !self.delay.is_zero() {
                tokio::time::sleep(self.delay).await;
            }
            let result = {
                let mut inner = self.inner.lock();
                inner.get_urls.push(request.url.clone());
                match inner.get_failures.get_mut(&request.url) {
                    Some(failures) if !failures.is_empty() => Err(failures.remove(0)),
                    _ => Ok(ObjectGetResponse {
                        body: inner
                            .get_bodies
                            .get(&request.url)
                            .cloned()
                            .unwrap_or_default(),
                    }),
                }
            };
            self.exit();
            result
        }
    }
}
