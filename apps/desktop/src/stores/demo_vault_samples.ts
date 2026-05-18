interface DemoVaultSampleFile {
  path: string;
  content: string;
}

const DEMO_VAULT_SAMPLE_FILES: DemoVaultSampleFile[] = [
  {
    path: "Start Here.md",
    content: `# Start Here

Welcome to Kuku. This sample vault is intentionally small, so you can see how notes connect before adding your own work.

Try these next:

- Open [[Notes/Wikilinks.md|wikilinks]] and add a link to another note.
- Open [[Notes/Graph View.md|Graph View]] to see how connected notes become a map.
- Open [[Notes/AI Workflows.md|AI workflows]] and ask AI to summarize the vault.
`,
  },
  {
    path: "Notes/Wikilinks.md",
    content: `# Wikilinks

Kuku uses double brackets to connect notes.

Examples:

- [[Start Here.md|Start Here]]
- [[Notes/Graph View.md|Graph View]]

The text after the pipe is the label. The target before the pipe stays tied to the actual file path.
`,
  },
  {
    path: "Notes/Graph View.md",
    content: `# Graph View

Graph View visualizes connections created by wikilinks.

This note links back to [[Start Here.md|Start Here]] and forward to [[Notes/AI Workflows.md|AI workflows]].
`,
  },
  {
    path: "Notes/AI Workflows.md",
    content: `# AI Workflows

Use the AI panel to work with the notes already in the vault.

Useful first prompts:

- Summarize [[Start Here.md|Start Here]].
- Find related notes for [[Notes/Wikilinks.md|Wikilinks]].
- Draft a wiki-style summary from this sample vault.
`,
  },
];

export { DEMO_VAULT_SAMPLE_FILES };
export type { DemoVaultSampleFile };
