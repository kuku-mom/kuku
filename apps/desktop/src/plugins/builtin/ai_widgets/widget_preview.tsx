import { createMemo, type JSX } from "solid-js";

import { parseWidgetArtifactOutput } from "./artifact";
import { WIDGET_IFRAME_SANDBOX, buildWidgetIframeDocument } from "./iframe_document";

function WidgetArtifactPreview(props: { output?: string }): JSX.Element {
  const artifact = createMemo(() =>
    props.output ? parseWidgetArtifactOutput(props.output) : null,
  );
  const srcdoc = createMemo(() => {
    const current = artifact();
    return current ? buildWidgetIframeDocument(current.widget) : "";
  });

  return (
    <div class="mt-2 overflow-hidden rounded-sm border border-border/70 bg-bg-primary">
      <div class="flex min-w-0 items-center justify-between border-b border-border/60 px-2 py-1.5 text-[0.6875rem]">
        <span class="min-w-0 truncate font-medium text-text-secondary">
          {artifact()?.widget.name ?? "Widget"}
        </span>
        <span class="ml-2 shrink-0 text-text-muted">{artifact()?.widget.id}</span>
      </div>
      <iframe
        title={artifact()?.widget.name ?? "AI widget"}
        sandbox={WIDGET_IFRAME_SANDBOX}
        srcdoc={srcdoc()}
        class="block h-64 w-full border-0 bg-white"
      />
    </div>
  );
}

function isWidgetArtifactOutput(output: string | undefined): boolean {
  return output ? parseWidgetArtifactOutput(output) !== null : false;
}

export { WidgetArtifactPreview, isWidgetArtifactOutput };
