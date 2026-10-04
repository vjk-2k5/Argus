import { rm } from "node:fs/promises"
import { displayPath, joinBom, resolveInWorkspace, splitBom, writeTextFile, WorkspaceError } from "./fs"

type Hunk =
  | { type: "add"; path: string; contents: string }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; movePath?: string; chunks: Chunk[] }

interface Chunk {
  original: string
  replacement: string
}

const BEGIN = "*** Begin Patch"
const END = "*** End Patch"

/**
 * Parse the `*** Begin Patch` envelope used for multi-file structured edits.
 * Supports Add, Delete, and Update (with optional Move to) file operations.
 */
export function parsePatch(patchText: string): Hunk[] {
  const normalized = patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim()
  if (!normalized.startsWith(BEGIN)) {
    throw new Error(`patch must start with "${BEGIN}"`)
  }
  const endIndex = normalized.indexOf(END)
  if (endIndex < 0) throw new Error(`patch must end with "${END}"`)

  const body = normalized.slice(BEGIN.length, endIndex)
  const lines = body.split("\n")
  const hunks: Hunk[] = []
  let current: { type: string; path: string; movePath?: string; lines: string[] } | undefined

  const flush = () => {
    if (!current) return
    if (current.type === "add") {
      const contents = current.lines.map((line) => {
        if (!line.startsWith("+")) throw new Error(`Add File lines must start with "+": ${line}`)
        return line.slice(1)
      }).join("\n")
      hunks.push({ type: "add", path: current.path, contents })
    } else if (current.type === "delete") {
      hunks.push({ type: "delete", path: current.path })
    } else if (current.type === "update") {
      hunks.push({ type: "update", path: current.path, ...(current.movePath ? { movePath: current.movePath } : {}), chunks: collectChunks(current.lines, current.path) })
    } else if (current.type !== "") {
      throw new Error(`unknown patch header: ${current.type}`)
    }
    current = undefined
  }

  for (const line of lines) {
    const header = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/)
    if (header) {
      flush()
      current = { type: header[1]!.toLowerCase(), path: header[2]!.trim(), lines: [] }
      continue
    }
    const move = line.match(/^\*\*\* Move to: (.+)$/)
    if (move && current) {
      current.movePath = move[1]!.trim()
      continue
    }
    if (line.trim() === "") continue
    if (/^\*\*\* /.test(line)) throw new Error(`unexpected patch line: ${line}`)
    if (!current) throw new Error(`patch content outside a file header: ${line}`)
    current.lines.push(line)
  }
  flush()
  return hunks
}

/** `@@` markers are context anchors; the actual old/new text lives in the + and - lines. */
function collectChunks(lines: string[], path: string): Chunk[] {
  const chunks: Chunk[] = []
  let anchor: string | undefined
  let original: string[] = []
  let replacement: string[] = []
  let seen = false

  const commit = () => {
    if (!seen) return
    chunks.push({ original: original.join("\n"), replacement: replacement.join("\n") })
    original = []
    replacement = []
    seen = false
  }

  for (const line of lines) {
    if (line.startsWith("@@")) {
      commit()
      anchor = line.slice(2).trim() || undefined
      continue
    }
    if (line.startsWith("***")) continue
    if (anchor && original.length === 0 && replacement.length === 0) {
      // The anchor is a human-readable hint, not content to match.
    }
    seen = true
    if (line.startsWith("-")) original.push(line.slice(1))
    else if (line.startsWith("+")) replacement.push(line.slice(1))
    else if (line.startsWith(" ")) {
      original.push(line.slice(1))
      replacement.push(line.slice(1))
    } else {
      throw new Error(`update line must start with " ", "+", or "-": ${line} (in ${path})`)
    }
  }
  commit()
  return chunks
}

export interface PatchResult {
  applied: string[]
  removed: string[]
  moved: string[]
  details: string[]
}

