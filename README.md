# mini-coding-agent

A tiny Node.js CLI that implements the **Agent Skills** concept:

- Discovers skills from a local `.skills/` directory (`.skills/**/SKILL.md`) and also supports community skills
- Matches your prompt to relevant skills (loads **only** those skills into context)
- Runs **Claude Sonnet** via Anthropic’s API

This is intentionally simple and readable (not production-hardended).

## Setup

1) Install dependencies:

```bash
npm install
```

2) Set your API key:

```bash
export ANTHROPIC_API_KEY="YOUR_KEY"
```

## Skills

Each skill is a folder with a `SKILL.md` file that includes YAML frontmatter:

```md
---
name: changelog-generator
description: Automatically creates user-facing changelogs from git commits.
---
```

This repo ships with one example at `.skills/changelog-generator/SKILL.md`.

To use community skills (like [`langbaseinc/agent-skills`](https://github.com/langbaseinc/agent-skills)):

- Copy any skill folder into your local `.skills/`
- Ensure it contains a `SKILL.md`

You can also point `--skills-dir` at a cloned skills repo root (it searches `**/SKILL.md`), for example:

```bash
mini-agent --skills-dir ../agent-skills "generate a changelog"
```

## External skills (auto-sync)

This CLI also supports an **auto-synced** folder named `.externalSkills/`.

- On every run, it reads `.externalSkills/sources.json`
- For each repo, it keeps a **sparse** git checkout in `.externalSkills/.cache/` (not a full repo clone in your skills folder)
- It then copies skill folders so they live directly under `.externalSkills/<skill-name>/SKILL.md`

Disable sync:

```bash
mini-agent --no-sync-external "your prompt"
```

## Usage

Run a single prompt:

```bash
npm start -- "generate a changelog"
```

Or run the installed CLI:

```bash
./src/cli.js "generate a changelog"
```

If you run `mini-agent` with no prompt, it starts an interactive prompt:

```bash
mini-agent
> generate a changelog
```

Install globally (optional, for the `mini-agent` command):

```bash
npm link
mini-agent "generate a changelog"
```

### Flags

- `--skills-dir <path>`: change skill directory (default: `.skills`)
- `--model <name>`: change model (default: `claude-sonnet-4-5-20250929`)
- `--max-steps <n>`: limit tool-use loop (default: `8`)
- `--no-tools`: disable tools (text-only)
- `--verbose`: show detailed skill scoring/candidates
- `--quiet`: hide step-by-step logs (answer only)

## How matching works (high level)

1) A local heuristic picks a small set of likely skills using token overlap on `name/title/description`.
2) Claude then routes among **only those summaries** (not full skill bodies) and picks 0–1 skills.
3) Only the selected skills’ full `SKILL.md` are loaded into the final run context.

