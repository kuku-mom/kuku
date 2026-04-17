import { createStore } from "solid-js/store";

import type { VaultEntryDragPayload } from "~/lib/vault_drag";

interface VaultDragState {
  isDragging: boolean;
  payload: VaultEntryDragPayload | null;
  mouseX: number;
  mouseY: number;
  chatDropActive: boolean;
}

const [vaultDragState, setVaultDragState] = createStore<VaultDragState>({
  isDragging: false,
  payload: null,
  mouseX: 0,
  mouseY: 0,
  chatDropActive: false,
});

function startVaultDrag(payload: VaultEntryDragPayload, mouseX: number, mouseY: number): void {
  setVaultDragState({
    isDragging: true,
    payload,
    mouseX,
    mouseY,
    chatDropActive: false,
  });
}

function updateVaultDragPointer(mouseX: number, mouseY: number): void {
  if (!vaultDragState.isDragging) return;
  setVaultDragState({ mouseX, mouseY });
}

function setVaultDragChatDropActive(active: boolean): void {
  if (vaultDragState.chatDropActive === active) return;
  setVaultDragState("chatDropActive", active);
}

function clearVaultDrag(): void {
  setVaultDragState({
    isDragging: false,
    payload: null,
    mouseX: 0,
    mouseY: 0,
    chatDropActive: false,
  });
}

export {
  clearVaultDrag,
  setVaultDragChatDropActive,
  startVaultDrag,
  updateVaultDragPointer,
  vaultDragState,
};
export type { VaultDragState };
