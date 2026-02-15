import fs from "node:fs/promises";
import path from "node:path";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import fg from "fast-glob";

const exec = promisify(execCb);

function ensureInsideRoot(rootAbs, targetPath) {
  const resolved = path.resolve(rootAbs, targetPath);
  const root = rootAbs.endsWith(path.sep) ? rootAbs : rootAbs + path.sep;
  if (resolved === rootAbs) return resolved;
  if (!resolved.startsWith(root)) {
    throw new Error(`Path escapes workspace root: ${targetPath}`);
  }
  return resolved;
}

function truncate(s, max = 200_000) {
  const str = String(s ?? "");
  if (str.length <= max) return str;
  return str.slice(0, max) + `\n\n[truncated to ${max} chars]\n`;
}

export function buildToolRuntime({ rootDirAbs }) {
  const tools = [
    {
      name: "read_file",
      description:
        "Read a UTF-8 text file from the current workspace. Use this to inspect existing code or documents. The path must be inside the workspace root.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path (relative or absolute)." },
        },
        required: ["path"],
      },
    },
    {
      name: "write_file",
      description:
        "Write a UTF-8 text file in the current workspace. Creates parent directories if needed. Refuses to write outside the workspace root.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path (relative or absolute)." },
          content: { type: "string", description: "Full file contents to write." },
          overwrite: {
            type: "boolean",
            description: "If false, error when file already exists. Default true.",
          },
        },
        required: ["path", "content"],
      },
    },
    {
      name: "list_dir",
      description:
        "List files and folders within a directory in the workspace root. Useful to understand project structure.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path." },
        },
        required: ["path"],
      },
    },
    {
      name: "glob",
      description:
        "Find files using a glob pattern within the workspace. Pattern is evaluated relative to `cwd` (default workspace root).",
      input_schema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern (e.g. **/*.js)." },
          cwd: { type: "string", description: "Working directory (optional)." },
          ignore: {
            type: "array",
            items: { type: "string" },
            description: "Ignore patterns (optional).",
          },
        },
        required: ["pattern"],
      },
    },
    {
      name: "run_shell",
      description:
        "Run a shell command (non-interactive) inside the workspace. Use for git commands, tests, or scaffolding. Default timeout is 30s (max 120s).",
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to run." },
          cwd: { type: "string", description: "Working directory (optional)." },
          timeout_ms: { type: "integer", description: "Timeout in milliseconds." },
        },
        required: ["command"],
      },
    },
  ];

  const toolByName = new Map(tools.map((t) => [t.name, t]));

  function normalizeAllowedToolName(name) {
    const n = String(name || "").trim();
    if (!n) return null;

    // Community skills sometimes refer to generic tools (e.g. Claude Code / Cursor).
    const alias = n.toLowerCase();
    if (alias === "read") return "read_file";
    if (alias === "write") return "write_file";
    if (alias === "edit") return "write_file";
    if (alias === "ls" || alias === "list") return "list_dir";
    if (alias === "glob" || alias === "search") return "glob";
    if (alias === "bash" || alias === "shell" || alias === "terminal") return "run_shell";

    // Otherwise assume the tool name matches ours.
    return n;
  }

  function restrictTools(allowedTools) {
    if (!Array.isArray(allowedTools) || allowedTools.length === 0) return tools;
    const mapped = allowedTools
      .map(normalizeAllowedToolName)
      .filter(Boolean)
      .map((x) => String(x));
    const uniq = [...new Set(mapped)];
    const available = uniq.map((n) => toolByName.get(n)).filter(Boolean);
    return available.length > 0 ? available : tools;
  }

  async function executeTool(name, input) {
    switch (name) {
      case "read_file": {
        const p = ensureInsideRoot(rootDirAbs, input.path);
        const data = await fs.readFile(p, "utf8");
        return truncate(data);
      }
      case "write_file": {
        const p = ensureInsideRoot(rootDirAbs, input.path);
        const overwrite = input.overwrite !== false;
        if (!overwrite) {
          const exists = await fs
            .stat(p)
            .then(() => true)
            .catch(() => false);
          if (exists) throw new Error(`File already exists: ${input.path}`);
        }
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.writeFile(p, String(input.content ?? ""), "utf8");
        return "ok";
      }
      case "list_dir": {
        const p = ensureInsideRoot(rootDirAbs, input.path);
        const entries = await fs.readdir(p, { withFileTypes: true });
        return entries
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort((a, b) => a.localeCompare(b))
          .join("\n");
      }
      case "glob": {
        const cwd = input.cwd ? ensureInsideRoot(rootDirAbs, input.cwd) : rootDirAbs;
        const matches = await fg([String(input.pattern)], {
          cwd,
          onlyFiles: true,
          dot: true,
          unique: true,
          ignore: Array.isArray(input.ignore) ? input.ignore : undefined,
        });
        return matches.join("\n");
      }
      case "run_shell": {
        const cwd = input.cwd ? ensureInsideRoot(rootDirAbs, input.cwd) : rootDirAbs;
        const timeoutMsRaw =
          typeof input.timeout_ms === "number" ? input.timeout_ms : 30_000;
        const timeout = Math.max(1000, Math.min(120_000, timeoutMsRaw));

        const { stdout, stderr } = await exec(String(input.command), {
          cwd,
          timeout,
          maxBuffer: 10 * 1024 * 1024,
          env: process.env,
        });
        return truncate(
          [
            stdout ? `STDOUT:\n${stdout}` : "",
            stderr ? `STDERR:\n${stderr}` : "",
          ]
            .filter(Boolean)
            .join("\n\n")
        );
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  return { tools, executeTool, restrictTools };
}

