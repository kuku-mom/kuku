use std::collections::{BTreeMap, BTreeSet};
use std::ops::Range;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_yaml::Mapping;

use crate::knowledge::markdown::{
    is_valid_knowledge_id, validate_safe_vault_relative_path, validate_sha256_checksum,
    validate_wiki_page_path,
};
use crate::knowledge::models::{KnowledgeErrorCode, SourceRange, SourceRef};

const MAX_DOCUMENT_BYTES: usize = 2 * 1024 * 1024;
const MAX_FRONTMATTER_BYTES: usize = 64 * 1024;
const MAX_KUKU_BLOCKS: usize = 200;
const MAX_PROPOSAL_BLOCKS: usize = 100;
const MAX_DECISION_BLOCKS: usize = 100;
const MAX_KUKU_PAYLOAD_BYTES: usize = 128 * 1024;
const MAX_ID_CHARS: usize = 84;
const MAX_TITLE_CHARS: usize = 160;
const MAX_KIND_CHARS: usize = 40;
const MAX_TAG_CHARS: usize = 40;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecisionDocumentError {
    pub code: KnowledgeErrorCode,
    pub message: String,
}

impl DecisionDocumentError {
    fn validation(message: impl Into<String>) -> Self {
        Self {
            code: KnowledgeErrorCode::ValidationFailed,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ByteRange {
    pub start: usize,
    pub end: usize,
}

impl ByteRange {
    fn new(start: usize, end: usize) -> Self {
        Self { start, end }
    }

    fn as_range(&self) -> Range<usize> {
        self.start..self.end
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KukuBlockSpan {
    pub full: ByteRange,
    pub opening_fence: ByteRange,
    pub payload: ByteRange,
    pub closing_fence: ByteRange,
}

#[derive(Debug, Clone)]
pub struct ParsedDecisionDocument {
    pub markdown: String,
    pub frontmatter: DecisionDocumentFrontmatter,
    pub frontmatter_span: ByteRange,
    pub blocks: Vec<ParsedKukuBlock>,
}

impl ParsedDecisionDocument {
    pub fn proposal_blocks(&self) -> impl Iterator<Item = &ParsedMemoryProposalBlock> {
        self.blocks.iter().filter_map(|block| match block {
            ParsedKukuBlock::MemoryProposal(block) => Some(block),
            ParsedKukuBlock::WikiProposal(_) => None,
            ParsedKukuBlock::Decision(_) => None,
        })
    }

    pub fn wiki_proposal_blocks(&self) -> impl Iterator<Item = &ParsedWikiProposalBlock> {
        self.blocks.iter().filter_map(|block| match block {
            ParsedKukuBlock::MemoryProposal(_) => None,
            ParsedKukuBlock::WikiProposal(block) => Some(block),
            ParsedKukuBlock::Decision(_) => None,
        })
    }

    pub fn decision_blocks(&self) -> impl Iterator<Item = &ParsedDecisionBlock> {
        self.blocks.iter().filter_map(|block| match block {
            ParsedKukuBlock::MemoryProposal(_) => None,
            ParsedKukuBlock::WikiProposal(_) => None,
            ParsedKukuBlock::Decision(block) => Some(block),
        })
    }
}

#[derive(Debug, Clone)]
pub struct DecisionDocumentFrontmatter {
    pub id: String,
    pub proposal_id: String,
    pub target_kind: String,
    pub request_source: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    pub source_refs: Vec<SourceRef>,
    pub raw: Mapping,
}

#[derive(Debug, Clone)]
pub enum ParsedKukuBlock {
    MemoryProposal(ParsedMemoryProposalBlock),
    WikiProposal(ParsedWikiProposalBlock),
    Decision(ParsedDecisionBlock),
}

impl ParsedKukuBlock {
    fn span(&self) -> Option<&KukuBlockSpan> {
        match self {
            Self::MemoryProposal(block) => block.span.as_ref(),
            Self::WikiProposal(block) => block.span.as_ref(),
            Self::Decision(block) => block.span.as_ref(),
        }
    }

    fn canonical_markdown(&self) -> Result<String, DecisionDocumentError> {
        match self {
            Self::MemoryProposal(block) => render_kuku_block("kuku-memory-proposal", &block.value),
            Self::WikiProposal(block) => render_kuku_block("kuku-wiki-proposal", &block.value),
            Self::Decision(block) => render_kuku_block("kuku-decision", &block.value),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ParsedMemoryProposalBlock {
    pub span: Option<KukuBlockSpan>,
    pub value: MemoryProposalBlock,
}

#[derive(Debug, Clone)]
pub struct ParsedWikiProposalBlock {
    pub span: Option<KukuBlockSpan>,
    pub value: WikiProposalBlock,
}

#[derive(Debug, Clone)]
pub struct ParsedDecisionBlock {
    pub span: Option<KukuBlockSpan>,
    pub value: DecisionBlock,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryProposalBlock {
    pub id: String,
    pub operation: String,
    pub memory: MemoryProposalMemory,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryProposalMemory {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    pub title: String,
    pub tags: Vec<String>,
    pub body: String,
    pub source_refs: Vec<SourceRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WikiProposalBlock {
    pub id: String,
    pub operation: String,
    pub page: WikiProposalPage,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WikiProposalPage {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_checksum: Option<String>,
    pub page_type: String,
    pub title: String,
    pub tags: Vec<String>,
    pub body: String,
    pub source_refs: Vec<SourceRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DecisionBlock {
    pub id: String,
    pub proposal_id: String,
    pub target_change_id: String,
    pub question: String,
    pub selection_mode: String,
    pub required: bool,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_option_id: Option<String>,
    pub options: Vec<DecisionOptionBlock>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub other_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DecisionOptionBlock {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requires_input: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecisionDocumentIntegrity {
    pub doc_id: String,
    pub proposal_id: String,
    pub yes_memory_paths: Vec<String>,
    pub yes_wiki_paths: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct FrontmatterKnown {
    id: String,
    proposal_id: String,
    target_kind: String,
    request_source: String,
    status: String,
    created_at: String,
    updated_at: String,
    source_refs: Vec<SourceRef>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KukuLanguage {
    MemoryProposal,
    WikiProposal,
    Decision,
}

pub fn parse_decision_document(
    markdown: &str,
) -> Result<ParsedDecisionDocument, DecisionDocumentError> {
    if markdown.len() > MAX_DOCUMENT_BYTES {
        return Err(DecisionDocumentError::validation(
            "Decision document exceeds maximum size",
        ));
    }

    let (frontmatter, frontmatter_span) = parse_frontmatter(markdown)?;
    let blocks = parse_kuku_blocks(markdown)?;

    Ok(ParsedDecisionDocument {
        markdown: markdown.to_string(),
        frontmatter,
        frontmatter_span,
        blocks,
    })
}

pub fn canonicalize_kuku_blocks(
    document: &ParsedDecisionDocument,
) -> Result<String, DecisionDocumentError> {
    render_with_replacements(
        &document.markdown,
        document
            .blocks
            .iter()
            .map(|block| {
                let Some(span) = block.span() else {
                    return Err(DecisionDocumentError::validation(
                        "Kuku block is missing byte span data",
                    ));
                };
                Ok((span.full.clone(), block.canonical_markdown()?))
            })
            .collect::<Result<Vec<_>, _>>()?,
    )
}

pub fn render_decision_document(
    document: &ParsedDecisionDocument,
) -> Result<String, DecisionDocumentError> {
    let mut replacements = vec![(
        document.frontmatter_span.clone(),
        render_frontmatter_block(&document.frontmatter.raw)?,
    )];

    for block in &document.blocks {
        let Some(span) = block.span() else {
            return Err(DecisionDocumentError::validation(
                "Kuku block is missing byte span data",
            ));
        };
        replacements.push((span.full.clone(), block.canonical_markdown()?));
    }

    render_with_replacements(&document.markdown, replacements)
}

fn render_with_replacements(
    markdown: &str,
    mut replacements: Vec<(ByteRange, String)>,
) -> Result<String, DecisionDocumentError> {
    let mut output = String::with_capacity(markdown.len());
    let mut cursor = 0;
    replacements.sort_by_key(|(range, _)| range.start);

    for (range, replacement) in replacements {
        if range.start < cursor || range.end > markdown.len() {
            return Err(DecisionDocumentError::validation(
                "Kuku block byte span is invalid",
            ));
        }
        output.push_str(&markdown[cursor..range.start]);
        output.push_str(&replacement);
        cursor = range.end;
    }
    output.push_str(&markdown[cursor..]);

    Ok(output)
}

fn render_frontmatter_block(frontmatter: &Mapping) -> Result<String, DecisionDocumentError> {
    let mut yaml = serde_yaml::to_string(frontmatter)
        .map_err(|error| DecisionDocumentError::validation(error.to_string()))?;
    if let Some(stripped) = yaml.strip_prefix("---\n") {
        yaml = stripped.to_string();
    }
    if !yaml.ends_with('\n') {
        yaml.push('\n');
    }
    Ok(format!("---\n{yaml}---\n"))
}

pub fn validate_decision_document_integrity(
    document: &ParsedDecisionDocument,
    root: Option<&Path>,
) -> Result<DecisionDocumentIntegrity, DecisionDocumentError> {
    validate_document_frontmatter(&document.frontmatter)?;

    match document.frontmatter.target_kind.as_str() {
        "memory" => validate_memory_decision_document_integrity(document, root),
        "wiki" => validate_wiki_decision_document_integrity(document, root),
        _ => Err(DecisionDocumentError::validation(
            "Unsupported decision document target_kind",
        )),
    }
}

fn validate_memory_decision_document_integrity(
    document: &ParsedDecisionDocument,
    root: Option<&Path>,
) -> Result<DecisionDocumentIntegrity, DecisionDocumentError> {
    if document.wiki_proposal_blocks().next().is_some() {
        return Err(DecisionDocumentError::validation(
            "Memory decision document cannot contain wiki proposal blocks",
        ));
    }

    let proposals = document.proposal_blocks().collect::<Vec<_>>();
    let decisions = document.decision_blocks().collect::<Vec<_>>();
    if proposals.is_empty() {
        return Err(DecisionDocumentError::validation(
            "Decision document has no memory proposal blocks",
        ));
    }
    if decisions.is_empty() {
        return Err(DecisionDocumentError::validation(
            "Decision document has no decision blocks",
        ));
    }

    let mut proposal_by_id = BTreeMap::new();
    let mut memory_ids = BTreeSet::new();
    for proposal in proposals {
        if proposal.span.is_none() {
            return Err(DecisionDocumentError::validation(
                "Memory proposal block is missing byte span data",
            ));
        }
        validate_memory_proposal(&proposal.value)?;
        if proposal_by_id
            .insert(proposal.value.id.clone(), proposal.value.clone())
            .is_some()
        {
            return Err(DecisionDocumentError::validation(format!(
                "Duplicate memory proposal id: {}",
                proposal.value.id
            )));
        }
        if !memory_ids.insert(proposal.value.memory.id.clone()) {
            return Err(DecisionDocumentError::validation(format!(
                "Duplicate proposed memory id: {}",
                proposal.value.memory.id
            )));
        }
    }

    let mut decision_ids = BTreeSet::new();
    let mut decision_count_by_target = BTreeMap::<String, usize>::new();
    let mut yes_memory_paths = Vec::new();
    let mut yes_memory_path_set = BTreeSet::new();

    for decision in decisions {
        if decision.span.is_none() {
            return Err(DecisionDocumentError::validation(
                "Decision block is missing byte span data",
            ));
        }
        validate_decision(&decision.value, &document.frontmatter.proposal_id)?;
        if !decision_ids.insert(decision.value.id.clone()) {
            return Err(DecisionDocumentError::validation(format!(
                "Duplicate decision id: {}",
                decision.value.id
            )));
        }

        let Some(proposal) = proposal_by_id.get(&decision.value.target_change_id) else {
            return Err(DecisionDocumentError::validation(format!(
                "Decision target_change_id has no matching proposal: {}",
                decision.value.target_change_id
            )));
        };
        *decision_count_by_target
            .entry(decision.value.target_change_id.clone())
            .or_insert(0) += 1;

        if decision.value.selected_option_id.as_deref() == Some("yes") {
            let memory_path = memory_path_for_id(&proposal.memory.id);
            if !yes_memory_path_set.insert(memory_path.clone()) {
                return Err(DecisionDocumentError::validation(format!(
                    "Duplicate yes memory output path: {memory_path}"
                )));
            }
            if let Some(root) = root
                && root.join(&memory_path).exists()
            {
                return Err(DecisionDocumentError::validation(format!(
                    "Memory output path already exists: {memory_path}"
                )));
            }
            yes_memory_paths.push(memory_path);
        }
    }

    for proposal_id in proposal_by_id.keys() {
        match decision_count_by_target
            .get(proposal_id)
            .copied()
            .unwrap_or(0)
        {
            1 => {}
            0 => {
                return Err(DecisionDocumentError::validation(format!(
                    "Proposal has no matching decision: {proposal_id}"
                )));
            }
            _ => {
                return Err(DecisionDocumentError::validation(format!(
                    "Proposal has more than one matching decision: {proposal_id}"
                )));
            }
        }
    }

    Ok(DecisionDocumentIntegrity {
        doc_id: document.frontmatter.id.clone(),
        proposal_id: document.frontmatter.proposal_id.clone(),
        yes_memory_paths,
        yes_wiki_paths: Vec::new(),
    })
}

fn validate_wiki_decision_document_integrity(
    document: &ParsedDecisionDocument,
    root: Option<&Path>,
) -> Result<DecisionDocumentIntegrity, DecisionDocumentError> {
    if document.proposal_blocks().next().is_some() {
        return Err(DecisionDocumentError::validation(
            "Wiki decision document cannot contain memory proposal blocks",
        ));
    }

    let proposals = document.wiki_proposal_blocks().collect::<Vec<_>>();
    let decisions = document.decision_blocks().collect::<Vec<_>>();
    if proposals.is_empty() {
        return Err(DecisionDocumentError::validation(
            "Decision document has no wiki proposal blocks",
        ));
    }
    if decisions.is_empty() {
        return Err(DecisionDocumentError::validation(
            "Decision document has no decision blocks",
        ));
    }

    let mut proposal_by_id = BTreeMap::new();
    let mut wiki_paths = BTreeSet::new();
    for proposal in proposals {
        if proposal.span.is_none() {
            return Err(DecisionDocumentError::validation(
                "Wiki proposal block is missing byte span data",
            ));
        }
        validate_wiki_proposal(&proposal.value)?;
        if proposal_by_id
            .insert(proposal.value.id.clone(), proposal.value.clone())
            .is_some()
        {
            return Err(DecisionDocumentError::validation(format!(
                "Duplicate wiki proposal id: {}",
                proposal.value.id
            )));
        }
        let path = normalize_wiki_proposal_path(&proposal.value.page.path)?;
        if !wiki_paths.insert(path.clone()) {
            return Err(DecisionDocumentError::validation(format!(
                "Duplicate proposed wiki path: {path}"
            )));
        }
    }

    let mut decision_ids = BTreeSet::new();
    let mut decision_count_by_target = BTreeMap::<String, usize>::new();
    let mut yes_wiki_paths = Vec::new();
    let mut yes_wiki_path_set = BTreeSet::new();

    for decision in decisions {
        if decision.span.is_none() {
            return Err(DecisionDocumentError::validation(
                "Decision block is missing byte span data",
            ));
        }
        validate_decision(&decision.value, &document.frontmatter.proposal_id)?;
        if !decision_ids.insert(decision.value.id.clone()) {
            return Err(DecisionDocumentError::validation(format!(
                "Duplicate decision id: {}",
                decision.value.id
            )));
        }

        let Some(proposal) = proposal_by_id.get(&decision.value.target_change_id) else {
            return Err(DecisionDocumentError::validation(format!(
                "Decision target_change_id has no matching proposal: {}",
                decision.value.target_change_id
            )));
        };
        *decision_count_by_target
            .entry(decision.value.target_change_id.clone())
            .or_insert(0) += 1;

        if decision.value.selected_option_id.as_deref() == Some("yes") {
            let wiki_path = normalize_wiki_proposal_path(&proposal.page.path)?;
            if !yes_wiki_path_set.insert(wiki_path.clone()) {
                return Err(DecisionDocumentError::validation(format!(
                    "Duplicate yes wiki output path: {wiki_path}"
                )));
            }
            if let Some(root) = root {
                let exists = root.join(&wiki_path).exists();
                match proposal.operation.as_str() {
                    "create_wiki_page" if exists => {
                        return Err(DecisionDocumentError::validation(format!(
                            "Wiki output path already exists: {wiki_path}"
                        )));
                    }
                    "update_wiki_page" if !exists => {
                        return Err(DecisionDocumentError::validation(format!(
                            "Wiki update path does not exist: {wiki_path}"
                        )));
                    }
                    _ => {}
                }
            }
            yes_wiki_paths.push(wiki_path);
        }
    }

    for proposal_id in proposal_by_id.keys() {
        match decision_count_by_target
            .get(proposal_id)
            .copied()
            .unwrap_or(0)
        {
            1 => {}
            0 => {
                return Err(DecisionDocumentError::validation(format!(
                    "Proposal has no matching decision: {proposal_id}"
                )));
            }
            _ => {
                return Err(DecisionDocumentError::validation(format!(
                    "Proposal has more than one matching decision: {proposal_id}"
                )));
            }
        }
    }

    Ok(DecisionDocumentIntegrity {
        doc_id: document.frontmatter.id.clone(),
        proposal_id: document.frontmatter.proposal_id.clone(),
        yes_memory_paths: Vec::new(),
        yes_wiki_paths,
    })
}

fn parse_frontmatter(
    markdown: &str,
) -> Result<(DecisionDocumentFrontmatter, ByteRange), DecisionDocumentError> {
    let rest = markdown
        .strip_prefix("---\n")
        .ok_or_else(|| DecisionDocumentError::validation("Missing document frontmatter"))?;
    let Some(index) = rest.find("\n---\n") else {
        return Err(DecisionDocumentError::validation(
            "Missing closing frontmatter marker",
        ));
    };
    let payload_start = "---\n".len();
    let payload_end = payload_start + index;
    if payload_end - payload_start > MAX_FRONTMATTER_BYTES {
        return Err(DecisionDocumentError::validation(
            "Decision document frontmatter exceeds maximum size",
        ));
    }

    let payload = &markdown[payload_start..payload_end];
    let known: FrontmatterKnown = serde_yaml::from_str(payload).map_err(|error| {
        DecisionDocumentError::validation(format!("Malformed document frontmatter: {error}"))
    })?;
    let raw = serde_yaml::from_str::<Mapping>(payload).map_err(|error| {
        DecisionDocumentError::validation(format!("Malformed document frontmatter: {error}"))
    })?;

    Ok((
        DecisionDocumentFrontmatter {
            id: known.id,
            proposal_id: known.proposal_id,
            target_kind: known.target_kind,
            request_source: known.request_source,
            status: known.status,
            created_at: known.created_at,
            updated_at: known.updated_at,
            source_refs: known.source_refs,
            raw,
        },
        ByteRange::new(0, payload_end + "\n---\n".len()),
    ))
}

fn parse_kuku_blocks(markdown: &str) -> Result<Vec<ParsedKukuBlock>, DecisionDocumentError> {
    let mut blocks = Vec::new();
    let mut line_start = 0;
    while line_start < markdown.len() {
        let line = line_at(markdown, line_start);
        let Some(opening) = parse_opening_fence(line.text) else {
            line_start = line.end;
            continue;
        };

        let Some(language) = kuku_language(opening.info) else {
            line_start = find_closing_fence(markdown, line.end, opening.marker, opening.len)
                .map(|closing| closing.end)
                .unwrap_or(line.end);
            continue;
        };

        let closing = find_closing_fence(markdown, line.end, opening.marker, opening.len)
            .ok_or_else(|| {
                DecisionDocumentError::validation("Kuku fenced block is missing closing fence")
            })?;
        let payload_range = ByteRange::new(line.end, closing.start);
        if payload_range.end - payload_range.start > MAX_KUKU_PAYLOAD_BYTES {
            return Err(DecisionDocumentError::validation(
                "Kuku fenced block payload exceeds maximum size",
            ));
        }

        let span = KukuBlockSpan {
            full: ByteRange::new(line.start, closing.end),
            opening_fence: ByteRange::new(line.start, line.end),
            payload: payload_range.clone(),
            closing_fence: ByteRange::new(closing.start, closing.end),
        };
        let payload = &markdown[payload_range.as_range()];
        blocks.push(match language {
            KukuLanguage::MemoryProposal => {
                let value = parse_memory_proposal_block(payload)?;
                ParsedKukuBlock::MemoryProposal(ParsedMemoryProposalBlock {
                    span: Some(span),
                    value,
                })
            }
            KukuLanguage::WikiProposal => {
                let value = parse_wiki_proposal_block(payload)?;
                ParsedKukuBlock::WikiProposal(ParsedWikiProposalBlock {
                    span: Some(span),
                    value,
                })
            }
            KukuLanguage::Decision => {
                let value = parse_decision_block(payload)?;
                ParsedKukuBlock::Decision(ParsedDecisionBlock {
                    span: Some(span),
                    value,
                })
            }
        });

        if blocks.len() > MAX_KUKU_BLOCKS {
            return Err(DecisionDocumentError::validation(
                "Decision document has too many Kuku fenced blocks",
            ));
        }
        if blocks
            .iter()
            .filter(|block| {
                matches!(
                    block,
                    ParsedKukuBlock::MemoryProposal(_) | ParsedKukuBlock::WikiProposal(_)
                )
            })
            .count()
            > MAX_PROPOSAL_BLOCKS
        {
            return Err(DecisionDocumentError::validation(
                "Decision document has too many proposal blocks",
            ));
        }
        if blocks
            .iter()
            .filter(|block| matches!(block, ParsedKukuBlock::Decision(_)))
            .count()
            > MAX_DECISION_BLOCKS
        {
            return Err(DecisionDocumentError::validation(
                "Decision document has too many decision blocks",
            ));
        }

        line_start = closing.end;
    }

    Ok(blocks)
}

fn parse_memory_proposal_block(
    payload: &str,
) -> Result<MemoryProposalBlock, DecisionDocumentError> {
    serde_yaml::from_str(payload).map_err(|error| {
        DecisionDocumentError::validation(format!("Malformed kuku-memory-proposal block: {error}"))
    })
}

fn parse_wiki_proposal_block(payload: &str) -> Result<WikiProposalBlock, DecisionDocumentError> {
    serde_yaml::from_str(payload).map_err(|error| {
        DecisionDocumentError::validation(format!("Malformed kuku-wiki-proposal block: {error}"))
    })
}

fn parse_decision_block(payload: &str) -> Result<DecisionBlock, DecisionDocumentError> {
    serde_yaml::from_str(payload).map_err(|error| {
        DecisionDocumentError::validation(format!("Malformed kuku-decision block: {error}"))
    })
}

fn render_kuku_block<T: Serialize>(
    language: &str,
    value: &T,
) -> Result<String, DecisionDocumentError> {
    let mut yaml = serde_yaml::to_string(value)
        .map_err(|error| DecisionDocumentError::validation(error.to_string()))?;
    if let Some(stripped) = yaml.strip_prefix("---\n") {
        yaml = stripped.to_string();
    }
    if !yaml.ends_with('\n') {
        yaml.push('\n');
    }
    Ok(format!("```{language}\n{yaml}```\n"))
}

#[derive(Debug, Clone, Copy)]
struct Line<'a> {
    text: &'a str,
    start: usize,
    end: usize,
}

fn line_at(markdown: &str, start: usize) -> Line<'_> {
    let relative_end = markdown[start..]
        .find('\n')
        .map(|index| index + 1)
        .unwrap_or(markdown.len() - start);
    let end = start + relative_end;
    let text_end = if end > start && markdown.as_bytes()[end - 1] == b'\n' {
        end - 1
    } else {
        end
    };
    Line {
        text: &markdown[start..text_end],
        start,
        end,
    }
}

#[derive(Debug, Clone, Copy)]
struct OpeningFence<'a> {
    marker: char,
    len: usize,
    info: &'a str,
}

fn parse_opening_fence(line: &str) -> Option<OpeningFence<'_>> {
    let indent = line.bytes().take_while(|byte| *byte == b' ').count();
    if indent > 3 {
        return None;
    }
    let rest = &line[indent..];
    let marker = rest.chars().next()?;
    if marker != '`' && marker != '~' {
        return None;
    }
    let len = rest.chars().take_while(|ch| *ch == marker).count();
    if len < 3 {
        return None;
    }
    let info = rest[len..].trim();
    Some(OpeningFence { marker, len, info })
}

fn find_closing_fence(
    markdown: &str,
    mut start: usize,
    marker: char,
    opening_len: usize,
) -> Option<Line<'_>> {
    while start < markdown.len() {
        let line = line_at(markdown, start);
        if is_closing_fence(line.text, marker, opening_len) {
            return Some(line);
        }
        start = line.end;
    }
    None
}

fn is_closing_fence(line: &str, marker: char, opening_len: usize) -> bool {
    let indent = line.bytes().take_while(|byte| *byte == b' ').count();
    if indent > 3 {
        return false;
    }
    let rest = &line[indent..];
    let len = rest.chars().take_while(|ch| *ch == marker).count();
    if len < opening_len {
        return false;
    }
    rest[len..].trim().is_empty()
}

fn kuku_language(info: &str) -> Option<KukuLanguage> {
    match info.split_whitespace().next()? {
        "kuku-memory-proposal" => Some(KukuLanguage::MemoryProposal),
        "kuku-wiki-proposal" => Some(KukuLanguage::WikiProposal),
        "kuku-decision" => Some(KukuLanguage::Decision),
        _ => None,
    }
}

fn validate_document_frontmatter(
    frontmatter: &DecisionDocumentFrontmatter,
) -> Result<(), DecisionDocumentError> {
    validate_prefixed_id(&frontmatter.id, "doc", "document id")?;
    validate_prefixed_id(&frontmatter.proposal_id, "prop", "document proposal_id")?;
    if !matches!(frontmatter.target_kind.as_str(), "memory" | "wiki") {
        return Err(DecisionDocumentError::validation(
            "Unsupported decision document target_kind",
        ));
    }
    if !matches!(
        frontmatter.request_source.as_str(),
        "ai_tool" | "ui_command"
    ) {
        return Err(DecisionDocumentError::validation(
            "Unsupported decision document request_source",
        ));
    }
    if !matches!(
        frontmatter.status.as_str(),
        "pending"
            | "applied"
            | "partially_applied"
            | "needs_revision"
            | "apply_failed"
            | "superseded"
    ) {
        return Err(DecisionDocumentError::validation(
            "Unsupported decision document status",
        ));
    }
    validate_timestamp(&frontmatter.created_at, "created_at")?;
    validate_timestamp(&frontmatter.updated_at, "updated_at")?;
    validate_source_refs(&frontmatter.source_refs)?;
    Ok(())
}

fn validate_memory_proposal(block: &MemoryProposalBlock) -> Result<(), DecisionDocumentError> {
    validate_prefixed_id(&block.id, "change", "memory proposal id")?;
    if block.operation != "create_memory" {
        return Err(DecisionDocumentError::validation(format!(
            "Unsupported memory proposal operation: {}",
            block.operation
        )));
    }
    validate_prefixed_id(&block.memory.id, "mem", "proposed memory id")?;
    validate_non_empty_limited(&block.memory.title, "memory title", MAX_TITLE_CHARS)?;
    validate_non_empty_limited(&block.memory.body, "memory body", usize::MAX)?;
    if let Some(kind) = block.memory.kind.as_deref() {
        validate_non_empty_limited(kind, "memory kind", MAX_KIND_CHARS)?;
    }
    for tag in &block.memory.tags {
        validate_non_empty_limited(tag, "memory tag", MAX_TAG_CHARS)?;
    }
    validate_source_refs(&block.memory.source_refs)?;
    Ok(())
}

fn validate_wiki_proposal(block: &WikiProposalBlock) -> Result<(), DecisionDocumentError> {
    validate_prefixed_id(&block.id, "change", "wiki proposal id")?;
    match block.operation.as_str() {
        "create_wiki_page" => {
            if block.page.expected_checksum.is_some() {
                return Err(DecisionDocumentError::validation(
                    "Wiki create proposal must not include expected_checksum",
                ));
            }
        }
        "update_wiki_page" => {
            let Some(checksum) = block.page.expected_checksum.as_deref() else {
                return Err(DecisionDocumentError::validation(
                    "Wiki update proposal requires expected_checksum",
                ));
            };
            validate_sha256_checksum(checksum, "wiki expected_checksum")
                .map_err(|error| DecisionDocumentError::validation(error.message))?;
        }
        _ => {
            return Err(DecisionDocumentError::validation(format!(
                "Unsupported wiki proposal operation: {}",
                block.operation
            )));
        }
    }

    normalize_wiki_proposal_path(&block.page.path)?;
    if !matches!(
        block.page.page_type.as_str(),
        "source" | "concept" | "entity" | "synthesis"
    ) {
        return Err(DecisionDocumentError::validation(format!(
            "Unsupported wiki page_type: {}",
            block.page.page_type
        )));
    }
    validate_non_empty_limited(&block.page.title, "wiki title", MAX_TITLE_CHARS)?;
    validate_non_empty_limited(&block.page.body, "wiki body", usize::MAX)?;
    for tag in &block.page.tags {
        validate_non_empty_limited(tag, "wiki tag", MAX_TAG_CHARS)?;
    }
    validate_source_refs(&block.page.source_refs)?;
    Ok(())
}

fn validate_decision(
    block: &DecisionBlock,
    document_proposal_id: &str,
) -> Result<(), DecisionDocumentError> {
    validate_prefixed_id(&block.id, "decision", "decision id")?;
    validate_prefixed_id(&block.proposal_id, "prop", "decision proposal_id")?;
    if block.proposal_id != document_proposal_id {
        return Err(DecisionDocumentError::validation(
            "Decision proposal_id does not match document proposal_id",
        ));
    }
    validate_prefixed_id(
        &block.target_change_id,
        "change",
        "decision target_change_id",
    )?;
    validate_non_empty_limited(&block.question, "decision question", MAX_TITLE_CHARS)?;
    if block.selection_mode != "single" {
        return Err(DecisionDocumentError::validation(
            "Unsupported decision selection_mode",
        ));
    }
    if !block.required {
        return Err(DecisionDocumentError::validation(
            "MVP decisions must be required",
        ));
    }
    if !matches!(
        block.status.as_str(),
        "pending" | "committed" | "rejected" | "needs_revision"
    ) {
        return Err(DecisionDocumentError::validation(
            "Unsupported decision status",
        ));
    }
    validate_decision_options(block)?;
    if let Some(selected) = block.selected_option_id.as_deref() {
        if !block.options.iter().any(|option| option.id == selected) {
            return Err(DecisionDocumentError::validation(format!(
                "Unknown selected option id: {selected}"
            )));
        }
        if !matches!(selected, "yes" | "no" | "other") {
            return Err(DecisionDocumentError::validation(format!(
                "Unsupported selected option id: {selected}"
            )));
        }
    }
    if let Some(resolved_at) = block.resolved_at.as_deref() {
        validate_timestamp(resolved_at, "resolved_at")?;
    }
    Ok(())
}

fn validate_decision_options(block: &DecisionBlock) -> Result<(), DecisionDocumentError> {
    let mut option_ids = BTreeSet::new();
    for option in &block.options {
        validate_non_empty_limited(&option.id, "decision option id", MAX_ID_CHARS)?;
        validate_non_empty_limited(&option.label, "decision option label", MAX_TITLE_CHARS)?;
        if !option_ids.insert(option.id.as_str()) {
            return Err(DecisionDocumentError::validation(format!(
                "Duplicate decision option id: {}",
                option.id
            )));
        }
    }
    for required in ["yes", "no", "other"] {
        if !option_ids.contains(required) {
            return Err(DecisionDocumentError::validation(format!(
                "Decision is missing required option: {required}"
            )));
        }
    }
    let Some(other) = block.options.iter().find(|option| option.id == "other") else {
        return Err(DecisionDocumentError::validation(
            "Decision is missing other option",
        ));
    };
    if other.requires_input != Some(true) {
        return Err(DecisionDocumentError::validation(
            "Decision other option must require input",
        ));
    }
    Ok(())
}

fn validate_source_refs(source_refs: &[SourceRef]) -> Result<(), DecisionDocumentError> {
    for source_ref in source_refs {
        validate_safe_vault_relative_path(&source_ref.path, "source_refs.path")
            .map_err(|error| DecisionDocumentError::validation(error.message))?;
        if let Some(title) = source_ref.title.as_deref() {
            validate_non_empty_limited(title, "source_refs.title", MAX_TITLE_CHARS)?;
        }
        if let Some(section_path) = source_ref.section_path.as_ref() {
            for section in section_path {
                validate_non_empty_limited(section, "source_refs.section_path", MAX_TITLE_CHARS)?;
            }
        }
        validate_source_range(source_ref.range.as_ref())?;
        if let Some(checksum) = source_ref.checksum.as_deref() {
            validate_sha256_checksum(checksum, "source_refs.checksum")
                .map_err(|error| DecisionDocumentError::validation(error.message))?;
        }
        validate_timestamp(&source_ref.captured_at, "source_refs.captured_at")?;
    }
    Ok(())
}

fn validate_source_range(range: Option<&SourceRange>) -> Result<(), DecisionDocumentError> {
    let Some(range) = range else {
        return Ok(());
    };
    if range.start_line == 0 || range.end_line == 0 || range.start_line > range.end_line {
        return Err(DecisionDocumentError::validation(
            "Invalid source reference range",
        ));
    }
    Ok(())
}

fn validate_prefixed_id(
    value: &str,
    prefix: &str,
    field: &str,
) -> Result<(), DecisionDocumentError> {
    if value.chars().count() > MAX_ID_CHARS
        || !value.starts_with(&format!("{prefix}_"))
        || !is_valid_knowledge_id(value)
    {
        return Err(DecisionDocumentError::validation(format!(
            "Invalid {field}"
        )));
    }
    Ok(())
}

fn validate_non_empty_limited(
    value: &str,
    field: &str,
    max_chars: usize,
) -> Result<(), DecisionDocumentError> {
    if value.trim().is_empty() {
        return Err(DecisionDocumentError::validation(format!(
            "{field} is empty"
        )));
    }
    if value.chars().count() > max_chars {
        return Err(DecisionDocumentError::validation(format!(
            "{field} is too long"
        )));
    }
    Ok(())
}

fn validate_timestamp(value: &str, field: &str) -> Result<(), DecisionDocumentError> {
    chrono::DateTime::parse_from_rfc3339(value).map_err(|_| {
        DecisionDocumentError::validation(format!("{field} must be a valid RFC 3339 timestamp"))
    })?;
    if !value.ends_with('Z') || value.contains('.') {
        return Err(DecisionDocumentError::validation(format!(
            "{field} must be UTC seconds precision"
        )));
    }
    Ok(())
}

fn normalize_wiki_proposal_path(path: &str) -> Result<String, DecisionDocumentError> {
    validate_wiki_page_path(path, "wiki page path")
        .map_err(|error| DecisionDocumentError::validation(error.message))
}

fn memory_path_for_id(memory_id: &str) -> String {
    format!("Knowledge/memory/{memory_id}.md")
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn parses_and_validates_decision_document() {
        let parsed = parse_decision_document(fixture_document()).unwrap();
        let integrity = validate_decision_document_integrity(&parsed, None).unwrap();

        assert_eq!(parsed.frontmatter.id, "doc_auth");
        assert_eq!(parsed.frontmatter.raw["extra_frontmatter"], "preserved");
        assert_eq!(parsed.proposal_blocks().count(), 1);
        assert_eq!(parsed.decision_blocks().count(), 1);
        assert_eq!(
            integrity.yes_memory_paths,
            vec!["Knowledge/memory/mem_auth.md"]
        );
    }

    #[test]
    fn parses_and_validates_wiki_decision_document() {
        let parsed = parse_decision_document(fixture_wiki_document()).unwrap();
        let integrity = validate_decision_document_integrity(&parsed, None).unwrap();

        assert_eq!(parsed.frontmatter.target_kind, "wiki");
        assert_eq!(parsed.proposal_blocks().count(), 0);
        assert_eq!(parsed.wiki_proposal_blocks().count(), 1);
        assert_eq!(parsed.decision_blocks().count(), 1);
        assert_eq!(
            integrity.yes_wiki_paths,
            vec!["Knowledge/wiki/concepts/session-cookie-auth.md"]
        );

        let canonical = canonicalize_kuku_blocks(&parsed).unwrap();
        assert!(canonical.contains("```kuku-wiki-proposal\n"));
    }

    #[test]
    fn canonicalizes_kuku_blocks_and_preserves_other_markdown_byte_for_byte() {
        let markdown = fixture_document().replace(
            "source_refs: []\n```",
            "source_refs: []\nunknown_field: dropped\n```\n\n```mermaid\ngraph TD\n  A-->B\n```\n\nRegular notes.\n",
        );
        let parsed = parse_decision_document(&markdown).unwrap();

        let canonical = canonicalize_kuku_blocks(&parsed).unwrap();

        assert!(canonical.contains("```mermaid\ngraph TD\n  A-->B\n```"));
        assert!(canonical.contains("\nRegular notes.\n"));
        assert!(!canonical.contains("unknown_field: dropped"));
    }

    #[test]
    fn scanner_records_opening_payload_and_closing_spans() {
        let parsed = parse_decision_document(fixture_document()).unwrap();
        let block = match &parsed.blocks[0] {
            ParsedKukuBlock::MemoryProposal(block) => block,
            ParsedKukuBlock::WikiProposal(_) => panic!("expected memory proposal block"),
            ParsedKukuBlock::Decision(_) => panic!("expected proposal block"),
        };
        let span = block.span.as_ref().unwrap();

        assert!(parsed.markdown[span.opening_fence.as_range()].starts_with("```kuku-memory"));
        assert!(parsed.markdown[span.payload.as_range()].contains("operation: create_memory"));
        assert!(parsed.markdown[span.closing_fence.as_range()].starts_with("```"));
    }

    #[test]
    fn missing_block_span_fails_validation_and_canonicalization() {
        let mut parsed = parse_decision_document(fixture_document()).unwrap();
        match &mut parsed.blocks[0] {
            ParsedKukuBlock::MemoryProposal(block) => block.span = None,
            ParsedKukuBlock::WikiProposal(block) => block.span = None,
            ParsedKukuBlock::Decision(block) => block.span = None,
        }

        let error = validate_decision_document_integrity(&parsed, None).unwrap_err();
        assert_eq!(error.code, KnowledgeErrorCode::ValidationFailed);
        assert!(canonicalize_kuku_blocks(&parsed).is_err());
    }

    #[test]
    fn duplicate_and_missing_mappings_fail_validation() {
        let duplicate = fixture_document().to_string()
            + "\n```kuku-decision\nid: decision_auth_2\nproposal_id: prop_auth\ntarget_change_id: change_auth\nquestion: Remember this memory?\nselection_mode: single\nrequired: true\nstatus: pending\nselected_option_id: no\noptions:\n- id: yes\n  label: Yes\n- id: no\n  label: No\n- id: other\n  label: Other\n  requires_input: true\n```\n";
        let parsed = parse_decision_document(&duplicate).unwrap();
        assert!(validate_decision_document_integrity(&parsed, None).is_err());

        let missing = fixture_document().replace(
            "target_change_id: change_auth",
            "target_change_id: change_missing",
        );
        let parsed = parse_decision_document(&missing).unwrap();
        assert!(validate_decision_document_integrity(&parsed, None).is_err());
    }

    #[test]
    fn unsupported_operation_and_required_false_fail_validation() {
        let unsupported = fixture_document().replace("operation: create_memory", "operation: edit");
        let parsed = parse_decision_document(&unsupported).unwrap();
        assert!(validate_decision_document_integrity(&parsed, None).is_err());

        let required_false = fixture_document().replace("required: true", "required: false");
        let parsed = parse_decision_document(&required_false).unwrap();
        assert!(validate_decision_document_integrity(&parsed, None).is_err());
    }

    #[test]
    fn unknown_selected_option_and_existing_yes_output_fail_validation() {
        let unknown =
            fixture_document().replace("selected_option_id: yes", "selected_option_id: maybe");
        let parsed = parse_decision_document(&unknown).unwrap();
        assert!(validate_decision_document_integrity(&parsed, None).is_err());

        let root = temp_vault();
        fs::create_dir_all(root.join("Knowledge/memory")).unwrap();
        fs::write(root.join("Knowledge/memory/mem_auth.md"), "existing").unwrap();
        let parsed = parse_decision_document(fixture_document()).unwrap();
        assert!(validate_decision_document_integrity(&parsed, Some(&root)).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn malformed_or_unclosed_kuku_block_fails_parse() {
        let malformed = fixture_document().replace("memory:\n", "memory: [\n");
        assert!(parse_decision_document(&malformed).is_err());

        let unclosed = fixture_document().replace("```\n\n## Decisions", "\n\n## Decisions");
        assert!(parse_decision_document(&unclosed).is_err());
    }

    #[test]
    fn unsafe_wiki_path_and_update_without_checksum_fail_validation() {
        let unsafe_path = fixture_wiki_document().replace(
            "Knowledge/wiki/concepts/session-cookie-auth.md",
            "Knowledge/wiki/../memory/session-cookie-auth.md",
        );
        let parsed = parse_decision_document(&unsafe_path).unwrap();
        assert!(validate_decision_document_integrity(&parsed, None).is_err());

        let update_without_checksum = fixture_wiki_document()
            .replace("operation: create_wiki_page", "operation: update_wiki_page");
        let parsed = parse_decision_document(&update_without_checksum).unwrap();
        assert!(validate_decision_document_integrity(&parsed, None).is_err());
    }

    fn fixture_document() -> &'static str {
        concat!(
            "---\n",
            "id: doc_auth\n",
            "proposal_id: prop_auth\n",
            "target_kind: memory\n",
            "request_source: ui_command\n",
            "status: pending\n",
            "created_at: 2026-05-07T00:00:00Z\n",
            "updated_at: 2026-05-07T00:00:00Z\n",
            "source_refs: []\n",
            "extra_frontmatter: preserved\n",
            "---\n",
            "\n",
            "# Memory Proposal\n",
            "\n",
            "## Proposed Changes\n",
            "\n",
            "```kuku-memory-proposal\n",
            "id: change_auth\n",
            "operation: create_memory\n",
            "memory:\n",
            "  id: mem_auth\n",
            "  kind: decision\n",
            "  title: Auth decision\n",
            "  tags: []\n",
            "  body: |-\n",
            "    Use session cookie auth first.\n",
            "  source_refs: []\n",
            "```\n",
            "\n",
            "## Decisions\n",
            "\n",
            "```kuku-decision\n",
            "id: decision_auth\n",
            "proposal_id: prop_auth\n",
            "target_change_id: change_auth\n",
            "question: Remember this memory?\n",
            "selection_mode: single\n",
            "required: true\n",
            "status: pending\n",
            "selected_option_id: yes\n",
            "options:\n",
            "- id: yes\n",
            "  label: Yes\n",
            "- id: no\n",
            "  label: No\n",
            "- id: other\n",
            "  label: Other\n",
            "  requires_input: true\n",
            "```\n",
            "\n",
            "## Notes\n",
        )
    }

    fn fixture_wiki_document() -> &'static str {
        concat!(
            "---\n",
            "id: doc_wiki_auth\n",
            "proposal_id: prop_wiki_auth\n",
            "target_kind: wiki\n",
            "request_source: ai_tool\n",
            "status: pending\n",
            "created_at: 2026-05-07T00:00:00Z\n",
            "updated_at: 2026-05-07T00:00:00Z\n",
            "source_refs: []\n",
            "---\n",
            "\n",
            "# Wiki Proposal\n",
            "\n",
            "```kuku-wiki-proposal\n",
            "id: change_wiki_auth\n",
            "operation: create_wiki_page\n",
            "page:\n",
            "  path: Knowledge/wiki/concepts/session-cookie-auth.md\n",
            "  page_type: concept\n",
            "  title: Session cookie auth\n",
            "  tags:\n",
            "  - auth\n",
            "  body: |-\n",
            "    Use session cookie auth first.\n",
            "  source_refs: []\n",
            "```\n",
            "\n",
            "```kuku-decision\n",
            "id: decision_wiki_auth\n",
            "proposal_id: prop_wiki_auth\n",
            "target_change_id: change_wiki_auth\n",
            "question: Create this wiki page?\n",
            "selection_mode: single\n",
            "required: true\n",
            "status: pending\n",
            "selected_option_id: yes\n",
            "options:\n",
            "- id: yes\n",
            "  label: Yes\n",
            "- id: no\n",
            "  label: No\n",
            "- id: other\n",
            "  label: Other\n",
            "  requires_input: true\n",
            "```\n",
        )
    }

    fn temp_vault() -> PathBuf {
        let mut path = std::env::temp_dir();
        let unique = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        path.push(format!("kuku-knowledge-doc-test-{nanos}-{unique}"));
        fs::create_dir_all(&path).unwrap();
        path
    }
}
