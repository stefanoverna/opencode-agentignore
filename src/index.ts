/**
 * opencode-agentignore
 *
 * OpenCode plugin that blocks tool calls targeting files matched by
 * .agentignore / .claudeignore (gitignore syntax).
 *
 * Walks up from the target file's directory to find all ignore files,
 * merging patterns from co-located .agentignore + .claudeignore at each level.
 * Uses the battle-tested `ignore` npm package for pattern matching.
 * Also post-filters Grep responses to prevent content leaks from protected files.
 */

import { existsSync, readFileSync, statSync } from "node:fs"
import { resolve, relative, dirname, sep, isAbsolute, join } from "node:path"
import { realpathSync } from "node:fs"
import ignore from "ignore"
import type { Plugin } from "@opencode-ai/plugin"

// ── Constants ───────────────────────────────────────────────────────────────

/** Ignore files we look for at each directory level (checked in order). */
const IGNORE_FILENAMES = [".agentignore", ".claudeignore"]

/** Service name used in log messages. */
const SERVICE = "opencode-agentignore"

/** Tool names whose target paths we block pre-execution. */
const BLOCKED_TOOLS = new Set([
  "read",
  "edit",
  "write",
  "glob",
  "grep",
  "multiedit",
  "list",
])

// ── Helpers ─────────────────────────────────────────────────────────────────

