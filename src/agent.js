import process from "node:process";

import { createClaudeMessage } from "./anthropic.js";
import { buildToolRuntime } from "./tools.js";

function buildSystemPrompt(selectedSkills) {
  const base =
    "You are a helpful mini coding agent running as a Node.js CLI.\n" +
    "If you have relevant Skills below, follow them.\n" +
    "When using tools, be careful: keep changes minimal, prefer small steps, and avoid destructive commands unless explicitly requested.\n";

  if (!selectedSkills?.length) return base;

  const skillsBlock = selectedSkills
    .map(
      (s) =>
        `\n\n---\nSKILL: ${s.name}\nTITLE: ${s.title}\nDESCRIPTION: ${s.description}\n\n${s.markdown}\n`
    )
    .join("");

  return base + "\nSelected skills:\n" + skillsBlock;
}

function extractText(contentBlocks) {
  return (contentBlocks || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

export async function runAgentOnce({
  apiKey,
  model,
  prompt,
  selectedSkills,
  maxSteps,
  enableTools,
}) {
  const system = buildSystemPrompt(selectedSkills);
  const messages = [{ role: "user", content: String(prompt) }];

  if (!enableTools) {
    const resp = await createClaudeMessage({
      apiKey,
      model,
      system,
      maxTokens: 1500,
      messages,
    });
    return extractText(resp.content);
  }

  const { tools, executeTool, restrictTools } = buildToolRuntime({
    rootDirAbs: process.cwd(),
  });
  const allowedFromSkills = (selectedSkills || [])
    .flatMap((s) => (Array.isArray(s.allowedTools) ? s.allowedTools : []))
    .filter(Boolean);
  const toolsForRun = restrictTools(allowedFromSkills);

  for (let step = 0; step <= maxSteps; step++) {
    const resp = await createClaudeMessage({
      apiKey,
      model,
      system,
      maxTokens: 1500,
      messages,
      tools: toolsForRun,
    });

    messages.push({ role: "assistant", content: resp.content });

    const toolUses = (resp.content || []).filter((b) => b.type === "tool_use");
    if (toolUses.length === 0) {
      return extractText(resp.content);
    }

    if (step === maxSteps) {
      const text = extractText(resp.content);
      return (
        (text ? text + "\n\n" : "") +
        `[mini-agent] stopped after ${maxSteps} tool steps (increase --max-steps if needed).`
      );
    }

    const results = [];
    for (const tu of toolUses) {
      try {
        const out = await executeTool(tu.name, tu.input || {});
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: String(out),
        });
      } catch (err) {
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          is_error: true,
          content: String(err?.message || err),
        });
      }
    }

    messages.push({ role: "user", content: results });
  }

  return "[mini-agent] unexpected: tool loop ended";
}

