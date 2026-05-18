mod context;
mod descriptor;
mod native;
mod proxy;

use std::{collections::HashMap, sync::Arc};

use parking_lot::RwLock;

pub use context::ToolCallContext;
#[cfg(test)]
pub use descriptor::allowed_tools;
pub use descriptor::{
    ToolAccess, ToolCatalog, ToolDescriptor, ToolKind, ToolRiskLevel, ToolSource,
};
pub use native::{AiNativeTool, NativeToolResult};
pub use proxy::{ProxyBroker, ProxyToolDescriptor, ProxyToolResult};

#[derive(Default)]
pub struct ToolRegistry {
    native: RwLock<HashMap<String, Arc<dyn AiNativeTool>>>,
    proxy: RwLock<HashMap<String, ProxyToolDescriptor>>,
}

impl ToolRegistry {
    pub fn register_native(&self, tool: Arc<dyn AiNativeTool>) {
        self.native
            .write()
            .insert(tool.descriptor().name.clone(), tool);
    }

    pub fn get_native(&self, name: &str) -> Option<Arc<dyn AiNativeTool>> {
        self.native.read().get(name).cloned()
    }

    pub fn register_proxy(&self, descriptor: ProxyToolDescriptor) -> Result<(), crate::AiError> {
        descriptor.validate()?;
        self.proxy
            .write()
            .insert(descriptor.name.clone(), descriptor);
        Ok(())
    }

    pub fn unregister_proxy(&self, name: &str) {
        self.proxy.write().remove(name);
    }

    pub fn get_proxy(&self, name: &str) -> Option<ProxyToolDescriptor> {
        self.proxy.read().get(name).cloned()
    }

    pub fn descriptors(&self) -> Vec<ToolDescriptor> {
        let mut descriptors = self
            .native
            .read()
            .values()
            .map(|tool| tool.descriptor())
            .collect::<Vec<_>>();

        descriptors.extend(
            self.proxy
                .read()
                .values()
                .map(|proxy| proxy.as_tool_descriptor()),
        );

        descriptors.sort_by(|left, right| left.name.cmp(&right.name));
        descriptors
    }
}
