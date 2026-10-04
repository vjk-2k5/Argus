import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

const DEFAULT_SESSIONS_DIR = process.platform === "win32"
  ? "C:/Projects/Argus_Sessions"
  : resolve(process.cwd(), "..", "Argus_Sessions")

export function sessionsRoot() {
  const configured = process.env.ARGUS_SESSIONS_DIR?.trim()
  return resolve(configured && configured.length > 0 ? configured : DEFAULT_SESSIONS_DIR)
}

export function workspaceSlug(title: string, problem: string, id: string) {
  const source = (title && title.trim()) || problem.split("\n")[0] || "session"
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "")
  return `${slug || "session"}-${id.replace(/-/g, "").slice(0, 8)}`
}

export function workspaceFor(title: string, problem: string, id: string) {
  return join(sessionsRoot(), workspaceSlug(title, problem, id))
}

export async function ensureWorkspace(path: string) {
  await mkdir(path, { recursive: true })
  return path
}

/**
 * Resolve an operator-chosen working directory. A blank value selects no directory, so the caller
 * falls back to the per-session folder. A supplied path is made absolute, must not be an existing
 * file, and is created when it does not yet exist.
 */
export async function resolveWorkspaceDirectory(input: string | undefined) {
  const raw = input?.trim()
  if (!raw) return undefined
  const target = resolve(raw)
  try {
    const info = await stat(target)
    if (!info.isDirectory()) throw new WorkspaceError(`Workspace path is not a directory: ${target}`)
  } catch (error) {
    if (error instanceof WorkspaceError) throw error
  }
  await mkdir(target, { recursive: true })
  return target
}

export interface DirectoryListing {
  path: string
  parent: string | null
  directories: Array<{ name: string; path: string }>
  error?: string
}

/**
 * List the subfolders of a directory so the operator can browse to a working directory. A blank
 * path opens the home directory. Only directories are returned; files are never listed.
 */
export async function listFilesystemDirectory(input: string | undefined): Promise<DirectoryListing> {
  const target = input?.trim() ? resolve(input.trim()) : homedir()
  const parent = dirname(target)
  let dirents
  try {
    dirents = await readdir(target, { withFileTypes: true })
  } catch {
    return { path: target, parent: parent === target ? null : parent, directories: [], error: `Cannot read ${target}` }
  }
  const directories = dirents
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => ({ name: dirent.name, path: join(target, dirent.name) }))
    .sort((left, right) => left.name.localeCompare(right.name))
  return { path: target, parent: parent === target ? null : parent, directories }
}

/** Filesystem roots to offer as shortcuts: mounted drives on Windows, `/` elsewhere. */
export async function filesystemRoots() {
  if (process.platform !== "win32") return ["/"]
  const candidates = Array.from({ length: 26 }, (_, index) => `${String.fromCharCode(65 + index)}:\\`)
  const present = await Promise.all(candidates.map(async (drive) => {
    try {
      await stat(drive)
      return drive
    } catch {
      return undefined
    }
  }))
  return present.filter((drive): drive is string => Boolean(drive))
}

export class WorkspaceError extends Error {}

/** Resolve a model-supplied path inside the workspace, refusing every escape attempt. */
export function resolveInWorkspace(root: string, candidate: string | undefined) {
  const raw = (candidate ?? ".").trim() || "."
  if (raw.includes("\0")) throw new WorkspaceError("Path contains a null byte")
  const target = isAbsolute(raw) ? resolve(raw) : resolve(root, raw)
  const rel = relative(root, target)
  if (rel === "") return target
  if (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) {
    throw new WorkspaceError(`Path escapes the session workspace: ${raw}`)
  }
  return target
}

export function displayPath(root: string, target: string) {
  const rel = relative(root, target)
  return rel && !rel.startsWith("..") ? rel.split(sep).join("/") : target
}

/** Workspace-style relative path, with `.` for the root itself. */
export function slashRelative(root: string, target: string) {
  const rel = relative(root, target)
  if (!rel) return "."
  return rel.split(sep).join("/")
}

const IGNORED_DIRECTORIES = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "out", "coverage",
  ".next", ".nuxt", ".cache", ".venv", "venv", "__pycache__", ".pytest_cache",
  ".mypy_cache", ".turbo", ".gradle", "target", "vendor", ".idea", ".DS_Store",
])

export function isIgnoredDirectory(name: string) {
  return IGNORED_DIRECTORIES.has(name)
}

export interface WalkOptions {
  maxEntries?: number
  maxDepth?: number
  includeDirectories?: boolean
  signal?: AbortSignal
}

export interface WalkEntry {
  path: string
  relativePath: string
  depth: number
  directory: boolean
  size: number
  modifiedAt: number
}

export async function walk(root: string, options: WalkOptions = {}) {
  const maxEntries = options.maxEntries ?? 20_000
  const maxDepth = options.maxDepth ?? 24
  const entries: WalkEntry[] = []
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }]

  while (queue.length > 0 && entries.length < maxEntries) {
    if (options.signal?.aborted) throw new WorkspaceError("Operation aborted")
    const current = queue.shift()!
    let dirents
    try {
      dirents = await readdir(current.path, { withFileTypes: true })
    } catch {
      continue
    }
    dirents.sort((left, right) => left.name.localeCompare(right.name))
    for (const dirent of dirents) {
      if (entries.length >= maxEntries) break
      const full = join(current.path, dirent.name)
      const relativePath = displayPath(root, full)
      if (dirent.isDirectory()) {
        if (isIgnoredDirectory(dirent.name)) continue
        if (options.includeDirectories) {
          entries.push({ path: full, relativePath, depth: current.depth, directory: true, size: 0, modifiedAt: 0 })
        }
        if (current.depth + 1 <= maxDepth) queue.push({ path: full, depth: current.depth + 1 })
        continue
      }
      if (!dirent.isFile() && !dirent.isSymbolicLink()) continue
      let size = 0
      let modifiedAt = 0
      try {
        const info = await stat(full)
        size = info.size
        modifiedAt = info.mtimeMs
      } catch {
        continue
      }
      entries.push({ path: full, relativePath, depth: current.depth, directory: false, size, modifiedAt })
    }
  }
  return entries
}

