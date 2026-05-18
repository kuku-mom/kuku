import { describe, expect, it } from "vitest";

import { DEMO_VAULT_SAMPLE_FILES } from "./demo_vault_samples";

describe("demo vault samples", () => {
  it("provides a small connected starter vault", () => {
    expect(DEMO_VAULT_SAMPLE_FILES.map((file) => file.path)).toEqual([
      "Start Here.md",
      "Notes/Wikilinks.md",
      "Notes/Graph View.md",
      "Notes/AI Workflows.md",
    ]);
    expect(DEMO_VAULT_SAMPLE_FILES[0].content).toContain("[[Notes/Wikilinks.md|wikilinks]]");
    expect(DEMO_VAULT_SAMPLE_FILES[0].content).toContain("[[Notes/Graph View.md|Graph View]]");
    expect(DEMO_VAULT_SAMPLE_FILES[0].content).toContain("[[Notes/AI Workflows.md|AI workflows]]");
  });

  it("uses markdown files with visible titles", () => {
    for (const file of DEMO_VAULT_SAMPLE_FILES) {
      expect(file.path.endsWith(".md")).toBe(true);
      expect(file.content).toMatch(/^# /);
    }
  });
});
