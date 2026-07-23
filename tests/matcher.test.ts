/**
 * Tests for opencode-agentignore
 *
 * Ported from claude-ignore's test_claude_ignore.py.
 * Run: npm test
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  realpathSync,
} from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import ignore from "ignore"

// ── Import plugin internals ─────────────────────────────────────────────────

import {
  findIgnoreFiles,
  findIgnoreMatch,
  extractPathCandidates,
  stringifyResponse,
} from "../src/index"

// ── Helpers ─────────────────────────────────────────────────────────────────

function mkdtemp(): string {
  const dir = join(
    tmpdir(),
    `opencode-agentignore-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  )
  mkdirSync(dir, { recursive: true })
  return resolve(dir)
}

// macOS /tmp is a symlink to /private/tmp. Use realpathSync for canonical
// paths so they match what findIgnoreMatch / findIgnoreFiles return internally.
function real(s: string): string {
  return realpathSync(s)
}

// ── `ignore` library integration tests ──────────────────────────────────────

describe("ignore library integration", () => {
  it("empty ignores nothing", () => {
    const ig = ignore()
    expect(ig.ignores("anything")).toBe(false)
    expect(ig.ignores("a/b/c.txt")).toBe(false)
  })

  it("simple extension", () => {
    const ig = ignore().add("*.log")
    expect(ig.ignores("foo.log")).toBe(true)
    expect(ig.ignores("nested/dir/bar.log")).toBe(true)
    expect(ig.ignores("foo.txt")).toBe(false)
  })

  it("exact filename", () => {
    const ig = ignore().add(".env")
    expect(ig.ignores(".env")).toBe(true)
    expect(ig.ignores("sub/.env")).toBe(true)
    expect(ig.ignores(".envfile")).toBe(false)
  })

  it("directory only pattern", () => {
    // `ignore` library: "build/" matches directories, "build" matches files.
    // With trailing slash, it's a directory match.
    const ig = ignore().add("build/")
    expect(ig.ignores("build/")).toBe(true)
    // "build" without slash is treated as file path → doesn't match dir pattern
    expect(ig.ignores("build")).toBe(false)
    // Files inside ignored directory are blocked
    expect(ig.ignores("build/out.js")).toBe(true)
  })

  it("double star leading", () => {
    const ig = ignore().add("**/node_modules/")
    expect(ig.ignores("node_modules/foo.js")).toBe(true)
    expect(ig.ignores("a/b/node_modules/foo.js")).toBe(true)
  })

  it("double star trailing", () => {
    const ig = ignore().add("logs/**")
    expect(ig.ignores("logs/foo.txt")).toBe(true)
    expect(ig.ignores("logs/a/b/c.txt")).toBe(true)
  })

  it("double star middle", () => {
    const ig = ignore().add("a/**/b")
    expect(ig.ignores("a/b")).toBe(true)
    expect(ig.ignores("a/x/b")).toBe(true)
    expect(ig.ignores("a/x/y/b")).toBe(true)
  })

  it("anchored pattern", () => {
    const ig = ignore().add("/foo")
    expect(ig.ignores("foo")).toBe(true)
    expect(ig.ignores("sub/foo")).toBe(false)
  })

  it("unanchored pattern", () => {
    const ig = ignore().add("foo")
    expect(ig.ignores("foo")).toBe(true)
    expect(ig.ignores("sub/foo")).toBe(true)
  })

  it("comments and blank lines are skipped", () => {
    const ig = ignore().add(["", "# comment", "  ", "*.log"].join("\n"))
    expect(ig.ignores("foo.log")).toBe(true)
  })

  it("negation re-includes", () => {
    const ig = ignore().add(["*.log", "!keep.log"].join("\n"))
    expect(ig.ignores("foo.log")).toBe(true)
    expect(ig.ignores("keep.log")).toBe(false)
  })

  it("negation inside ignored dir — ignore library behavior", () => {
    // The `ignore` library treats `secrets/` as ignoring the entire
    // directory. A later `!secrets/public.txt` cannot re-include a
    // file inside an ignored directory (same as git semantics for
    // directory-level ignores — once a dir is ignored, contents are
    // locked out unless the dir itself is re-included first).
    const ig = ignore().add(["secrets/", "!secrets/public.txt"].join("\n"))
    expect(ig.ignores("secrets/public.txt")).toBe(true)
    expect(ig.ignores("secrets/other.txt")).toBe(true)
  })

  it("question mark wildcard", () => {
    const ig = ignore().add("f?o.txt")
    expect(ig.ignores("foo.txt")).toBe(true)
    expect(ig.ignores("fxo.txt")).toBe(true)
    expect(ig.ignores("foob.txt")).toBe(false)
    expect(ig.ignores("f/o.txt")).toBe(false)
  })

  it("character class", () => {
    const ig = ignore().add("file[12].txt")
    expect(ig.ignores("file1.txt")).toBe(true)
    expect(ig.ignores("file2.txt")).toBe(true)
    expect(ig.ignores("file3.txt")).toBe(false)
  })

  it("dotted files", () => {
    const ig = ignore().add(".env.*")
    expect(ig.ignores(".env.local")).toBe(true)
    expect(ig.ignores(".env.production")).toBe(true)
    expect(ig.ignores(".env")).toBe(false)
  })
})

