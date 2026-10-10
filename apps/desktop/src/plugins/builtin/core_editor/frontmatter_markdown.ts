import type { RootContent } from "mdast";

import type { MdastToPmBlockHandler, PMNodeJSON, PmToMdastBlockHandler } from "~/lib/markdown";

interface YamlNode {
  type: "yaml";
  value?: string;
}

const kukuFrontmatterMdastHandler: MdastToPmBlockHandler = (node) => {
  const yaml = node as YamlNode;
  const result: PMNodeJSON = {
    type: "kukuFrontmatter",
    attrs: { value: yaml.value ?? "" },
  };
  return [result];
};

const kukuFrontmatterPmHandler: PmToMdastBlockHandler = (node) =>
  ({
    type: "yaml",
    value: normalizeFrontmatterValue(node.attrs?.value),
  }) as unknown as RootContent;

function normalizeFrontmatterValue(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\r\n?/g, "\n").trim();
}

export { kukuFrontmatterMdastHandler, kukuFrontmatterPmHandler };