function realpathSafe(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

function getFilePath(args: Record<string, unknown> | undefined): string | null {
  if (!args) return null
  const p = (args.filePath ?? args.file_path ?? args.path) as string | undefined
  return typeof p === "string" && p.trim() ? p : null
}

/**
 * Walk up from `start` to `/`, collecting every ignore file along the way.
 * Returns root-most first, leaf-most last.
 */
function findIgnoreFiles(start: string): string[] {
  const files: string[] = []
  let current = realpathSafe(start)
  while (true) {
    for (const name of IGNORE_FILENAMES) {
      const candidate = join(current, name)
      if (existsSync(candidate)) {
        files.push(candidate)
      }
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  files.reverse()
  return files
}

/**
 * Check whether `targetPath` should be blocked by any ignore file in the
 * hierarchy. Returns [ignoreFile, reason] if blocked, or null if allowed.
 *
 * Walks up from `targetPath`'s parent (or the path itself if it's a dir).
 * At each directory level, patterns from all co-located ignore files
 * (.agentignore + .claudeignore) are merged into a single `ignore` instance
 * and evaluated against the relative path. Any match blocks.
 *
 * Corrupt/unreadable files fail closed (block).
 */
function findIgnoreMatch(targetPath: string): [string, string] | null {
  // Resolve symlinks to canonical paths (macOS /tmp → /private/tmp)
  const resolved = realpathSafe(targetPath)

  let isDir: boolean
  try {
    isDir = statSync(resolved).isDirectory()
  } catch {
    isDir = false
  }

  const start = isDir ? resolved : dirname(resolved)
  const ignoreFiles = findIgnoreFiles(start)

  for (const ignoreFile of ignoreFiles) {
    // Canonicalize the ignore file's directory too
    const base = realpathSafe(dirname(ignoreFile))
    if (!resolved.startsWith(base + sep)) continue

    // Compute relative path from this ignore file's directory to the target
    let relNorm = resolved.slice(base.length + 1)
    if (!relNorm) continue

    // Normalize to forward slashes (required by `ignore` library)
    relNorm = relNorm.split(sep).join("/")
    // Strip `./` prefix
    if (relNorm.startsWith("./")) relNorm = relNorm.slice(2)
    // Directories need trailing slash for proper matching
    if (isDir && !relNorm.endsWith("/")) relNorm += "/"

    // Merge patterns from all ignore files at this directory level
    const ig = ignore()
    for (const name of IGNORE_FILENAMES) {
      const sibling = join(base, name)
      if (!existsSync(sibling)) continue
      try {
        ig.add(readFileSync(sibling, "utf-8"))
      } catch (e) {
        // Corrupt/unreadable — fail closed
        return [sibling, `cannot read ${sibling}: ${String(e)}`]
      }
    }

    if (ig.ignores(relNorm)) {
      const basename = ignoreFile.split(sep).pop()!
      return [ignoreFile, `matched ${basename} in ${base}`]
    }
  }
  return null
}

// ── Grep response post-filtering ────────────────────────────────────────────

/**
 * Ripgrep raw output (from bash grep, MCP tools): path:N:content,
 * path:N (count), path-N- (context).
 */
const GREP_PATH_SEP = /[:-]\d+(?:[:-]|$)/

/**
 * OpenCode native grep output format (from packages/opencode/src/tool/grep.ts):
 *
 *   Found N matches
 *
 *   /absolute/path/to/file.ts:
 *     Line 10: content
 *     Line 20: content
 *
 * File header lines are absolute paths ending with ":".
 */
const OPENCODE_GREP_FILE_HEADER = /^(\/[^:\n]+):\s*$/

function stringifyResponse(toolResponse: unknown): string {
  if (typeof toolResponse === "string") return toolResponse
  if (toolResponse && typeof toolResponse === "object") {
    if (Array.isArray(toolResponse)) {
      return toolResponse.map(stringifyResponse).join("\n")
    }
    return Object.values(toolResponse as Record<string, unknown>)
      .map(stringifyResponse)
      .join("\n")
  }
  return String(toolResponse)
}

function extractPathCandidates(text: string): Set<string> {
  const candidates = new Set<string>()
  for (const line of text.split("\n")) {
    const trimmed = line.trimEnd()
    if (!trimmed) continue

    // Try OpenCode native grep format first (absolute path headers)
    const headerMatch = trimmed.match(OPENCODE_GREP_FILE_HEADER)
    if (headerMatch) {
      candidates.add(headerMatch[1])
      continue
    }

    // Try raw ripgrep format: path:N:content, path:N, path-N-
    let hadMatch = false
    for (const m of trimmed.matchAll(new RegExp(GREP_PATH_SEP.source, "g"))) {
      if (m.index !== undefined && m.index > 0) {
        candidates.add(trimmed.slice(0, m.index))
        hadMatch = true
      }
    }
    // Fallback: treat the whole line as a path candidate. This handles
    // files-with-matches mode (plain filenames per line), and summary
    // lines like "Found N matches" get filtered later by existsSync().
    if (!hadMatch) {
      candidates.add(trimmed)
    }
  }
  return candidates
}

// ── Plugin ──────────────────────────────────────────────────────────────────

export const OpenCodeAgentIgnorePlugin: Plugin = async ({ client, directory }) => {
  return {
    /** PreToolUse equivalent: block reads/edits on ignored files */
    "tool.execute.before": async (input, output) => {
      const tool = (input as { tool: string }).tool
      if (!BLOCKED_TOOLS.has(tool)) return

      const args =
        (input as unknown as { args?: Record<string, unknown> }).args ??
        (output as { args?: Record<string, unknown> } | undefined)?.args
      const target = getFilePath(args as Record<string, unknown>)
      if (!target) return

      // Always allow project root to prevent blocking entire project
      if (target === ".") return

      // Resolve relative to current directory
      const resolved = isAbsolute(target)
        ? target
        : join(directory, target)

      let realPath: string
      try {
        realPath = realpathSync(resolved)
      } catch {
        return // File doesn't exist yet (e.g., write) — let it through
      }

      const match = findIgnoreMatch(realPath)
      if (match) {
        const [, reason] = match
        const msg = `${SERVICE}: blocked ${tool} of ${target} (${reason})`
        await client.app.log({
          body: { service: SERVICE, level: "warn", message: msg },
        })
        throw new Error(msg)
      }
    },

    /** PostToolUse equivalent: filter Grep responses */
    "tool.execute.after": async (input, output) => {
      const tool = (input as { tool: string }).tool
      if (!tool || tool.toLowerCase() !== "grep") return

      // Extract the grep response text from the output
      const raw: unknown =
        typeof output === "string"
          ? output
          : (output as Record<string, unknown>)?.output
      const responseText = stringifyResponse(raw)
      if (!responseText) return

      // Determine search root from the tool args
      const toolArgs =
        (input as unknown as { args?: Record<string, unknown> }).args ?? {}
      const searchPath = getFilePath(toolArgs)
      let root: string
      if (searchPath) {
        try {
          const r = realpathSync(
            isAbsolute(searchPath)
              ? searchPath
              : join(directory, searchPath),
          )
          root = statSync(r).isDirectory() ? r : dirname(r)
        } catch {
          root = directory
        }
      } else {
        root = directory
      }

      const blocked: string[] = []
      const seen = new Set<string>()

      for (const tok of extractPathCandidates(responseText)) {
        let p = isAbsolute(tok) ? tok : join(root, tok)
        try {
          p = realpathSync(p)
        } catch {
          continue
        }
        if (seen.has(p)) continue
        seen.add(p)
        try {
          if (!existsSync(p)) continue
        } catch {
          continue
        }
        if (findIgnoreMatch(p)) blocked.push(p)
      }

      if (blocked.length > 0) {
        const sample = blocked
          .slice(0, 3)
          .sort()
          .map((p) => relative(root, p))
          .join(", ")
        const more =
          blocked.length > 3 ? ` (+${blocked.length - 3} more)` : ""
        const reason =
          `${SERVICE}: Grep response references protected files: ` +
          `${sample}${more}. Re-run with a narrower \`path\` ` +
          `or \`glob\` exclusion (e.g. "!.env") to avoid these files.`

        await client.app.log({
          body: {
            service: SERVICE,
            level: "warn",
            message: reason,
          },
        })

        // Replace the output with the block message
        if (typeof output === "object" && output !== null) {
          ;(output as Record<string, unknown>).output = reason
        }
      }
    },
  }
}

// Exported for testing
export {
  findIgnoreFiles,
  findIgnoreMatch,
  extractPathCandidates,
  stringifyResponse,
  IGNORE_FILENAMES,
}

// V1 plugin format expected by OpenCode:
// export default { id?: string, server: Plugin }
export default {
  id: "opencode-agentignore",
  server: OpenCodeAgentIgnorePlugin,
}
