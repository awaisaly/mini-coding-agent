import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import yaml from "js-yaml";

function parseSkillMarkdown(markdown) {
  const trimmed = markdown.replace(/^\uFEFF/, "");
  const m = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n/.exec(trimmed);
  if (!m) return { frontmatter: null, body: trimmed };

  const fmRaw = m[1];
  const body = trimmed.slice(m[0].length);
  let frontmatter = null;
  try {
    frontmatter = yaml.load(fmRaw) ?? null;
  } catch {
    frontmatter = null;
  }
  return { frontmatter, body };
}

function inferTitle(body) {
  // First H1, else first non-empty line.
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    const m = /^#\s+(.+?)\s*$/.exec(line);
    if (m) return m[1];
  }
  for (const line of lines) {
    const t = line.trim();
    if (t) return t.slice(0, 80);
  }
  return "Untitled Skill";
}

function normalizeName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/--+/g, "-")
    .replace(/^-|-$/g, "");
}

function parseAllowedTools(frontmatter) {
  if (!frontmatter || typeof frontmatter !== "object") return [];
  const raw = frontmatter["allowed-tools"] ?? frontmatter.allowedTools ?? frontmatter.allowed_tools;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((x) => String(x).trim()).filter(Boolean);
  return String(raw)
    .split(/\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

export async function discoverSkills(skillsDirAbs) {
  const exists = await fs
    .stat(skillsDirAbs)
    .then(() => true)
    .catch(() => false);

  if (!exists) return [];

  const matches = await fg(["**/SKILL.md"], {
    cwd: skillsDirAbs,
    onlyFiles: true,
    unique: true,
    dot: true,
    ignore: ["**/.git/**", "**/.cache/**"],
  });

  const skills = [];
  for (const rel of matches) {
    const skillPath = path.join(skillsDirAbs, rel);
    const dir = path.dirname(skillPath);
    const raw = await fs.readFile(skillPath, "utf8");
    const { frontmatter, body } = parseSkillMarkdown(raw);

    const folderName = path.basename(dir);
    const fmName =
      frontmatter?.name != null ? String(frontmatter.name).trim() : "";
    const name = fmName || normalizeName(folderName);
    const description =
      (frontmatter?.description && String(frontmatter.description).trim()) || "";
    const title = inferTitle(body);
    const allowedTools = parseAllowedTools(frontmatter);

    skills.push({
      name,
      title,
      description,
      allowedTools,
      dir,
      skillPath,
      markdown: raw,
      frontmatter: frontmatter && typeof frontmatter === "object" ? frontmatter : null,
    });
  }

  // Stable order for deterministic routing.
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

