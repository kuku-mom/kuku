# LLM Wiki Schema

LLM Wiki is a persistent markdown wiki that sits between raw sources and chat answers.

- Treat `_raw/` as immutable source material.
- Treat the `LLM Wiki/` folder as the compiled, LLM-maintained knowledge layer.
- Read `index.md` before answering broad questions.
- Append `log.md` after ingests, important answers, lint passes, and major restructures.
- Prefer small, interlinked pages under `sources/`, `entities/`, `concepts/`, and `synthesis/`.
- Use wikilinks (`[[page]]`) for cross-references.
- When a query produces a reusable synthesis, propose filing it into `wiki/synthesis/`.