// ── Hierarchical lookup tests ───────────────────────────────────────────────

describe("findIgnoreFiles — hierarchical lookup", () => {
  it("finds files walking up from deep subdirectory", () => {
    const tmp = mkdtemp()
    try {
      writeFileSync(join(tmp, ".claudeignore"), "a\n")
      const sub = join(tmp, "sub", "deep")
      mkdirSync(sub, { recursive: true })
      writeFileSync(join(tmp, "sub", ".agentignore"), "b\n")
      writeFileSync(join(sub, ".claudeignore"), "c\n")

      const files = findIgnoreFiles(sub)
      // Root-most first, leaf-most last
      expect(files).toEqual([
        real(join(tmp, ".claudeignore")),
        real(join(tmp, "sub", ".agentignore")),
        real(join(tmp, "sub", "deep", ".claudeignore")),
      ])
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("returns empty when no ignore files exist", () => {
    const tmp = mkdtemp()
    try {
      expect(findIgnoreFiles(real(tmp))).toEqual([])
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("finds both .agentignore and .claudeignore at same level", () => {
    const tmp = mkdtemp()
    try {
      writeFileSync(join(tmp, ".claudeignore"), "a\n")
      writeFileSync(join(tmp, ".agentignore"), "b\n")
      const files = findIgnoreFiles(real(tmp))
      expect(files).toHaveLength(2)
      expect(files).toContain(real(join(tmp, ".claudeignore")))
      expect(files).toContain(real(join(tmp, ".agentignore")))
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

// ── Block/allow integration tests ───────────────────────────────────────────

describe("findIgnoreMatch — block/allow", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtemp()
    writeFileSync(
      join(tmp, ".claudeignore"),
      [".env", "*.secret", "secrets/", "build/", "**/node_modules/", "*.log"].join("\n"),
    )
    writeFileSync(join(tmp, ".env"), "")
    writeFileSync(join(tmp, "app.secret"), "")
    writeFileSync(join(tmp, "ok.txt"), "")
    writeFileSync(join(tmp, "foo.log"), "")
    mkdirSync(join(tmp, "secrets"))
    writeFileSync(join(tmp, "secrets", "private.txt"), "")
    mkdirSync(join(tmp, "build"))
    writeFileSync(join(tmp, "build", "out.js"), "")
    mkdirSync(join(tmp, "node_modules"))
    writeFileSync(join(tmp, "node_modules", "foo.js"), "")
    mkdirSync(join(tmp, "sub", "node_modules"), { recursive: true })
    writeFileSync(join(tmp, "sub", "node_modules", "bar.js"), "")
    writeFileSync(join(tmp, "sub", "file.txt"), "")
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("blocks matched paths", () => {
    const blocked = [
      ".env", "app.secret", "secrets/private.txt",
      "build/out.js", "node_modules/foo.js",
      "sub/node_modules/bar.js", "foo.log",
    ]
    for (const p of blocked) {
      const rp = real(join(tmp, p))
      expect(findIgnoreMatch(rp), p).not.toBeNull()
    }
  })

  it("allows unmatched paths", () => {
    expect(findIgnoreMatch(real(join(tmp, "ok.txt")))).toBeNull()
    expect(findIgnoreMatch(real(join(tmp, "sub", "file.txt")))).toBeNull()
  })

  it("allows paths with no ignore file ancestor", () => {
    expect(findIgnoreMatch("/etc/hosts")).toBeNull()
  })

  it("hierarchical merge picks up deeper ignore files", () => {
    const sub = join(tmp, "sub")
    writeFileSync(join(sub, ".claudeignore"), "file.txt\n")
    writeFileSync(join(sub, "file.txt"), "")
    expect(findIgnoreMatch(real(join(sub, "file.txt")))).not.toBeNull()
    expect(findIgnoreMatch(real(join(tmp, "ok.txt")))).toBeNull()
  })

  it("anchored pattern is relative to its ignore file dir", () => {
    const sub = join(tmp, "sub")
    mkdirSync(join(sub, "anchored"))
    writeFileSync(join(sub, "anchored", "foo"), "")
    writeFileSync(join(sub, ".claudeignore"), "/foo\n")
    writeFileSync(join(sub, "foo"), "")
    expect(findIgnoreMatch(real(join(sub, "foo")))).not.toBeNull()
    expect(findIgnoreMatch(real(join(sub, "anchored", "foo")))).toBeNull()
  })

  it("symlink to ignored file is blocked", () => {
    const link = join(tmp, "safe.txt")
    symlinkSync(join(tmp, ".env"), link)
    expect(findIgnoreMatch(real(link))).not.toBeNull()
  })

  // Note: The `ignore` library is resilient — invalid UTF-8 bytes
  // decode as replacement characters rather than throwing, so
  // `readFileSync(sibling, "utf-8")` won't trigger the fail-closed
  // path for corrupt content. True fail-closed applies to permission
  // errors and other filesystem-level failures.
  it("silently handles binary content in ignore file", () => {
    writeFileSync(join(tmp, ".claudeignore"), Buffer.from([0xff, 0xfe]))
    // Should not throw — ignore library just ignores garbage patterns
    expect(() => findIgnoreMatch(real(join(tmp, "ok.txt")))).not.toThrow()
  })

  it("both .agentignore and .claudeignore at same level are merged", () => {
    writeFileSync(join(tmp, ".claudeignore"), ".env\n")
    writeFileSync(join(tmp, ".agentignore"), "*.secret\n")
    expect(findIgnoreMatch(real(join(tmp, ".env")))).not.toBeNull()
    expect(findIgnoreMatch(real(join(tmp, "app.secret")))).not.toBeNull()
    expect(findIgnoreMatch(real(join(tmp, "ok.txt")))).toBeNull()
  })

  it("leaf negation cannot re-include ancestor-ignored dir", () => {
    // secrets/ is ignored at root level. A deeper .claudeignore with
    // !private.txt cannot override the root-level block, because we
    // check each directory level independently (walk-up model).
    const sub = join(tmp, "secrets")
    writeFileSync(join(sub, ".claudeignore"), "!private.txt\n")
    expect(findIgnoreMatch(real(join(tmp, "secrets", "private.txt")))).not.toBeNull()
  })
})

// ── Grep post-filter tests ──────────────────────────────────────────────────

describe("stringifyResponse", () => {
  it("passes through plain strings", () => {
    expect(stringifyResponse("hello\nworld")).toBe("hello\nworld")
  })

  it("extracts values from object", () => {
    const result = stringifyResponse({ output: ".env:1:secret\n", mode: "content" })
    expect(result).toContain(".env:1:secret")
  })

  it("extracts from array", () => {
    expect(stringifyResponse(["a", "b"])).toBe("a\nb")
  })

  it("falls back to String()", () => {
    expect(stringifyResponse(42)).toBe("42")
  })
})

describe("extractPathCandidates", () => {
  it("extracts from content mode (path:N:content)", () => {
    const candidates = extractPathCandidates(".env:1:API_KEY=sk-123\nok.py:1:x = 1\n")
    expect(candidates.has(".env")).toBe(true)
    expect(candidates.has("ok.py")).toBe(true)
  })

  it("extracts from files-with-matches mode (plain paths)", () => {
    // In files-with-matches mode, output is one path per line.
    // These lines don't have path separators — add them as candidates.
    const candidates = extractPathCandidates(".env\nok.py\n")
    expect(candidates.has(".env")).toBe(true)
    expect(candidates.has("ok.py")).toBe(true)
  })

  it("extracts from count mode (path:N)", () => {
    const candidates = extractPathCandidates(".env:5\nok.py:2\n")
    expect(candidates.has(".env")).toBe(true)
    expect(candidates.has("ok.py")).toBe(true)
  })

  it("extracts from context mode (path-N-content)", () => {
    const candidates = extractPathCandidates("key.pem-1-PRIVATE\nok.py-2-x = 1\n")
    expect(candidates.has("key.pem")).toBe(true)
    expect(candidates.has("ok.py")).toBe(true)
  })

  it("extracts absolute paths", () => {
    const candidates = extractPathCandidates("/home/user/.env:1:secret\n")
    expect(candidates.has("/home/user/.env")).toBe(true)
  })

  it("extracts from OpenCode native grep format", () => {
    const text = [
      "Found 3 matches", "",
      "/home/user/.env:",
      "  Line 3: API_KEY=sk-123",
      "  Line 5: SECRET=xxx", "",
      "/home/user/src/main.ts:",
      "  Line 42: console.log(config)",
    ].join("\n")
    const candidates = extractPathCandidates(text)
    expect(candidates.has("/home/user/.env")).toBe(true)
    expect(candidates.has("/home/user/src/main.ts")).toBe(true)
  })

  it("handles empty input", () => {
    expect(extractPathCandidates("").size).toBe(0)
  })
})
