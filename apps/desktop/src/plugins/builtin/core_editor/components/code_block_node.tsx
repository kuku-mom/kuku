import {
  Show,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  onCleanup,
  onMount,
  untrack,
} from "solid-js";
import type { SolidNodeViewProps } from "prosekit/solid";

let mermaidLoader: Promise<typeof import("mermaid").default> | null = null;

function CodeBlockNode(props: SolidNodeViewProps) {
  const diagramId = `kuku-editor-mermaid-${createUniqueId().replace(/:/g, "-")}`;
  const fence = createMemo(() => normalizeFence(props.node.attrs.fence));
  const language = createMemo(() => {
    const value = props.node.attrs.language;
    return typeof value === "string" ? value : "";
  });
  const source = createMemo(() => props.node.textContent ?? "");
  const isMermaid = createMemo(() => language().toLowerCase() === "mermaid");
  const [openingFence, setOpeningFence] = createSignal(formatOpeningFence(fence(), language()));
  const [closingFence, setClosingFence] = createSignal(fence());
  const [mermaidSvg, setMermaidSvg] = createSignal<string | null>(null);
  const [mermaidFailed, setMermaidFailed] = createSignal(false);
  let disposed = false;

  createEffect(() => {
    const nextFence = fence();
    const nextOpening = formatOpeningFence(nextFence, language());
    if (untrack(openingFence) !== nextOpening) {
      setOpeningFence(nextOpening);
    }
    if (untrack(closingFence) !== nextFence) {
      setClosingFence(nextFence);
    }
  });

  onMount(() => {
    createEffect(() => {
      if (!isMermaid()) {
        setMermaidSvg(null);
        setMermaidFailed(false);
        return;
      }

      const currentSource = source();
      if (!currentSource.trim()) {
        setMermaidSvg(null);
        setMermaidFailed(false);
        return;
      }

      let cancelled = false;
      void loadMermaid()
        .then((mermaid) => mermaid.render(`${diagramId}-${hashString(currentSource)}`, currentSource))
        .then(({ svg }) => {
          if (!disposed && !cancelled) {
            setMermaidSvg(svg);
            setMermaidFailed(false);
          }
        })
        .catch(() => {
          if (!disposed && !cancelled) {
            setMermaidSvg(null);
            setMermaidFailed(true);
          }
        });

      onCleanup(() => {
        cancelled = true;
      });
    });
  });

  onCleanup(() => {
    disposed = true;
  });

  function updateOpeningFence(value: string): void {
    setOpeningFence(value);
    const parsed = parseOpeningFence(value);
    if (!parsed) return;
    props.setAttrs({
      ...props.node.attrs,
      fence: parsed.fence,
      language: parsed.language,
    });
  }

  function updateClosingFence(value: string): void {
    setClosingFence(value);
    const parsed = parseClosingFence(value);
    if (!parsed) return;
    props.setAttrs({
      ...props.node.attrs,
      fence: parsed,
    });
  }

  return (
    <div data-kuku-code-block="">
      <div contentEditable={false} data-kuku-code-block-opening-fence="">
        <input
          aria-label="Opening code fence"
          data-kuku-code-block-opening-input=""
          onInput={(event) => updateOpeningFence(event.currentTarget.value)}
          spellcheck={false}
          value={openingFence()}
        />
      </div>
      <pre data-kuku-code-block-body="">
        <code ref={props.contentRef} data-kuku-code-block-content="" />
      </pre>
      <div contentEditable={false} data-kuku-code-block-closing-fence="">
        <input
          aria-label="Closing code fence"
          data-kuku-code-block-closing-input=""
          onInput={(event) => updateClosingFence(event.currentTarget.value)}
          spellcheck={false}
          value={closingFence()}
        />
      </div>
      <Show when={isMermaid()}>
        <div contentEditable={false} data-kuku-code-block-mermaid-preview="">
          <Show
            when={!mermaidFailed()}
            fallback={<div data-kuku-code-block-mermaid-error="">Mermaid render failed</div>}
          >
            <Show
              when={mermaidSvg()}
              fallback={<div data-kuku-code-block-mermaid-placeholder="" aria-hidden="true" />}
            >
              {(svg) => <div data-kuku-code-block-mermaid-svg="" innerHTML={svg()} />}
            </Show>
          </Show>
        </div>
      </Show>
    </div>
  );
}

async function loadMermaid(): Promise<typeof import("mermaid").default> {
  if (!mermaidLoader) {
    mermaidLoader = import("mermaid").then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "base",
        fontFamily: "inherit",
      });
      return mermaid;
    });
  }
  return mermaidLoader;
}

function stopCodeBlockNodeEvent(event: Event): boolean {
  return (
    event.target instanceof Element &&
    Boolean(
      event.target.closest(
        "[data-kuku-code-block-opening-input],[data-kuku-code-block-closing-input]",
      ),
    )
  );
}

function normalizeFence(value: unknown): "```" | "~~~" {
  return value === "~~~" ? "~~~" : "```";
}

function formatOpeningFence(fence: "```" | "~~~", language: string): string {
  return `${fence}${language}`;
}

function parseOpeningFence(value: string): { fence: "```" | "~~~"; language: string } | null {
  const match = /^(?<fence>```|~~~)(?<language>[^\s`~]*)\s*$/.exec(value.trim());
  if (!match?.groups) return null;
  return {
    fence: normalizeFence(match.groups.fence),
    language: match.groups.language ?? "",
  };
}

function parseClosingFence(value: string): "```" | "~~~" | null {
  const trimmed = value.trim();
  return trimmed === "```" || trimmed === "~~~" ? trimmed : null;
}

function hashString(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

export { stopCodeBlockNodeEvent };
export default CodeBlockNode;
