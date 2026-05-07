import type { SettingsContribution } from "~/plugins/types";

interface KnowledgeSettings {
  panelEnabled: boolean;
}

const knowledgeSettings: SettingsContribution = {
  version: 1,
  defaults: {
    panelEnabled: true,
  },
  schema: {
    type: "object",
    properties: {
      panelEnabled: {
        type: "boolean",
        default: true,
      },
    },
    additionalProperties: false,
  },
  meta: {
    panelEnabled: {
      label: "Show panel",
      control: "toggle",
      order: 10,
    },
  },
};

export { knowledgeSettings };
export type { KnowledgeSettings };
