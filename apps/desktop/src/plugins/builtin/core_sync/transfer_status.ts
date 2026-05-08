import { t } from "~/i18n";

import type { SyncTransferStatus } from "./types";

function transferStatusLabel(transfer: SyncTransferStatus): string {
  if (transfer.retrying) {
    const attempt = transfer.retryAttempt ?? 1;
    const maxAttempts = transfer.maxAttempts ?? attempt;
    if (transfer.direction === "download") {
      return `${t("settings.plugin.sync.transfer.retrying_download")} ${attempt} / ${maxAttempts}`;
    }
    return `${t("settings.plugin.sync.transfer.retrying_upload")} ${attempt} / ${maxAttempts}`;
  }

  if (transfer.active && transfer.direction === "upload") {
    return `${t("settings.plugin.sync.transfer.uploading")} ${transfer.uploadCompletedObjects} / ${transfer.uploadTotalObjects}`;
  }
  if (transfer.active && transfer.direction === "download") {
    return `${t("settings.plugin.sync.transfer.downloading")} ${transfer.downloadCompletedObjects} / ${transfer.downloadTotalObjects}`;
  }
  if (transfer.active && transfer.direction === "both") {
    return `${t("settings.plugin.sync.transfer.uploading")} ${transfer.uploadCompletedObjects} / ${transfer.uploadTotalObjects}, ${t("settings.plugin.sync.transfer.downloading")} ${transfer.downloadCompletedObjects} / ${transfer.downloadTotalObjects}`;
  }

  return t("settings.plugin.sync.transfer.none");
}

export { transferStatusLabel };