export async function applyPatchText(input: {
  patchText: string
  workspace: string
  readFile: (absolute: string) => Promise<string>
  fileExists: (absolute: string) => Promise<boolean>
}): Promise<PatchResult> {
  const hunks = parsePatch(input.patchText)
  if (hunks.length === 0) {
    if (input.patchText.replace(/\r\n/g, "\n").trim() === `${BEGIN}\n${END}`) {
      throw new WorkspaceError("patch rejected: empty patch")
    }
    throw new WorkspaceError("apply_patch verification failed: no file operations found")
  }

  // Verify everything before touching disk so a bad hunk cannot leave a half-applied patch.
  const planned: Array<{ hunk: Hunk; absolute: string; target: string; content?: string }> = []
  for (const hunk of hunks) {
    const absolute = resolveInWorkspace(input.workspace, hunk.path)
    if (hunk.type === "add") {
      if (await input.fileExists(absolute)) {
        throw new WorkspaceError(`apply_patch verification failed: ${hunk.path} already exists. Use Update File to change it.`)
      }
      const contents = hunk.contents.length === 0 || hunk.contents.endsWith("\n") ? hunk.contents : `${hunk.contents}\n`
      planned.push({ hunk, absolute, target: absolute, content: contents })
      continue
    }
    if (!(await input.fileExists(absolute))) {
      throw new WorkspaceError(`apply_patch verification failed: cannot ${hunk.type} ${hunk.path} because it does not exist`)
    }
    if (hunk.type === "delete") {
      planned.push({ hunk, absolute, target: absolute })
      continue
    }
    const source = splitBom(await input.readFile(absolute))
    let content = source.text
    for (const chunk of hunk.chunks) {
      const needle = chunk.original
      if (needle === "") {
        content = `${chunk.replacement}\n${content}`
        continue
      }
      const index = content.indexOf(needle)
      if (index < 0) {
        throw new WorkspaceError(`apply_patch verification failed: context not found in ${hunk.path}:\n${needle.slice(0, 200)}`)
      }
      if (content.indexOf(needle, index + 1) >= 0) {
        throw new WorkspaceError(`apply_patch verification failed: context is ambiguous in ${hunk.path}, it appears more than once:\n${needle.slice(0, 200)}`)
      }
      content = content.slice(0, index) + chunk.replacement + content.slice(index + needle.length)
    }
    const moveAbsolute = hunk.movePath ? resolveInWorkspace(input.workspace, hunk.movePath) : undefined
    planned.push({ hunk, absolute, target: moveAbsolute ?? absolute, content: joinBom(content, source.bom) })
  }

  const result: PatchResult = { applied: [], removed: [], moved: [], details: [] }
  for (const item of planned) {
    const shown = displayPath(input.workspace, item.absolute)
    if (item.hunk.type === "delete") {
      await rm(item.absolute, { force: true })
      result.removed.push(shown)
      result.details.push(`deleted ${shown}`)
      continue
    }
    if (item.hunk.type === "add") {
      await writeTextFile(item.target, item.content ?? "")
      result.applied.push(shown)
      result.details.push(`created ${shown} (${(item.content ?? "").split("\n").length} lines)`)
      continue
    }
    if (item.target !== item.absolute) {
      await writeTextFile(item.target, item.content ?? "")
      await rm(item.absolute, { force: true })
      result.moved.push(`${shown} -> ${displayPath(input.workspace, item.target)}`)
    } else {
      await writeTextFile(item.target, item.content ?? "")
    }
    result.applied.push(shown)
    const chunks = item.hunk.type === "update" ? item.hunk.chunks.length : 0
    result.details.push(`updated ${shown} (${chunks} chunk${chunks === 1 ? "" : "s"})`)
  }
  return result
}

export function summarizePatch(result: PatchResult) {
  return [
    `Patch applied: ${result.details.length} file operation(s).`,
    ...result.details.map((line) => `  - ${line}`),
    result.details.length > 0 ? "Read the changed files back to verify." : "",
  ].filter(Boolean).join("\n")
}
