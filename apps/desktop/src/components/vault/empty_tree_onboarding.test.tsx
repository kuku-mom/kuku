import { renderToString } from "solid-js/web";
import { describe, expect, it } from "vitest";

import { EmptyTreeOnboarding } from "./empty_tree_onboarding";

describe("EmptyTreeOnboarding", () => {
  it("offers first-note and folder actions for an empty vault", () => {
    const html = renderToString(() => (
      <EmptyTreeOnboarding onCreateNote={() => undefined} onCreateFolder={() => undefined} />
    ));

    expect(html).toContain("This vault is empty.");
    expect(html).toContain("Create first note");
    expect(html).toContain("New folder");
  });
});
