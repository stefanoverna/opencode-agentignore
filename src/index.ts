/**
 * opencode-ignore — OpenCode plugin
 *
 * Blocks tool calls targeting files matched by .claudeignore (gitignore syntax).
 * Walks up from the target file's directory to find all .claudeignore files.
 * Also post-filters Grep responses to prevent content leaks from protected files.
 *
 * In OpenCode this is a plugin using tool.execute.before / tool.execute.after
 * instead of Claude Code's settings.json PreToolUse / PostToolUse hooks.
 */

import { existsSync, readFileSync, statSync } from "node:fs"
import { resolve, relative, dirname, sep, isAbsolute, join } from "node:path"
import { realpathSync } from "node:fs"
import type { Plugin } from "@opencode-ai/plugin"

// ── gitignore-style pattern matching ────────────────────────────────────────

type Pattern = {
  regex: RegExp
  negate: boolean
  dirOnly: boolean
}

/**
 * Translate a gitignore pattern body into a regex string.
 * Returns [regexBody, anchored].
 */
function translate(pattern: string): [string, boolean] {
  // A pattern is anchored if it contains "/" anywhere except as a trailing "/".
  const anchored = pattern.slice(0, -1).includes("/") || pattern.startsWith("/")
  if (pattern.startsWith("/")) pattern = pattern.slice(1)

  let out = ""
  let i = 0
  const n = pattern.length

  while (i < n) {
    const c = pattern[i]
    if (c === "*") {
      if (i + 1 < n && pattern[i + 1] === "*") {
        if (i + 2 < n && pattern[i + 2] === "/") {
          if (i === 0) {
            out += "(?:.*/)?"
            i += 3
            continue
          } else {
            out += "(?:.*/)?"
            i += 3
            continue
          }
        } else if (i + 2 === n) {
          out += ".*"
          i += 2
          continue
        } else {
          out += "[^/]*"
          i += 2
          continue
        }
      } else {
        out += "[^/]*"
        i += 1
        continue
      }
    } else if (c === "?") {
      out += "[^/]"
      i += 1
    } else if (c === "[") {
      // Character class
      let j = i + 1
      if (j < n && pattern[j] === "!") j++
      if (j < n && pattern[j] === "]") j++
      while (j < n && pattern[j] !== "]") j++
      if (j >= n) {
        out += escapeRegex(c)
        i += 1
      } else {
        let cls = pattern.slice(i + 1, j)
        if (cls.startsWith("!")) cls = "^" + cls.slice(1)
        out += "[" + cls + "]"
        i = j + 1
      }
    } else if (c === "/") {
      out += "/"
      i += 1
    } else {
      out += escapeRegex(c)
      i += 1
    }
  }

  return [out, anchored]
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function compile(pattern: string): Pattern | null {
  pattern = pattern.trimEnd()
  if (!pattern || pattern.startsWith("#")) return null

  let negate = false
  if (pattern.startsWith("!")) {
    negate = true
    pattern = pattern.slice(1)
  }

  let dirOnly = false
  if (pattern.endsWith("/")) {
    dirOnly = true
    pattern = pattern.slice(0, -1)
  }

  if (!pattern) return null

  const [body, anchored] = translate(pattern)
  let regex: RegExp
  if (anchored) {
    regex = new RegExp("^" + body + "$")
  } else {
    regex = new RegExp("(?:^|/)" + body + "$")
  }
  return { regex, negate, dirOnly }
}

class GitignoreMatcher {
  patterns: Pattern[] = []

  add(lines: string[]): void {
    for (const raw of lines) {
      const p = compile(raw)
      if (p) this.patterns.push(p)
    }
  }

  private matchOne(path: string, isDir: boolean): boolean {
    let ignored = false
    for (const p of this.patterns) {
      if (p.dirOnly && !isDir) continue
      if (p.regex.test(path)) {
        ignored = !p.negate
      }
    }
    return ignored
  }

  /** Returns true if `path` (or any ancestor dir) is ignored. */
  matches(path: string, isDir = false): boolean {
    const parts = path.split("/")
    // Check each ancestor directory first, then the path itself
    for (let i = 1; i < parts.length; i++) {
      if (this.matchOne(parts.slice(0, i).join("/"), true)) return true
    }
    return this.matchOne(path, isDir)
  }
}

// ── .claudeignore file discovery ────────────────────────────────────────────

function realpathSafe(p: string): string {
  try { return realpathSync(p) } catch { return p }
}

/** Ignore files we look for at each directory level (checked in order). */
const IGNORE_FILENAMES = [".agentignore", ".claudeignore"]

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
 * Check whether `path` is blocked by any ignore file in the hierarchy.
 * Returns [ignoreFile, reason] if blocked, or null if allowed.
 *
 * Walks up from `path`'s parent (or path itself if it's a dir).
 * At each directory level, patterns from all co-located ignore files
 * (.agentignore + .claudeignore) are merged and evaluated together.
 * Any match blocks. Corrupt/unreadable files fail closed.
 */
