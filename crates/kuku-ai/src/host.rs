use async_trait::async_trait;

use crate::{
    AiError,
    mutation::{MutationApplyResult, MutationPlan},
};

#[async_trait]
pub trait AiHostBindings: Send + Sync {
    async fn apply_mutation(&self, plan: MutationPlan) -> Result<MutationApplyResult, AiError>;

    async fn authorization_header(
        &self,
        _requester_plugin_id: &str,
    ) -> Result<Option<String>, AiError> {
        Ok(None)
    }

    /// Force a token refresh and return the new authorization header. Called
    /// by `session::run_turn_inner` after a request fails with `Unauthorized`,
    /// so the proactive 60s expiry buffer in `authorization_header` doesn't
    /// have to cover slow upstream model latency.
    async fn refresh_authorization_header(
        &self,
        _requester_plugin_id: &str,
    ) -> Result<Option<String>, AiError> {
        Ok(None)
    }
}
