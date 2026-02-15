# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0] - 2025-01-XX

Initial release of mini-coding-agent - a lightweight Node.js CLI that brings the Agent Skills concept to life.

### ✨ New Features

- **Agent Skills Discovery**: Automatically discovers and loads skills from `.skills/` directory by scanning for `SKILL.md` files with YAML frontmatter
- **Intelligent Skill Routing**: Matches user prompts to relevant skills using a two-stage approach:
  - Local heuristic filtering using token overlap on skill names, titles, and descriptions
  - Claude-powered routing to select the most appropriate skill (0-1) from candidates
- **Smart Context Loading**: Only loads full skill content for selected skills, keeping context lean and efficient
- **External Skills Auto-Sync**: Automatically syncs community skills from external repositories
  - Maintains sparse git checkouts in `.externalSkills/.cache/` for efficiency
  - Copies skills directly under `.externalSkills/<skill-name>/` for easy access
  - Configurable via `.externalSkills/sources.json`
- **Interactive CLI**: Run with prompts directly or enter interactive mode for ongoing conversations
- **Built-in Changelog Generator Skill**: Ships with an example skill that generates user-facing release notes from git commits

### 🔧 Improvements

- **Flexible Configuration Options**:
  - `--skills-dir` to use custom skill directories or point to community skill repos
  - `--model` to select different Claude models (defaults to Sonnet 4.5)
  - `--max-steps` to control tool-use iteration limits
  - `--no-tools` for text-only mode
  - `--verbose` for detailed skill scoring and candidate information
  - `--quiet` for minimal output (answer only)
  - `--no-sync-external` to disable external skills syncing
- **Multiple Installation Methods**: Use via npm scripts, direct execution, or global installation with `npm link`
- **Tool Integration**: Built-in tools for file operations (read, write, list, glob) and shell command execution
- **Powered by Claude Sonnet**: Leverages Anthropic's Claude API for intelligent agent behavior

### 📦 Technical Details

- Requires Node.js 18 or higher
- Dependencies: @anthropic-ai/sdk, commander, fast-glob, js-yaml
- Intentionally simple and readable codebase (not production-hardened)
- Modular architecture with separate components for skills, routing, tools, and external syncing

### 🚀 Getting Started

1. Install dependencies: `npm install`
2. Set your API key: `export ANTHROPIC_API_KEY="YOUR_KEY"`
3. Run: `npm start -- "your prompt here"`

Compatible with community skills like [langbaseinc/agent-skills](https://github.com/langbaseinc/agent-skills).

---

*Format: The format is based on [Keep a Changelog](https://keepachangelog.com/).*
