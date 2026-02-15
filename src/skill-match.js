import { createClaudeMessage } from "./anthropic.js";

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "be",
  "but",
  "can",
  "do",
  "for",
  "from",
  "generate",
  "get",
  "how",
  "i",
  "in",
  "is",
  "it",
  "make",
  "me",
  "my",
  "of",
  "on",
  "please",
  "the",
  "then",
  "to",
  "what",
  "with",
  "you",
]);

function tokenize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !STOPWORDS.has(t));
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function heuristicScore(prompt, skill) {
  const p = new Set(tokenize(prompt));
  const s = new Set(tokenize(`${skill.name} ${skill.title} ${skill.description}`));
  let score = jaccard(p, s);

  if (skill.name && String(prompt).toLowerCase().includes(skill.name)) score += 0.25;

  for (const t of p) {
    if (t.length >= 7 && s.has(t)) score += 0.05;
    if (skill.name && skill.name.toLowerCase().includes(t) && t.length >= 4) score += 0.1;
  }

  return Math.min(1, score);
}

function extractFirstJsonObject(text) {
  const s = String(text || "");
  const start = s.indexOf("{");
  if (start === -1) return null;
  // Naive brace matching (good enough for small router outputs).
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const raw = s.slice(start, i + 1);
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

async function routeWithClaude({ apiKey, model, prompt, candidates, trace }) {
  const system =
    "You are a router that selects relevant Agent Skills for a user prompt.\n" +
    "You will receive a user prompt and a list of candidate skills (name, title, description).\n" +
    "Return ONLY valid JSON with the shape:\n" +
    '{ "selected": string[], "reason": string }\n' +
    "Rules:\n" +
    "- Select 0 skills if none are relevant.\n" +
    "- Prefer selecting at most 1 skill unless the prompt clearly needs multiple.\n" +
    "- Only select from the provided candidates.\n";

  const user = {
    prompt,
    candidates: candidates.map((c) => ({
      name: c.name,
      title: c.title,
      description: c.description,
    })),
  };

  trace?.({
    type: "router:start",
    model,
    candidates: candidates.map((c) => c.name),
  });

  const resp = await createClaudeMessage({
    apiKey,
    model,
    system,
    maxTokens: 300,
    messages: [{ role: "user", content: JSON.stringify(user, null, 2) }],
    trace,
    purpose: "router",
  });

  const text = (resp.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const json = extractFirstJsonObject(text);
  if (!json || !Array.isArray(json.selected)) return null;

  const selected = json.selected.map((x) => String(x)).filter(Boolean);
  trace?.({
    type: "router:decision",
    selected,
    reason: String(json.reason || ""),
  });
  return { selected, reason: String(json.reason || "") };
}

export function rankSkillsForPrompt({ prompt, skills }) {
  const scored = (skills || [])
    .map((s) => ({ skill: s, score: heuristicScore(prompt, s) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0]?.score ?? 0;
  const topCandidates = scored
    .filter((x) => x.score >= Math.max(0.12, best * 0.6))
    .slice(0, 8);

  return { scored, best, topCandidates };
}

export async function pickSkillsForPrompt({ prompt, skills, apiKey, model, trace }) {
  if (!skills?.length) return { selectedSkills: [], routerDecision: null };

  const { best, topCandidates } = rankSkillsForPrompt({ prompt, skills });
  const candidateSkills = topCandidates.map((x) => x.skill);

  if (candidateSkills.length === 0 || best < 0.12) {
    trace?.({ type: "match:none" });
    return { selectedSkills: [], routerDecision: null, matchMethod: "none" };
  }

  if (!apiKey) {
    trace?.({
      type: "match:heuristic",
      selected: candidateSkills[0]?.name,
    });
    return {
      selectedSkills: [candidateSkills[0]],
      routerDecision: null,
      matchMethod: "heuristic",
    };
  }

  const routerDecision = await routeWithClaude({
    apiKey,
    model,
    prompt,
    candidates: candidateSkills,
    trace,
  });

  if (!routerDecision) {
    // Fallback: use the top heuristic match.
    trace?.({
      type: "match:heuristic",
      selected: candidateSkills[0]?.name,
    });
    return {
      selectedSkills: [candidateSkills[0]],
      routerDecision: null,
      matchMethod: "heuristic",
    };
  }

  const selectedSet = new Set(routerDecision.selected);
  const selectedSkills = candidateSkills.filter((s) => selectedSet.has(s.name));

  trace?.({
    type: "match:router",
    selected: selectedSkills.map((s) => s.name),
  });
  return { selectedSkills, routerDecision, matchMethod: "router" };
}

