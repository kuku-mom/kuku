import type { MarkdownContribution } from "~/plugins/types";

import { kukuDecisionMdastHandler, kukuDecisionPmHandler } from "./decision_markdown";

const knowledgeMarkdown: MarkdownContribution = {
  mdastToPm: {
    block: {
      code: kukuDecisionMdastHandler,
    },
  },
  pmToMdast: {
    block: {
      kukuDecision: kukuDecisionPmHandler,
    },
  },
};

export { knowledgeMarkdown };