/** Expand `{a,b}` alternations into separate patterns, so brace globs work. */
export function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf("{")
  if (open < 0) return [pattern]
  let depth = 0
  let close = -1
  for (let index = open; index < pattern.length; index++) {
    const char = pattern[index]
    if (char === "{") depth++
    else if (char === "}") {
      depth--
      if (depth === 0) { close = index; break }
    }
  }
  if (close < 0) return [pattern]
  const body = pattern.slice(open + 1, close)
  const alternatives: string[] = []
  let current = ""
  let nested = 0
  for (const char of body) {
    if (char === "{") { nested++; current += char; continue }
    if (char === "}") { nested--; current += char; continue }
    if (char === "," && nested === 0) { alternatives.push(current); current = ""; continue }
    current += char
  }
  alternatives.push(current)
  if (alternatives.length === 1) return [pattern]
  const prefix = pattern.slice(0, open)
  const suffix = pattern.slice(close + 1)
  return alternatives.flatMap((alternative) => expandBraces(`${prefix}${alternative}${suffix}`))
}

export function globMatchers(pattern: string) {
  const cleaned = pattern.replace(/^\.\//, "")
  return expandBraces(cleaned).map(globToRegExp)
}

/** Translate a glob (`**`, `*`, `?`, character classes) into an anchored regular expression. */
export function globToRegExp(pattern: string) {
  let source = ""
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        index++
        if (pattern[index + 1] === "/") {
          index++
          source += "(?:.*/)?"
        } else {
          source += ".*"
        }
      } else {
        source += "[^/]*"
      }
      continue
    }
    if (char === "?") {
      source += "[^/]"
      continue
    }
    if (char === "[") {
      const end = pattern.indexOf("]", index + 1)
      if (end > 0) {
        const body = pattern.slice(index + 1, end).replace(/^!/, "^")
        source += `[${body}]`
        index = end
        continue
      }
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`^${source}$`)
}

export function looksBinary(buffer: Uint8Array) {
  const limit = Math.min(buffer.length, 8_000)
  for (let index = 0; index < limit; index++) {
    if (buffer[index] === 0) return true
  }
  return false
}

const BINARY_EXTENSIONS = new Set([
  "zip", "tar", "gz", "bz2", "xz", "7z", "rar",
  "exe", "dll", "so", "dylib", "class", "jar", "war", "wasm", "obj", "o", "a", "lib", "bin", "dat",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp",
  "pyc", "pyo", "mp3", "mp4", "mov", "avi", "mkv", "wav", "flac", "webm", "ttf", "otf", "woff", "woff2",
])

export function isBinaryPath(path: string) {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase()
  return path.includes(".") && BINARY_EXTENSIONS.has(extension)
}

const BOM = "\uFEFF"

export function splitBom(text: string) {
  return text.startsWith(BOM) ? { bom: true, text: text.slice(1) } : { bom: false, text }
}

export function joinBom(text: string, bom: boolean) {
  return bom ? BOM + text : text
}

export function detectLineEnding(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n"
}

export function convertToLineEnding(text: string, ending: "\n" | "\r\n") {
  const normalized = text.replaceAll("\r\n", "\n")
  return ending === "\n" ? normalized : normalized.replaceAll("\n", "\r\n")
}

export async function readTextFile(path: string, maxBytes = 2_000_000) {
  const buffer = new Uint8Array(await readFile(path))
  if (looksBinary(buffer)) throw new WorkspaceError("File appears to be binary")
  if (buffer.length > maxBytes) {
    throw new WorkspaceError(`File is too large to read (${buffer.length} bytes, limit ${maxBytes})`)
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(buffer)
}

export async function pathExists(path: string) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export async function writeTextFile(path: string, content: string) {
  await mkdir(resolve(path, ".."), { recursive: true })
  await writeFile(path, content, "utf8")
}

export function homeDirectory() {
  return homedir()
}

export function isInsideRoot(root: string, target: string) {
  const rel = relative(resolve(root), resolve(target))
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

export const MAX_LINE_LENGTH = 2_000
export const MAX_READ_BYTES = 50 * 1024
export const DEFAULT_READ_LIMIT = 2_000

/**
 * Read a file with hard caps on line length and total output size, reporting whether more
 * content remains so the caller can be told exactly how to continue.
 */
export function sliceLines(content: string, options: { offset: number; limit: number }) {
  const start = options.offset - 1
  const all = content.split("\n")
  const raw: string[] = []
  let bytes = 0
  let cut = false
  let more = false

  for (let index = start; index < all.length; index++) {
    if (raw.length >= options.limit) {
      more = true
      break
    }
    const source = all[index]!
    const line = source.length > MAX_LINE_LENGTH ? `${source.slice(0, MAX_LINE_LENGTH)}... (line truncated to ${MAX_LINE_LENGTH} chars)` : source
    const size = Buffer.byteLength(line, "utf8") + (raw.length > 0 ? 1 : 0)
    if (bytes + size > MAX_READ_BYTES) {
      cut = true
      more = true
      break
    }
    raw.push(line)
    bytes += size
  }

  return { raw, totalLines: all.length, cut, more, offset: options.offset }
}
