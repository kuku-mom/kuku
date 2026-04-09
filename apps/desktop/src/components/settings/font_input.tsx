import { createEffect, createSignal } from "solid-js";

import { SettingsInput } from "~/components/settings/settings_blocks";

function FontInput(props: {
  value: string;
  placeholder?: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = createSignal(props.value);

  createEffect(() => setDraft(props.value));

  const commit = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    props.onCommit(trimmed);
  };

  return (
    <SettingsInput
      type="text"
      style={{ "font-family": draft() }}
      value={draft()}
      placeholder={props.placeholder}
      onInput={(event) => setDraft(event.currentTarget.value)}
      onBlur={(event) => commit(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          commit(event.currentTarget.value);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

export { FontInput };
