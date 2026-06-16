import { openDiffView } from "~/plugins/builtin/diff_view";

import type { SyncService } from "./service";
import type { SyncReviewDiffPayload } from "./types";

async function openSyncReviewDiff(
  service: SyncService,
  reviewItemId: string,
): Promise<SyncReviewDiffPayload> {
  const diff = await service.getReviewDiff(reviewItemId);
  openDiffView(diff.path, diff.oldMarkdown, diff.newMarkdown);
  return diff;
}

export { openSyncReviewDiff };
