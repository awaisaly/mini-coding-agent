---
name: changelog-generator
description: Generate a user-facing changelog (release notes) by summarizing git commits into Features, Improvements, Fixes, and Breaking Changes. Use when asked to "generate a changelog" or "write release notes".
---

# Changelog Generator

## When to Use This Skill

- The user asks for a changelog, release notes, or “what changed”
- You need to turn technical commits into customer-friendly language

## Instructions

1. If you are in a git repo, inspect recent commits (or a requested range/tag).
2. Group changes into categories:
   - New Features
   - Improvements
   - Fixes
   - Breaking Changes (only if relevant)
3. Rewrite entries in plain language focused on user impact.
4. Output in clean Markdown suitable for `CHANGELOG.md` or GitHub Releases.

## Output Template

```md
# Release Notes

## ✨ New Features
- ...

## 🔧 Improvements
- ...

## 🐛 Fixes
- ...

## ⚠️ Breaking Changes
- ...
```

