import { createContext, useContext, type Accessor, type JSX } from "solid-js";

const SettingsRefreshContext = createContext<Accessor<number | undefined>>(() => undefined);

function SettingsRefreshProvider(props: { value: number; children: JSX.Element }): JSX.Element {
  return (
    <SettingsRefreshContext.Provider value={() => props.value}>
      {props.children}
    </SettingsRefreshContext.Provider>
  );
}

function useSettingsRefreshToken(): Accessor<number | undefined> {
  return useContext(SettingsRefreshContext);
}

export { SettingsRefreshProvider, useSettingsRefreshToken };
