# BRAIN.md — ScienceSwarm Second Brain

## Owner
Name: {researcher name}
Field: {e.g., Computational Biology}
Institution: {e.g., MIT CSAIL}
Active Projects: {comma-separated list}

## Wiki Conventions
- All pages use YAML frontmatter: date, type, para, tags
- PARA classification: projects / areas / resources / archives
- Paper naming: {first-author-lastname}-{year}-{first-3-words}.md (deterministic)
- Observation naming: YYYY-MM-DD-HHMM-{slug}.md
- Cross-links: [[wiki/path/page]] format (Obsidian-compatible)
- Citations: [^N]: source.pdf, p.X (mandatory for factual claims)
- Headings: H1 = page title, H2 = major sections, H3 = subsections. Never H4+.
- Tags: lowercase, hyphenated, in frontmatter tags array

## Research-Specific Categories
- wiki/entities/papers/    — one page per paper
- wiki/entities/people/    — researchers, collaborators
- wiki/entities/datasets/  — datasets used or created
- wiki/entities/tools/     — software, instruments, methods
- wiki/concepts/           — theoretical frameworks, phenomena
- wiki/experiments/        — experiment records with observations
- wiki/hypotheses/         — active hypotheses with evidence tracking
- wiki/protocols/          — standard operating procedures

## How to Classify (PARA)
- Projects: Active research with a deadline (grants, submissions, reviews)
- Areas: Ongoing responsibilities (lab management, teaching, mentoring)
- Resources: Papers, tools, techniques of interest but no current action
- Archives: Completed papers, past experiments, graduated students

## Preferences
serendipity_rate: 0.20    # probability of "Did You Know?" in chat (0.0-1.0)
paper_watch_budget: 50    # monthly $ budget for auto-ingestion
ripple_cap: 15            # max pages updated per ingest

## Active Context
{LLM updates this section with current focus, recent ingests, open questions.}

## Custom Instructions
{Researcher-specific preferences go here. Examples:}
{- "Always compare new papers to Smith 2024"}
{- "Use APA citation format"}
{- "Focus on CRISPR off-target effects"}
