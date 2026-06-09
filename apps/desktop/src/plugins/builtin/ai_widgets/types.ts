type WidgetType = "html" | "svg";

interface WidgetProjectFile {
  path: string;
  content: string;
}

interface WidgetProject {
  id: string;
  name: string;
  type: WidgetType;
  entry: string;
  files: WidgetProjectFile[];
  createdAt: string;
  updatedAt: string;
}

interface WidgetProjectSummary {
  id: string;
  name: string;
  type: WidgetType;
  entry: string;
  updatedAt: string;
}

interface WidgetSaveInput {
  widgetId?: string;
  name: string;
  type: WidgetType;
  entry?: string;
  files: WidgetProjectFile[];
}

interface WidgetArtifactEnvelope {
  kind: "kuku.widget-artifact";
  version: 1;
  widget: WidgetProject;
  projectPath: string;
  markdownEmbed: string;
}

export type {
  WidgetArtifactEnvelope,
  WidgetProject,
  WidgetProjectFile,
  WidgetProjectSummary,
  WidgetSaveInput,
  WidgetType,
};
