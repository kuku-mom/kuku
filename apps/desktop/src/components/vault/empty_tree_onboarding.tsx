import { t } from "~/i18n";

interface EmptyTreeOnboardingProps {
  onCreateNote(): void;
  onCreateFolder(): void;
}

function EmptyTreeOnboarding(props: EmptyTreeOnboardingProps) {
  return (
    <div class="flex flex-col items-center gap-3 px-3 py-8 text-center">
      <div class="space-y-1">
        <p class="text-xs font-medium text-text-secondary">{t("vault.empty.tree")}</p>
        <p class="text-[0.6875rem]/4 text-text-muted">{t("vault.empty.tree.hint")}</p>
      </div>
      <div class="flex flex-col gap-1.5">
        <button
          type="button"
          class="rounded-xs border border-border bg-bg-secondary px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
          onClick={props.onCreateNote}
        >
          {t("vault.empty.tree.create_note")}
        </button>
        <button
          type="button"
          class="rounded-xs border border-border px-3 py-1.5 text-xs text-text-muted transition-colors hover:bg-ghost-hover hover:text-text-secondary"
          onClick={props.onCreateFolder}
        >
          {t("vault.empty.tree.create_folder")}
        </button>
      </div>
    </div>
  );
}

export { EmptyTreeOnboarding };
