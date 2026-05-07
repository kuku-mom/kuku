import type { MarkdownContribution } from "~/plugins/types";
import remarkFrontmatter from "remark-frontmatter";

import { kukuFrontmatterMdastHandler, kukuFrontmatterPmHandler } from "./frontmatter_markdown";
import { kukuDecisionMdastHandler, kukuDecisionPmHandler } from "./decision_markdown";

const knowledgeMarkdown: MarkdownContribution = {
  remarkPlugins: [remarkFrontmatter],
  mdastToPm: {
    block: {
      code: kukuDecisionMdastHandler,
      yaml: kukuFrontmatterMdastHandler,
    },
  },
  pmToMdast: {
    block: {
      kukuDecision: kukuDecisionPmHandler,
      kukuFrontmatter: kukuFrontmatterPmHandler,
    },
  },
};

export { knowledgeMarkdown };
