import { renderToString } from "solid-js/web";
import { describe, expect, it } from "vitest";

import { AgentSettings } from "./agent_settings";

describe("AgentSettings", () => {
  it("renders external agent command settings without exposing sensitive env values", () => {
    const html = renderToString(() => (
      <AgentSettings
        agents={[
          {
            id: "codex-acp",
            label: "Codex CLI",
            command: "npx",
            args: ["-y", "@zed-industries/codex-acp@latest"],
            env: {
              OPENAI_API_KEY: "sk-test",
              PATH: "/usr/bin",
            },
            enabled: true,
          },
        ]}
      />
    ));

    expect(html).toContain("External Agents");
    expect(html).toContain("Command");
    expect(html).toContain("Args");
    expect(html).toContain("Environment");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("Codex CLI");
    expect(html).toContain("npx");
    expect(html).toContain("@zed-industries/codex-acp@latest");
    expect(html).toContain("OPENAI_API_KEY");
    expect(html).toContain("••••••••");
    expect(html).not.toContain("sk-test");
  });

  it("renders an environment editor even when an agent has no env values yet", () => {
    const html = renderToString(() => (
      <AgentSettings
        agents={[
          {
            id: "codex-acp",
            label: "Codex CLI",
            command: "npx",
            args: [],
            env: {},
            enabled: false,
          },
        ]}
      />
    ));

    expect(html).toContain("Environment");
    expect(html).toContain("<textarea");
  });

  it("uses a placeholder instead of persisting the no-args label as input value", () => {
    const html = renderToString(() => (
      <AgentSettings
        agents={[
          {
            id: "codex-acp",
            label: "Codex CLI",
            command: "npx",
            args: [],
            env: {},
            enabled: false,
          },
        ]}
      />
    ));

    expect(html).toContain('placeholder="(no args)"');
    expect(html).not.toContain('value="(no args)"');
  });
});
