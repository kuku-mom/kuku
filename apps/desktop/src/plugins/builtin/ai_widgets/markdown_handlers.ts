import type { MarkdownContribution } from "~/plugins/types";

import { kukuWidgetMdastHandler, kukuWidgetPmHandler } from "./widget_markdown";

const aiWidgetMarkdown: MarkdownContribution = {
  mdastToPm: {
    block: {
      code: kukuWidgetMdastHandler,
    },
  },
  pmToMdast: {
    block: {
      kukuWidget: kukuWidgetPmHandler,
    },
  },
};

export { aiWidgetMarkdown };
