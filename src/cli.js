#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import fs from "node:fs/promises";

import { discoverSkills } from "./skills.js";
import { syncExternalSkills } from "./external-skills.js";
import { pickSkillsForPrompt, rankSkillsForPrompt } from "./skill-match.js";
import { runAgentOnce } from "./agent.js";

async function loadDotEnvIfPresent(cwd) {
  const envPath = path.join(cwd, ".env");
  let raw = "";
  try {
    raw = await fs.readFile(envPath, "utf8");
  } catch {
    return;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const noExport = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const eq = noExport.indexOf("=");
    if (eq === -1) continue;
    const key = noExport.slice(0, eq).trim();
    if (!key) continue;
    let value = noExport.slice(eq + 1).trim();

    // Remove surrounding quotes.
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function getEnv(name) {
  const v = process.env[name];
  return v && String(v).trim() ? String(v).trim() : "";
}

function makeLogger({ quiet }) {
  const start = Date.now();
  const since = () => `${((Date.now() - start) / 1000).toFixed(1)}s`;

  function log(level, msg) {
    if (quiet) return;
    const prefix = `[mini-agent] ${since()} ${level}`;
    console.error(`${prefix} ${msg}`);
  }

  return {
    info: (m) => log("INFO", m),
    warn: (m) => log("WARN", m),
    error: (m) => log("ERROR", m),
    trace: (e) => {
      if (quiet) return;
      // Compact trace events for CLI visibility.
      switch (e?.type) {
        case "router:start":
          log("INFO", `router: calling Claude (candidates=${(e.candidates || []).length})`);
          break;
        case "router:decision":
          log(
            "INFO",
            `router: selected=${(e.selected || []).join(", ") || "none"}${e.reason ? ` (${e.reason})` : ""}`
          );
          break;
        case "anthropic:request":
          log(
            "INFO",
            `anthropic: request purpose=${e.purpose} model=${e.model} tools=${e.tools} messages=${e.messages}`
          );
          break;
        case "anthropic:response": {
          const inTok = e.usage?.input_tokens ?? e.usage?.inputTokens;
          const outTok = e.usage?.output_tokens ?? e.usage?.outputTokens;
          log(
            "INFO",
            `anthropic: response purpose=${e.purpose} stop=${e.stop_reason || "?"}${
              inTok != null || outTok != null ? ` tokens_in=${inTok ?? "?"} tokens_out=${outTok ?? "?"}` : ""
            }`
          );
          break;
        }
        case "agent:step_start":
          log("INFO", `agent: step ${e.step + 1}/${e.maxSteps + 1} (thinking...)`);
          break;
        case "agent:step_response":
          log("INFO", `agent: step ${e.step + 1} tool_uses=${e.tool_uses}`);
          break;
        case "tool:use":
          log("INFO", `tool: ${e.name} (running)`);
          break;
        case "tool:result":
          log("INFO", `tool: ${e.name} (${e.ok ? "ok" : "error"})`);
          break;
        case "match:none":
          log("INFO", "match: no relevant skills");
          break;
        case "match:heuristic":
          log("INFO", `match: heuristic → ${e.selected || "none"}`);
          break;
        case "match:router":
          log("INFO", `match: router → ${(e.selected || []).join(", ") || "none"}`);
          break;
        default:
          // ignore
          break;
      }
    },
  };
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
  quiet,
}) {
  const logger = makeLogger({ quiet });
  const apiKey = getEnv("ANTHROPIC_API_KEY");

  if (syncExternal) {
    logger.info("sync: external skills (starting)");
    try {
      const res = await syncExternalSkills(externalSkillsDir);
      const repos = res?.syncedRepos?.length || 0;
      const skills = (res?.syncedRepos || []).reduce(
        (acc, r) => acc + (Array.isArray(r.materializedSkills) ? r.materializedSkills.length : 0),
        0
      );
      logger.info(`sync: external skills (done) repos=${repos} skills=${skills}`);
    } catch (err) {
      logger.warn(`sync: external skills failed (${String(err?.message || err)})`);
    }
  }

  logger.info("discover: scanning skills");
  const localSkills = await discoverSkills(skillsDir);
  const externalSkills = await discoverSkills(externalSkillsDir);
  const discovered = mergeSkillsPreferLocal(localSkills, externalSkills);
  logger.info(
    `discover: local=${localSkills.length} external=${externalSkills.length} total=${discovered.length}`
  );

  // Always compute and (optionally) show heuristic routing steps.
  const ranking = rankSkillsForPrompt({ prompt, skills: discovered });

  const match = await pickSkillsForPrompt({
    prompt,
    skills: discovered,
    apiKey: apiKey || undefined,
    model,
    trace: logger.trace,
  });

  // Always show a short summary so the CLI never looks "stuck".
  if (!quiet) {
    logger.info(
      `selected skill(s): ${match.selectedSkills.map((s) => s.name).join(", ") || "none"} (method=${
        match.matchMethod || "unknown"
      })`
    );
  }

  if (verbose && !quiet) {
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
    logger.warn("ANTHROPIC_API_KEY not set. Routing complete; set the key to run Claude.");
    return;
  }

  logger.info("agent: starting Claude run");
  const answer = await runAgentOnce({
    apiKey,
    model,
    prompt,
    selectedSkills: match.selectedSkills,
    maxSteps,
    enableTools,
    trace: logger.trace,
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
  // Allow local `.env` usage during development (without extra deps).
  // Only sets variables that aren't already present in the environment.
  await loadDotEnvIfPresent(process.cwd());

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
      "claude-sonnet-4-5-20250929"
    )
    .option("--max-steps <n>", "Max tool steps", "8")
    .option("--no-tools", "Disable tool use loop (LLM text only)")
    .option("--repl", "Start interactive REPL")
    .option("--quiet", "Hide step-by-step logs (answer only)", false)
    .option("-v, --verbose", "Print routing decisions to stderr", false);

  program.parse(process.argv);
  const args = program.args;
  const opts = program.opts();

  const skillsDir = path.resolve(process.cwd(), opts.skillsDir);
  const externalSkillsDir = path.resolve(process.cwd(), opts.externalSkillsDir);
  const maxSteps = Math.max(0, Number.parseInt(opts.maxSteps, 10) || 0);
  const verbose = Boolean(opts.verbose);
  const enableTools = Boolean(opts.tools);
  const quiet = Boolean(opts.quiet);
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
      quiet,
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
          quiet,
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
      quiet,
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
    quiet,
  });
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exitCode = 1;
});

