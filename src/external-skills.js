import fs from "node:fs/promises";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import fg from "fast-glob";

const execFile = promisify(execFileCb);

async function pathExists(p) {
  return fs
    .stat(p)
    .then(() => true)
    .catch(() => false);
}

async function isDirectory(p) {
  return fs
    .stat(p)
    .then((s) => s.isDirectory())
    .catch(() => false);
}

function repoDirNameFromUrl(url) {
  const u = String(url || "").trim();
  const last = u.split("/").filter(Boolean).pop() || "repo";
  return last.replace(/\.git$/i, "");
}

async function runGit(args, { cwd }) {
  const { stdout, stderr } = await execFile("git", args, {
    cwd,
    env: process.env,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout, stderr };
}

export async function ensureExternalSkillsConfig(externalDirAbs) {
  await fs.mkdir(externalDirAbs, { recursive: true });
  const cfgPath = path.join(externalDirAbs, "sources.json");
  if (await pathExists(cfgPath)) return cfgPath;

  // One-time migration from older folder name "external skills/" if present.
  const legacyCfg = path.join(path.dirname(externalDirAbs), "external skills", "sources.json");
  if (await pathExists(legacyCfg)) {
    const raw = await fs.readFile(legacyCfg, "utf8");
    await fs.writeFile(cfgPath, raw.endsWith("\n") ? raw : raw + "\n", "utf8");
    return cfgPath;
  }

  const initial = {
    repos: [
      {
        url: "https://github.com/langbaseinc/agent-skills.git",
        // dir: "agent-skills",
        // branch: "main"
        // paths: ["skills"]
      },
    ],
  };
  await fs.writeFile(cfgPath, JSON.stringify(initial, null, 2) + "\n", "utf8");
  return cfgPath;
}

export async function loadExternalSkillsSources(externalDirAbs) {
  const cfgPath = await ensureExternalSkillsConfig(externalDirAbs);
  const raw = await fs.readFile(cfgPath, "utf8");
  const parsed = JSON.parse(raw);
  const repos = Array.isArray(parsed?.repos) ? parsed.repos : [];
  return {
    cfgPath,
    repos: repos
      .map((r) => ({
        url: String(r?.url || "").trim(),
        dir: r?.dir ? String(r.dir).trim() : "",
        branch: r?.branch ? String(r.branch).trim() : "",
        paths: Array.isArray(r?.paths)
          ? r.paths.map((p) => String(p).trim()).filter(Boolean)
          : [],
      }))
      .filter((r) => r.url),
  };
}

function safeDirName(s) {
  return String(s || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

async function readSyncState(externalDirAbs) {
  const p = path.join(externalDirAbs, ".sync-state.json");
  try {
    const raw = await fs.readFile(p, "utf8");
    const json = JSON.parse(raw);
    if (json && typeof json === "object") return { path: p, state: json };
  } catch {}
  return { path: p, state: { repos: {} } };
}

async function writeSyncState(statePath, state) {
  await fs.writeFile(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
}

async function ensureSparseRepo({ url, branch, cacheDirAbs, sparsePaths }) {
  const repoExists = await isDirectory(cacheDirAbs);
  if (!repoExists) {
    const args = ["clone", "--depth", "1", "--filter=blob:none", "--sparse"];
    if (branch) args.push("--branch", branch);
    args.push(url, cacheDirAbs);
    await runGit(args, { cwd: path.dirname(cacheDirAbs) });
  } else {
    // Best-effort fast-forward pull. Keep existing if it fails.
    try {
      await runGit(["-C", cacheDirAbs, "pull", "--ff-only"], {
        cwd: path.dirname(cacheDirAbs),
      });
    } catch {}
  }

  // Configure sparse checkout.
  const paths = sparsePaths?.length ? sparsePaths : ["skills"];
  try {
    await runGit(["-C", cacheDirAbs, "sparse-checkout", "init", "--cone"], {
      cwd: path.dirname(cacheDirAbs),
    });
  } catch {}

  try {
    await runGit(["-C", cacheDirAbs, "sparse-checkout", "set", ...paths], {
      cwd: path.dirname(cacheDirAbs),
    });
  } catch {
    // If sparse-checkout isn't available for some reason, fall back to full checkout.
    await runGit(["-C", cacheDirAbs, "checkout"], { cwd: path.dirname(cacheDirAbs) });
  }
}

async function materializeSkillsFromRepo({
  repoKey,
  cacheDirAbs,
  externalDirAbs,
  paths,
}) {
  const scanRoots = (paths?.length ? paths : ["skills"]).map((p) => p.replace(/\\/g, "/"));
  const patterns = scanRoots.map((root) => `${root.replace(/\/$/, "")}/**/SKILL.md`);
  const matches = await fg(patterns, {
    cwd: cacheDirAbs,
    onlyFiles: true,
    unique: true,
    dot: true,
    ignore: ["**/.git/**"],
  });

  const skillSourceDirs = matches.map((rel) => path.join(cacheDirAbs, path.dirname(rel)));

  // Map each skill folder name to a unique destination folder under .externalSkills/
  const destNames = new Map(); // sourceDirAbs -> destFolderName
  const used = new Set();
  for (const srcDir of skillSourceDirs) {
    const base = safeDirName(path.basename(srcDir)) || "skill";
    let name = base;
    if (used.has(name)) name = `${safeDirName(repoKey)}__${base}`;
    let i = 2;
    while (used.has(name)) {
      name = `${safeDirName(repoKey)}__${base}__${i++}`;
    }
    used.add(name);
    destNames.set(srcDir, name);
  }

  const stateInfo = await readSyncState(externalDirAbs);
  const prev = new Set(
    Array.isArray(stateInfo.state?.repos?.[repoKey]) ? stateInfo.state.repos[repoKey] : []
  );
  const next = new Set([...destNames.values()]);

  // Remove stale skill dirs from previous sync of this repo.
  for (const oldName of prev) {
    if (!next.has(oldName)) {
      const target = path.join(externalDirAbs, oldName);
      if (await isDirectory(target)) {
        // Never delete cache or dot directories.
        if (!oldName.startsWith(".") && oldName !== ".cache") {
          await fs.rm(target, { recursive: true, force: true });
        }
      }
    }
  }

  // Copy current skills into .externalSkills/<skillName>/
  for (const [srcDir, destName] of destNames.entries()) {
    const destDir = path.join(externalDirAbs, destName);
    await fs.rm(destDir, { recursive: true, force: true });
    await fs.cp(srcDir, destDir, { recursive: true });
  }

  stateInfo.state.repos = stateInfo.state.repos || {};
  stateInfo.state.repos[repoKey] = [...next.values()].sort();
  await writeSyncState(stateInfo.path, stateInfo.state);

  return { materializedSkills: [...next.values()] };
}

export async function syncExternalSkills(externalDirAbs) {
  const { repos } = await loadExternalSkillsSources(externalDirAbs);
  const syncedRepos = [];

  const cacheRoot = path.join(externalDirAbs, ".cache");
  await fs.mkdir(cacheRoot, { recursive: true });

  for (const r of repos) {
    const repoKey = r.dir || repoDirNameFromUrl(r.url);
    const cacheDir = path.join(cacheRoot, repoKey);

    await ensureSparseRepo({
      url: r.url,
      branch: r.branch,
      cacheDirAbs: cacheDir,
      sparsePaths: r.paths,
    });

    const mat = await materializeSkillsFromRepo({
      repoKey,
      cacheDirAbs: cacheDir,
      externalDirAbs,
      paths: r.paths,
    });

    syncedRepos.push({
      url: r.url,
      repo: repoKey,
      cacheDir,
      materializedSkills: mat.materializedSkills,
    });
  }

  return { syncedRepos };
}

