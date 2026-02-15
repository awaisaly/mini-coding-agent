#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";

import { discoverSkills } from "./skills.js";
import { syncExternalSkills } from "./external-skills.js";
import { pickSkillsForPrompt, rankSkillsForPrompt } from "./skill-match.js";
import { runAgentOnce } from "./agent.js";

function getEnv(name) {
  const v = process.env[name];
  return v && String(v).trim() ? String(v).trim() : "";
}

function printRouting({ prompt, localSkills, externalSkills, topCandidates, selectedSkills, matchMethod }) {
  const fmtScore = (n) => (Math.round(n * 100) / 100).toFixed(2);
  console.error(`[mini-agent] prompt: ${prompt}`);
  console.error(
    `[mini-agent] discovered skills: local=${localSkills.length}, external=${externalSkills.length}, total=${
      localSkills.length + externalSkills.length
    }`
  );

  if (topCandidates.length) {
    console.error("[mini-agent] top candidates:");
    for (const c of topCandidates) {
      console.error(`  - ${c.skill.name} (${fmtScore(c.score)}) — ${c.skill.description || c.skill.title}`);
    }
  } else {
    console.error("[mini-agent] top candidates: (none)");
  }

  console.error(
    `[mini-agent] selected skills (${matchMethod || "unknown"}): ${
      selectedSkills.map((s) => s.name).join(", ") || "none"
    }`
  );
}

async function runOnePrompt({
  prompt,
  skillsDir,
  externalSkillsDir,
  syncExternal,
  model,
  maxSteps,
  verbose,
  enableTools,
}) {
  const apiKey = getEnv("ANTHROPIC_API_KEY");

  if (syncExternal) {
    try {
      await syncExternalSkills(externalSkillsDir);
    } catch (err) {
      if (verbose) {
        console.error(
          `[mini-agent] external skills sync failed: ${String(
            err?.message || err
          )}`
        );
      }
    }
  }

  const localSkills = await discoverSkills(skillsDir);
  const externalSkills = await discoverSkills(externalSkillsDir);
  const discovered = mergeSkillsPreferLocal(localSkills, externalSkills);

  // Always compute and (optionally) show heuristic routing steps.
  const ranking = rankSkillsForPrompt({ prompt, skills: discovered });

  const match = await pickSkillsForPrompt({
    prompt,
    skills: discovered,
    apiKey: apiKey || undefined,
    model,
  });

  if (verbose || !apiKey) {
    printRouting({
      prompt,
      localSkills,
      externalSkills,
      topCandidates: ranking.topCandidates,
      selectedSkills: match.selectedSkills,
      matchMethod: match.matchMethod,
    });
  }

  // If we don't have an API key, stop after routing (useful for dev testing).
  if (!apiKey) {
    console.error(
      `[mini-agent] ANTHROPIC_API_KEY not set. Routing complete; set the key to run Claude.`
    );
    return;
  }

  const answer = await runAgentOnce({
    apiKey,
    model,
    prompt,
    selectedSkills: match.selectedSkills,
    maxSteps,
    enableTools,
  });

  process.stdout.write(answer.trimEnd() + "\n");
}

function mergeSkillsPreferLocal(localSkills, externalSkills) {
  const map = new Map();
  for (const s of externalSkills || []) map.set(s.name, s);
  for (const s of localSkills || []) map.set(s.name, s);
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function runRepl(opts) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (q) =>
    new Promise((resolve) => {
      rl.question(q, resolve);
    });

  while (true) {
    const prompt = (await ask("> ")).trim();
    if (!prompt) continue;
    if (prompt === "exit" || prompt === "quit") break;
    await runOnePrompt({ ...opts, prompt });
  }

  rl.close();
}

async function main() {
  const program = new Command();
  program
    .name("mini-agent")
    .description(
      "Mini coding agent CLI that loads Agent Skills from .skills/ and runs Claude Sonnet."
    )
    .argument("[prompt...]", "Prompt to send to the agent")
    .option(
      "--skills-dir <path>",
      "Skills directory (contains skill folders with SKILL.md)",
      ".skills"
    )
    .option(
      "--external-skills-dir <path>",
      "External skills directory (auto-synced skill folders with SKILL.md)",
      ".externalSkills"
    )
    .option(
      "--no-sync-external",
      "Disable syncing external skills repos on startup"
    )
    .option(
      "--model <name>",
      "Claude model name",
      "claude-3-5-sonnet-latest"
    )
    .option("--max-steps <n>", "Max tool steps", "8")
    .option("--no-tools", "Disable tool use loop (LLM text only)")
    .option("--repl", "Start interactive REPL")
    .option("-v, --verbose", "Print routing decisions to stderr", false);

  program.parse(process.argv);
  const args = program.args;
  const opts = program.opts();

  const skillsDir = path.resolve(process.cwd(), opts.skillsDir);
  const externalSkillsDir = path.resolve(process.cwd(), opts.externalSkillsDir);
  const maxSteps = Math.max(0, Number.parseInt(opts.maxSteps, 10) || 0);
  const verbose = Boolean(opts.verbose);
  const enableTools = Boolean(opts.tools);
  const model = String(opts.model);
  const syncExternal = Boolean(opts.syncExternal);

  if (opts.repl) {
    await runRepl({
      skillsDir,
      externalSkillsDir,
      syncExternal,
      model,
      maxSteps,
      verbose,
      enableTools,
    });
    return;
  }

  const prompt = args.join(" ").trim();
  if (!prompt) {
    // If no prompt is provided, default to interactive mode.
    // Also supports piping prompts via stdin:
    //   echo "generate a changelog" | mini-agent
    if (!process.stdin.isTTY) {
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const piped = Buffer.concat(chunks).toString("utf8").trim();
      if (piped) {
        await runOnePrompt({
          prompt: piped,
          skillsDir,
          externalSkillsDir,
          syncExternal,
          model,
          maxSteps,
          verbose,
          enableTools,
        });
        return;
      }
    }

    await runRepl({
      skillsDir,
      externalSkillsDir,
      syncExternal,
      model,
      maxSteps,
      verbose,
      enableTools,
    });
    return;
  }

  await runOnePrompt({
    prompt,
    skillsDir,
    externalSkillsDir,
    syncExternal,
    model,
    maxSteps,
    verbose,
    enableTools,
  });
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exitCode = 1;
});