function findIgnoreMatch(targetPath: string): [string, string] | null {
  let isDir: boolean
  try {
    isDir = statSync(targetPath).isDirectory()
  } catch {
    isDir = false
  }

  const start = isDir ? targetPath : dirname(targetPath)
  const ignoreFiles = findIgnoreFiles(start)

  for (const ignoreFile of ignoreFiles) {
    const base = dirname(ignoreFile)
    let rel: string
    try {
      rel = relative(base, targetPath)
    } catch {
      continue
    }
    if (!rel || rel === ".") continue
    // Normalize to forward slashes
    const relNorm = rel.split(sep).join("/")

    // Merge patterns from all ignore files at this directory level
    const matcher = new GitignoreMatcher()
    for (const name of IGNORE_FILENAMES) {
      const sibling = join(base, name)
      if (!existsSync(sibling)) continue
      try {
        matcher.add(readFileSync(sibling, "utf-8").split("\n"))
      } catch (e) {
        // Corrupt/unreadable — fail closed
        return [sibling, `cannot read ${sibling}: ${String(e)}`]
      }
    }

    if (matcher.matches(relNorm, isDir)) {
      const basename = ignoreFile.split(sep).pop()!
      return [ignoreFile, `matched ${basename} in ${base}`]
    }
  }
  return null
}

// ── Tool names we intercept ─────────────────────────────────────────────────

const BLOCKED_TOOLS = new Set([
  "read",
  "edit",
  "write",
  "glob",
  "grep",
  "multiedit",
])

function getFilePath(args: Record<string, unknown> | undefined): string | null {
  if (!args) return null
  const p = (args.filePath ?? args.file_path ?? args.path) as string | undefined
  return typeof p === "string" && p.trim() ? p : null
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
 *   /another/file.ts:
 *     Line 5: content
 *
 * File header lines are absolute paths ending with ":".
 */
const OPENCODE_GREP_FILE_HEADER = /^([/][^:\n]+):\s*$/

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
    // If no separator was found, the whole line might be a path
    // (e.g. ripgrep files-with-matches mode). Only add if it looks like a path.
    if (!hadMatch && (trimmed.includes("/") || trimmed.includes("\\"))) {
      candidates.add(trimmed)
    }
  }
  return candidates
}

// ── Plugin ──────────────────────────────────────────────────────────────────

export const OpenCodeIgnorePlugin: Plugin = async ({ client, directory }) => {
  return {
    /** PreToolUse equivalent: block reads/edits on ignored files */
    "tool.execute.before": async (input, output) => {
      const tool = input.tool
      if (!BLOCKED_TOOLS.has(tool)) return

      const args =
        (input as unknown as { args?: Record<string, unknown> }).args ??
        output.args
      const target = getFilePath(args as Record<string, unknown>)
      if (!target) return

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
        const msg = `opencode-ignore: blocked ${tool} of ${target} (${reason})`
        await client.app.log({
          body: { service: "opencode-ignore", level: "warn", message: msg },
        })
        throw new Error(msg)
      }
    },

    /** PostToolUse equivalent: filter Grep responses */
    "tool.execute.after": async (input, output) => {
      const tool = (input as { tool: string }).tool
      if (!tool || tool.toLowerCase() !== "grep") return

      // Log for debugging — remove once confirmed working
      await client.app.log({
        body: {
          service: "opencode-ignore",
          level: "debug",
          message: `grep post-filter fired (tool="${tool}", output keys: ${Object.keys(output || {}).join(", ")})`,
        },
      })

      // Extract the grep response text from the output. The output shape varies:
      //   { output: "...", title: "...", metadata: ... }  — standard
      //   "..."  — plain string (defensive fallback)
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
            isAbsolute(searchPath) ? searchPath : join(directory, searchPath),
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
        const more = blocked.length > 3 ? ` (+${blocked.length - 3} more)` : ""
        const reason =
          `opencode-ignore: Grep response references protected files: ` +
          `${sample}${more}. Re-run with a narrower \`path\` ` +
          `or \`glob\` exclusion (e.g. "!.env") to avoid these files.`

        await client.app.log({
          body: {
            service: "opencode-ignore",
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
