import { readdir, stat } from "node:fs/promises"
import { z } from "zod"
import type { ToolAccess, ToolDescriptor, ToolInvocation, ToolName } from "@argus/shared"
import {
  convertToLineEnding,
  DEFAULT_READ_LIMIT,
  detectLineEnding,
  displayPath,
  globMatchers,
  isBinaryPath,
  joinBom,
  MAX_LINE_LENGTH,
  pathExists,
  readTextFile,
  resolveInWorkspace,
  sliceLines,
  slashRelative,
  splitBom,
  walk,
  writeTextFile,
  WorkspaceError,
} from "./fs"
import { checkCommand, runShell, shellSyntaxHint } from "./shell"
import { fetchPage, searchWeb } from "./web"
import { applyPatchText, summarizePatch } from "./patch"
import { scanCommandPaths } from "./scan"
import { replace as replaceText } from "./replace"

function statPath(path: string) {
  return stat(path).catch(() => undefined)
}

export interface ToolContext {
  sessionId: string
  messageId: string
  workspace: string
  access: ToolAccess
  signal: AbortSignal
  onUpdate: (invocation: ToolInvocation) => void
  onQuestion: (question: string, options: string[]) => void
}

export interface ToolDefinition {
  name: ToolName
  description: string
  access: "read" | "full"
  mutating: boolean
  parameters: z.ZodTypeAny
  run: (args: never, ctx: ToolContext) => Promise<string>
}

const MAX_MODEL_OUTPUT = 24_000

function cap(output: string) {
  if (output.length <= MAX_MODEL_OUTPUT) return output
  const head = Math.floor(MAX_MODEL_OUTPUT * 0.6)
  const tail = MAX_MODEL_OUTPUT - head
  return `${output.slice(0, head)}\n\n[... ${output.length - MAX_MODEL_OUTPUT} characters omitted ...]\n\n${output.slice(-tail)}`
}

function describeError(cause: unknown) {
  if (cause instanceof WorkspaceError) return cause.message
  if (cause instanceof Error) return cause.message
  return String(cause)
}

const ReadArgs = z.object({
  path: z.string().describe("File or directory path relative to the session workspace."),
  offset: z.number().int().min(1).optional().describe("1-based line (or directory entry) to start from."),
  limit: z.number().int().min(1).max(10_000).optional().describe(`Maximum lines or entries to return (default ${DEFAULT_READ_LIMIT}).`),
})

function stem(value: string) {
  const name = value.slice(value.lastIndexOf("/") + 1)
  const dot = name.lastIndexOf(".")
  return (dot > 0 ? name.slice(0, dot) : name).toLowerCase()
}

async function suggestPaths(workspace: string, target: string) {
  const separator = Math.max(target.lastIndexOf("/"), target.lastIndexOf("\\"))
  const directory = separator > 0 ? target.slice(0, separator) : workspace
  const base = target.slice(separator + 1)
  if (!base) return []
  const wanted = base.toLowerCase()
  const wantedStem = stem(base)
  try {
    const entries = await walk(directory, { maxDepth: 1, maxEntries: 5_000 })
    return entries
      .filter((entry) => !entry.directory)
      .map((entry) => entry.relativePath)
      .filter((item) => {
        const name = item.slice(item.lastIndexOf("/") + 1).toLowerCase()
        return name.includes(wanted) || wanted.includes(name) || stem(item).includes(wantedStem)
      })
      .slice(0, 3)
  } catch {
    return []
  }
}

const readTool: ToolDefinition = {
  name: "read",
  access: "read",
  mutating: false,
  description: `Read a file or directory from the session workspace. Files come back with a \`<path>\`, \`<type>\`, and \`<content>\` envelope and each line prefixed by \`1: \` style line numbers, so you can copy exact text straight into edit. Directories list one entry per line with a trailing \`/\` for subdirectories. Long lines are truncated at ${MAX_LINE_LENGTH} characters and output is capped at 50 KB, so a large file may come back partial with a note telling you the offset to continue from. Use grep to locate content inside large files, and glob to find filenames.`,
  parameters: ReadArgs,
  run: async (raw, ctx) => {
    const args = ReadArgs.parse(raw)
    const target = resolveInWorkspace(ctx.workspace, args.path)
    const shown = displayPath(ctx.workspace, target)
    const info = await statPath(target)

    if (info?.isDirectory()) {
      const entries = (await readdir(target, { withFileTypes: true }))
        .map((entry) => {
          if (entry.isDirectory()) return `${entry.name}/`
          if (entry.isSymbolicLink()) return entry.name
          return entry.name
        })
        .sort((left, right) => left.localeCompare(right))
      const offset = args.offset ?? 1
      const limit = args.limit ?? DEFAULT_READ_LIMIT
      const slice = entries.slice(offset - 1, offset - 1 + limit)
      if (entries.length === 0) return `<path>${shown}</path>\n<type>directory</type>\n<entries>\n(empty directory)\n</entries>`
      const truncated = offset - 1 + slice.length < entries.length
      return [
        `<path>${shown}</path>`,
        "<type>directory</type>",
        "<entries>",
        slice.join("\n"),
        truncated
          ? `\n(Showing ${slice.length} of ${entries.length} entries. Use 'offset' parameter to read beyond entry ${offset - 1 + slice.length})`
          : `\n(${entries.length} entries)`,
        "</entries>",
      ].join("\n")
    }

    if (!info) {
      const suggestions = await suggestPaths(ctx.workspace, target)
      const hint = suggestions.length > 0 ? `\n\nDid you mean one of these?\n${suggestions.join("\n")}` : ""
      throw new WorkspaceError(`File not found: ${shown}${hint}`)
    }

    if (isBinaryPath(target)) throw new WorkspaceError(`Cannot read binary file: ${shown}`)

    const content = await readTextFile(target)
    const offset = args.offset ?? 1
    const file = sliceLines(content, { offset, limit: args.limit ?? DEFAULT_READ_LIMIT })
    if (file.totalLines < offset && !(file.totalLines === 0 && offset === 1)) {
      throw new WorkspaceError(`Offset ${offset} is out of range for this file (${file.totalLines} lines)`)
    }

    const last = file.offset + file.raw.length - 1
    const next = last + 1
    let output = `<path>${shown}</path>\n<type>file</type>\n<content>\n`
    output += file.raw.map((line, index) => `${file.offset + index}: ${line}`).join("\n")
    if (file.cut) {
      output += `\n\n(Output capped at 50 KB. Showing lines ${file.offset}-${last}. Use offset=${next} to continue.)`
    } else if (file.more) {
      output += `\n\n(Showing lines ${file.offset}-${last} of ${file.totalLines}. Use offset=${next} to continue.)`
    } else {
      output += `\n\n(End of file - total ${file.totalLines} lines)`
    }
    output += "\n</content>"
    return output
  },
}

const WriteArgs = z.object({
  path: z.string().describe("File path relative to the session workspace. Parent directories are created automatically."),
  content: z.string().describe("Full new file content. Replaces the file if it already exists."),
})

const writeTool: ToolDefinition = {
  name: "write",
  access: "full",
  mutating: true,
  description: "Create a file or replace its entire content. Parent directories are created automatically. Read an existing file before overwriting it, and prefer edit for small changes. Never create documentation or README files unless the user asked for them.",
  parameters: WriteArgs,
  run: async (raw, ctx) => {
    const args = WriteArgs.parse(raw)
    const target = resolveInWorkspace(ctx.workspace, args.path)
    const shown = displayPath(ctx.workspace, target)
    const existing = await pathExists(target)
    const source = existing ? splitBom(await readTextFile(target)) : { bom: false, text: "" }
    const incoming = splitBom(args.content)
    // Keep whatever byte-order mark the file already had.
    const bom = source.bom || incoming.bom
    const previousLines = source.text.split("\n").length
    const nextLines = incoming.text.split("\n").length
    await writeTextFile(target, joinBom(incoming.text, bom))
    const delta = nextLines - previousLines
    const shape = existing
      ? `Replaced the file (${previousLines} -> ${nextLines} lines${delta === 0 ? "" : `, ${delta > 0 ? "+" : ""}${delta}`}).`
      : `Created the file (${nextLines} lines).`
    return `Wrote ${shown}. ${shape} Read it back to verify.`
  },
}

const EditArgs = z.object({
  path: z.string().describe("File path relative to the session workspace."),
  oldString: z.string().describe("The exact existing text to replace."),
  newString: z.string().describe("Replacement text, must differ from oldString."),
  replaceAll: z.boolean().optional().describe("Replace every occurrence instead of requiring a unique match."),
})

const editTool: ToolDefinition = {
  name: "edit",
  access: "full",
  mutating: true,
  description: `Replace text in an existing file. Copy oldString exactly from read output, keeping the indentation that appears after the \`1: \` line-number prefix. Matching is forgiving: if oldString is not found verbatim, progressively relaxed strategies are tried (line-trimmed, block anchors, whitespace-normalized, indentation-flexible, escape-normalized, trimmed boundaries, context-aware) so small whitespace or line-ending drift still lands. Fails if oldString matches nothing, or matches more than once without replaceAll. Line endings and the byte-order mark of the file are preserved.`,
  parameters: EditArgs,
  run: async (raw, ctx) => {
    const args = EditArgs.parse(raw)
    const target = resolveInWorkspace(ctx.workspace, args.path)
    const shown = displayPath(ctx.workspace, target)
    const info = await statPath(target)
    if (!info) throw new WorkspaceError(`File ${shown} not found. Read the file first to get its exact contents.`)
    if (info.isDirectory()) throw new WorkspaceError(`Path is a directory, not a file: ${shown}`)

    const source = splitBom(await readTextFile(target))
    const ending = detectLineEnding(source.text)
    const oldString = convertToLineEnding(args.oldString, ending)
    const newString = convertToLineEnding(args.newString, ending)

    const result = replaceText(source.text, oldString, newString, args.replaceAll === true)
    if (!result.ok) throw new WorkspaceError(result.message)

    await writeTextFile(target, joinBom(result.content, source.bom))
    const lines = result.content.split("\n").length
    const note = result.strategy === "exact"
      ? ""
      : ` Exact match failed; the edit landed via the ${result.strategy} strategy, so verify it is the span you intended.`
    return `${shown}: replaced ${result.occurrences} occurrence(s) using the ${result.strategy} strategy. File is now ${lines} lines.${note}`
  },
}

const GlobArgs = z.object({
  pattern: z.string().describe("Glob pattern such as **/*.ts, src/**/*.ts, or **/*.{ts,tsx}. Supports *, **, ?, [abc], and {a,b}."),
  path: z.string().optional().describe("Directory to search from, relative to the workspace. Defaults to the workspace root."),
  limit: z.number().int().min(1).max(2_000).optional().describe("Maximum number of paths to return (default 100)."),
})

const globTool: ToolDefinition = {
  name: "glob",
  access: "read",
  mutating: false,
  description: "Fast file pattern matching by name. Returns workspace-relative paths, sorted, capped at 100 with a truncation notice. Use it to find filenames; use grep to search inside them. Batch several speculative globs in one turn rather than looping.",
  parameters: GlobArgs,
  run: async (raw, ctx) => {
    const args = GlobArgs.parse(raw)
    const root = resolveInWorkspace(ctx.workspace, args.path)
    const info = await statPath(root)
    if (info?.isFile()) throw new WorkspaceError(`glob path must be a directory: ${args.path}`)
    const matchers = globMatchers(args.pattern)
    const limit = args.limit ?? 100
    const entries = await walk(root, { maxEntries: 50_000 })
    const matches = entries
      .filter((entry) => !entry.directory)
      .map((entry) => slashRelative(root, entry.path))
      .filter((path) => matchers.some((matcher) => matcher.test(path)))
      .sort()
    if (matches.length === 0) return `No files found for ${args.pattern} under ${args.path ?? "."}.`
    const truncated = matches.length > limit
    const output = [
      ...matches.slice(0, limit),
      ...(truncated ? ["", `(Results are truncated: showing the first ${limit} of ${matches.length} results. Use a more specific path or pattern.)`] : []),
    ]
    return output.join("\n")
  },
}

const GrepArgs = z.object({
  pattern: z.string().describe("JavaScript regular expression source, matched per line."),
  path: z.string().optional().describe("Directory or file to search, relative to the workspace. Defaults to the workspace root."),
  include: z.string().optional().describe("Only search paths matching this glob, for example **/*.ts."),
  outputMode: z.enum(["content", "files", "count"]).optional().describe("content (default) shows matching lines, files lists paths, count shows per-file counts."),
  caseInsensitive: z.boolean().optional(),
  limit: z.number().int().min(1).max(2_000).optional().describe("Maximum number of result lines (default 200)."),
})

const grepTool: ToolDefinition = {
  name: "grep",
  access: "read",
  mutating: false,
  description: "Search file contents with a regular expression. Output is grouped by file with line numbers. Supports content, files, and count modes, an include glob, and case-insensitive matching. Skips binary files and dependency directories. Capped at 100 results with a truncation notice.",
  parameters: GrepArgs,
  run: async (raw, ctx) => {
    const args = GrepArgs.parse(raw)
    const root = resolveInWorkspace(ctx.workspace, args.path)
    const flags = args.caseInsensitive === true ? "i" : ""
    let matcher: RegExp
    try {
      matcher = new RegExp(args.pattern, flags)
    } catch (cause) {
      throw new WorkspaceError(`Invalid regular expression: ${describeError(cause)}`)
    }
    const includeMatchers = args.include ? globMatchers(args.include) : undefined
    const limit = args.limit ?? 100
    const mode = args.outputMode ?? "content"
    const entries = (await walk(root, { maxEntries: 50_000 })).filter((entry) => !entry.directory && entry.size <= 4_000_000)
    const counts = new Map<string, number>()
    const groups: Array<{ path: string; rows: Array<{ line: number; text: string }> }> = []
    let scanned = 0
    let total = 0

    for (const entry of entries) {
      if (ctx.signal.aborted) break
      if (includeMatchers && !includeMatchers.some((item) => item.test(entry.relativePath))) continue
      let content: string
      try {
        content = await readTextFile(entry.path, 4_000_000)
      } catch {
        continue
      }
      scanned++
      const lines = content.split("\n")
      const rows: Array<{ line: number; text: string }> = []
      let hits = 0
      for (let index = 0; index < lines.length; index++) {
        if (!matcher.test(lines[index]!)) continue
        hits++
        total++
        if (mode === "content" && rows.length < limit) rows.push({ line: index + 1, text: lines[index]!.slice(0, 400) })
      }
      if (hits > 0) counts.set(entry.relativePath, hits)
      if (mode === "content" && rows.length > 0) groups.push({ path: entry.relativePath, rows })
      if (mode === "content" && groups.reduce((sum, group) => sum + group.rows.length, 0) >= limit) break
    }

    if (mode === "files") {
      const list = [...counts.keys()].sort()
      if (list.length === 0) return `No files contain a match for /${args.pattern}/${flags ? "i" : ""} in ${scanned} scanned file(s).`
      return [
        `Found ${list.length} file(s) matching /${args.pattern}/${flags ? "i" : ""}:`,
        ...list.slice(0, limit).map((item) => `  ${item}`),
        ...(list.length > limit ? ["", `(Results are truncated: showing the first ${limit} of ${list.length} files.)`] : []),
      ].join("\n")
    }

    if (mode === "count") {
      const list = [...counts.entries()].sort((left, right) => right[1] - left[1])
      if (list.length === 0) return `No matches for /${args.pattern}/${flags ? "i" : ""} in ${scanned} scanned file(s).`
      return list.map(([item, count]) => `${count}\t${item}`).join("\n")
    }

    if (groups.length === 0) return `No matches for /${args.pattern}/${flags ? "i" : ""} in ${scanned} scanned file(s).`

    const shown = groups.reduce((sum, group) => sum + group.rows.length, 0)
    const output = [`Found ${total} match${total === 1 ? "" : "es"}${total > shown ? " (more matches available)" : ""} in ${scanned} scanned file(s):`, ""]
    for (const group of groups) {
      output.push(`${group.path}:`)
      for (const row of group.rows) output.push(`  Line ${row.line}: ${row.text}`)
      output.push("")
    }
    if (total > shown) {
      output.push(`(Results are truncated: showing the first ${shown} of ${total} matches. Use a more specific path or pattern.)`)
    }
    return output.join("\n")
  },
}

const ListArgs = z.object({
  path: z.string().optional().describe("Directory relative to the workspace. Defaults to the workspace root."),
  depth: z.number().int().min(1).max(5).optional().describe("Recursion depth (default 1)."),
})

const listTool: ToolDefinition = {
  name: "list",
  access: "read",
  mutating: false,
  description: "List a directory in the session workspace with entry type, size, and modification time. Dependency and build directories are hidden. Use read on a directory for a plain entry list, or depth 2 here to see nested contents.",
  parameters: ListArgs,
  run: async (raw, ctx) => {
    const args = ListArgs.parse(raw)
    const root = resolveInWorkspace(ctx.workspace, args.path)
    const depth = args.depth ?? 1
    const entries = await walk(root, { maxDepth: depth, includeDirectories: true, maxEntries: 5_000 })
    if (entries.length === 0) return `${args.path ?? "."} is empty or contains only ignored directories.`
    const lines = entries
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
      .map((entry) => entry.directory
        ? `${entry.relativePath}/`
        : `${entry.relativePath}  ${formatSize(entry.size)}  ${new Date(entry.modifiedAt).toISOString().slice(0, 16).replace("T", " ")}`)
    return `${args.path ?? "."} (${entries.length} entries, depth ${depth}):\n${lines.join("\n")}`
  },
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const BashArgs = z.object({
  command: z.string().describe("Shell command to run."),
  workdir: z.string().optional().describe("Directory relative to the session workspace to run in (default: the workspace root). Each call starts a fresh shell, so use this instead of cd."),
  timeout: z.number().int().min(1_000).max(600_000).optional().describe("Timeout in milliseconds (default 120000, maximum 600000)."),
})

const bashTool: ToolDefinition = {
  name: "bash",
  access: "full",
  mutating: true,
  description: "Run a shell command and return its combined output and exit status. Two safety layers apply: a deny list refuses destructive system commands, and every path the command mentions is checked against the workspace boundary. Output beyond the first 60000 characters is written to a file whose path is reported in the output; read that file for the rest. Prefer the dedicated file tools for reads and edits.",
  parameters: BashArgs,
  run: async (raw, ctx) => {
    const args = BashArgs.parse(raw)
    const verdict = checkCommand(args.command)
    if (!verdict.allowed) return `Command refused by the Argus safety policy (${verdict.reason}). Rewrite the command to stay inside the workspace.`
    const scan = scanCommandPaths(args.command, ctx.workspace)
    if (scan.violations.length > 0) {
      return `Command refused: it reaches outside the session workspace (${scan.violations.join(", ")}). Every tool is confined to ${ctx.workspace}, so the shell is too. Copy the needed file into the workspace with write, or work from a relative path.`
    }
    let cwd = ctx.workspace
    if (args.workdir) {
      const resolved = resolveInWorkspace(ctx.workspace, args.workdir)
      if (!resolved) return `Command refused: workdir ${args.workdir} is outside the session workspace (${ctx.workspace}).`
      cwd = resolved
    }
    const timeout = Math.min(args.timeout ?? 120_000, 600_000)
    const result = await runShell({
      command: args.command,
      cwd,
      timeoutMs: timeout,
      signal: ctx.signal,
      env: { ARGUS_SESSION_ID: ctx.sessionId, ARGUS_WORKSPACE: ctx.workspace },
    })
    const status = result.exitCode === null
      ? result.timedOut ? `terminated (timed out after ${timeout}ms, no exit status)` : "terminated (aborted, no exit status)"
      : `exit ${result.exitCode}`
    const header = `${status} · ${result.durationMs}ms${result.truncated ? " · output truncated" : ""}`
    return cap(result.output.length > 0 ? `${header}\n${result.output}` : `${header}\n(no output)`)
  },
}

const WebSearchArgs = z.object({
  query: z.string().describe("Search query. Include the current year when you need recent information."),
  maxResults: z.number().int().min(1).max(20).optional().describe("Number of results (default 5)."),
  type: z.enum(["auto", "fast", "deep"]).optional().describe("Search depth (default auto)."),
  livecrawl: z.enum(["fallback", "preferred"]).optional().describe("Prefer live page content over cache (default fallback)."),
  contextMaxCharacters: z.number().int().min(500).max(200_000).optional().describe("Maximum characters of page context to return (default 10000)."),
})

const websearchTool: ToolDefinition = {
  name: "websearch",
  access: "read",
  mutating: false,
  description: "Search the public web and return each result's title, URL, and page content, so you can cite a source without a separate fetch. Cite the URL of anything you rely on, and use webfetch when you need a page the search did not return.",
  parameters: WebSearchArgs,
  run: async (raw) => {
    const args = WebSearchArgs.parse(raw)
    const outcome = await searchWeb({
      query: args.query,
      limit: args.maxResults ?? 5,
      ...(args.type ? { type: args.type } : {}),
      ...(args.livecrawl ? { livecrawl: args.livecrawl } : {}),
      ...(args.contextMaxCharacters ? { contextMaxCharacters: args.contextMaxCharacters } : {}),
    })
    if (outcome.results.length === 0) {
      const tried = outcome.attempts.map((item) => `${item.provider}${item.error ? ` (${item.error})` : ""}`).join(", ")
      return `No results for "${args.query}". Providers tried: ${tried}. Try different keywords or use webfetch on a specific URL.`
    }
    const index = outcome.results
      .map((result, at) => [
        `${at + 1}. ${result.title}`,
        `   URL: ${result.url}`,
        result.snippet ? `   ${result.snippet}` : "",
      ].filter(Boolean).join("\n"))
      .join("\n\n")
    return `Web search for "${args.query}" via ${outcome.provider}, ${outcome.results.length} result(s):\n\n${index}`
  },
}

const WebFetchArgs = z.object({
  url: z.string().describe("Fully formed http or https URL."),
  format: z.enum(["markdown", "text", "html"]).optional().describe("Output format (default markdown). HTML is converted to Markdown."),
  maxChars: z.number().int().min(500).max(200_000).optional().describe("Maximum characters of page text to return (default 20000)."),
  timeout: z.number().int().min(1_000).max(120_000).optional().describe("Timeout in milliseconds (default 30000, maximum 120000)."),
})

const webfetchTool: ToolDefinition = {
  name: "webfetch",
  access: "read",
  mutating: false,
  description: "Fetch a URL and return its content as Markdown, plain text, or raw HTML. Read-only; it never writes files. Use it on a specific URL when websearch did not return the page content.",
  parameters: WebFetchArgs,
  run: async (raw) => {
    const args = WebFetchArgs.parse(raw)
    const page = await fetchPage(args.url, args.maxChars ?? 20_000, {
      ...(args.format ? { format: args.format } : {}),
      ...(args.timeout ? { timeoutMs: args.timeout } : {}),
    })
    return cap(`${page.url} (HTTP ${page.status}, ${page.contentType || "unknown type"})\n\n${page.body}`)
  },
}

const PatchArgs = z.object({
  patchText: z.string().describe("The full patch text describing every change to apply."),
})

const patchTool: ToolDefinition = {
  name: "apply_patch",
  access: "full",
  mutating: true,
  description: `Apply a multi-file patch in one atomic call. Use this instead of many edit calls when a change spans several files, or when you want the whole change to fail together if any hunk does not apply.

Format:
\`\`\`
*** Begin Patch
*** Add File: new.txt
+every line is prefixed with +
*** Update File: existing.txt
*** Move to: renamed.txt
@@ optional context anchor
 unchanged line
-removed line
+added line
*** Delete File: obsolete.txt
*** End Patch
\`\`\`
Within Update File, prefix context with a space, removals with -, and additions with +. An \`@@\` line names a function or section as a human-readable anchor. Every file is verified before anything is written, so a bad hunk changes nothing.`,
  parameters: PatchArgs,
  run: async (raw, ctx) => {
    const args = PatchArgs.parse(raw)
    const result = await applyPatchText({
      patchText: args.patchText,
      workspace: ctx.workspace,
      readFile: (absolute) => readTextFile(absolute),
      fileExists: pathExists,
    })
    return summarizePatch(result)
  },
}

const QuestionArgs = z.object({
  question: z.string().min(1).describe("The single question the user should answer."),
  options: z.array(z.string()).optional().describe("Up to four short answer options."),
})

const questionTool: ToolDefinition = {
  name: "question",
  access: "read",
  mutating: false,
  description: "Surface a blocking ambiguity to the user. The run is not paused, so state the assumption you will proceed under and keep working.",
  parameters: QuestionArgs,
  run: async (raw, ctx) => {
    const args = QuestionArgs.parse(raw)
    ctx.onQuestion(args.question, args.options ?? [])
    return "The question has been shown to the user, but the run continues without waiting for an answer. State your working assumption explicitly in your next sentence and proceed."
  },
}

export const toolDefinitions: ToolDefinition[] = [
  readTool, writeTool, editTool, globTool, grepTool, listTool, bashTool, websearchTool, webfetchTool, patchTool, questionTool,
]

export function toolDescriptors(): ToolDescriptor[] {
  return toolDefinitions.map((definition) => ({
    name: definition.name,
    description: definition.description,
    access: definition.access,
    mutating: definition.mutating,
  }))
}

export function allowedToolNames(access: ToolAccess) {
  if (access === "off") return new Set<ToolName>()
  if (access === "read") return new Set(toolDefinitions.filter((definition) => definition.access === "read").map((definition) => definition.name))
  return new Set(toolDefinitions.map((definition) => definition.name))
}

const WORKSPACE_HINT = "All relative paths resolve inside this session workspace, which is the agent's only writable location: "

function describe(definition: ToolDefinition, ctx: ToolContext) {
  if (["read", "write", "edit", "glob", "grep", "list"].includes(definition.name)) {
    return `${definition.description}\n\n${WORKSPACE_HINT}${ctx.workspace}`
  }
  if (definition.name === "bash") {
    return `${definition.description}\n\n${shellSyntaxHint()}\n\nThe working directory is ${ctx.workspace}.`
  }
  return definition.description
}

export interface ToolsetEntry {
  description: string
  parameters: z.ZodTypeAny
  execute: (args: unknown, options: { toolCallId?: string; abortSignal?: AbortSignal }) => Promise<string>
}

export function buildToolset(ctx: ToolContext): Record<string, ToolsetEntry> {
  const allowed = allowedToolNames(ctx.access)
  const toolset: Record<string, ToolsetEntry> = {}
  for (const definition of toolDefinitions) {
    if (!allowed.has(definition.name)) continue
    toolset[definition.name] = {
      description: describe(definition, ctx),
      parameters: definition.parameters,
      execute: async (raw, options) => {
        const id = options?.toolCallId ?? crypto.randomUUID()
        const startedAt = Date.now()
        const base: ToolInvocation = {
          id,
          name: definition.name,
          state: "running",
          arguments: {},
          title: definition.name,
          output: "",
          startedAt,
        }
        let parsed = definition.parameters.safeParse(raw ?? {})
        if (!parsed.success) {
          const repaired = coerceForSchema(raw ?? {}, definition.parameters)
          if (repaired !== (raw ?? {})) parsed = definition.parameters.safeParse(repaired)
        }
        if (!parsed.success) {
          const detail = parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`)
            .join("; ")
          ctx.onUpdate({ ...base, arguments: safeArguments(raw), state: "failed", error: `Invalid arguments: ${detail}`, endedAt: Date.now() })
          return `Tool error: invalid arguments for ${definition.name}. ${detail}. Call ${definition.name} again with every required field present and correctly typed${requiredHint(definition)}.`
        }
        const args = parsed.data as Record<string, unknown>
        const title = toolTitle(definition.name, args)
        ctx.onUpdate({ ...base, title, arguments: args as ToolInvocation["arguments"] })
        const signal = options?.abortSignal ?? ctx.signal
        if (signal.aborted) {
          ctx.onUpdate({ ...base, title, state: "failed", error: "Aborted", endedAt: Date.now() })
          throw new DOMException("Tool call aborted", "AbortError")
        }
        try {
          const output = await definition.run(args as never, ctx)
          ctx.onUpdate({ ...base, title, state: "completed", output: cap(output), endedAt: Date.now() })
          return output
        } catch (cause) {
          if (signal.aborted) {
            ctx.onUpdate({ ...base, title, state: "failed", error: "Aborted", endedAt: Date.now() })
            throw cause
          }
          const message = describeError(cause)
          ctx.onUpdate({ ...base, title, state: "failed", error: message, endedAt: Date.now() })
          return `Tool error: ${message}`
        }
      },
    }
  }
  return toolset
}

function schemaType(schema: unknown): string | undefined {
  return (schema as { _zod?: { def?: { type?: string } } })._zod?.def?.type
}

/** Look through optional/nullable/default wrappers to the schema that actually carries the shape. */
function effectiveSchema(schema: unknown): { type?: string | undefined; shape?: Record<string, unknown> | undefined } {
  let current = schema as { _zod?: { def?: { type?: string; innerType?: unknown; shape?: Record<string, unknown> } } }
  for (let depth = 0; depth < 6; depth++) {
    const type = current?._zod?.def?.type
    if (type === "optional" || type === "nullable" || type === "default" || type === "nonoptional" || type === "prefault") {
      const inner = current._zod?.def?.innerType
      if (!inner) return { type }
      current = inner as typeof current
      continue
    }
    return { type, shape: current?._zod?.def?.shape }
  }
  return {}
}

function tryParseJson(value: string) {
  const trimmed = value.trim()
  const looksJson = (trimmed.startsWith("[") && trimmed.endsWith("]"))
    || (trimmed.startsWith("{") && trimmed.endsWith("}"))
  if (!looksJson) return undefined
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return undefined
  }
}

/**
 * Second-chance argument repair, applied only after plain validation fails and only to
 * fields the schema declares as arrays or objects. Some providers send those as a JSON
 * string. String fields are never touched, so file content that happens to be JSON survives.
 */
function coerceForSchema(value: unknown, schema: unknown): unknown {
  const { type, shape } = effectiveSchema(schema)
  if (type === "array" && typeof value === "string") return tryParseJson(value) ?? value
  if (type !== "object" || !shape || !value || typeof value !== "object" || Array.isArray(value)) return value
  const out: Record<string, unknown> = {}
  let changed = false
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!(key in shape)) {
      out[key] = item
      continue
    }
    const next = coerceForSchema(item, shape[key])
    if (next !== item) changed = true
    out[key] = next
  }
  return changed ? out : value
}

/** Keep whatever the model actually sent, so a rejected call is diagnosable. */
function safeArguments(raw: unknown): ToolInvocation["arguments"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const out: ToolInvocation["arguments"] = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === undefined) continue
    try {
      out[key] = JSON.parse(JSON.stringify(value)) as never
    } catch {
      out[key] = String(value)
    }
  }
  return out
}

function requiredHint(definition: ToolDefinition) {
  const shape = effectiveSchema(definition.parameters).shape
  if (!shape) return ""
  const rendered = Object.entries(shape).map(([key, schema]) => {
    const optional = schemaType(schema) === "optional"
    return `${key}${optional ? "?" : ""}: ${describeType(schema)}`
  })
  return rendered.length > 0 ? ` (${rendered.join(", ")})` : ""
}

function describeType(schema: unknown): string {
  const type = effectiveSchema(schema).type
  if (type === "string") return "string"
  if (type === "number") return "number"
  if (type === "boolean") return "boolean"
  if (type === "array") return "array"
  if (type === "object") return "object"
  if (type === "enum") return "one of the allowed values"
  return "value"
}

function toolTitle(name: ToolName, args: Record<string, unknown>) {
  const text = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : undefined)
  switch (name) {
    case "read": return `read ${text("path") ?? ""}`.trim()
    case "write": return `write ${text("path") ?? ""}`.trim()
    case "edit": return `edit ${text("path") ?? ""}`.trim()
    case "apply_patch": return "apply_patch"
    case "glob": return `glob ${text("pattern") ?? ""}`.trim()
    case "grep": return `grep ${text("pattern") ?? ""}`.trim()
    case "list": return `list ${text("path") ?? "."}`.trim()
    case "bash": return (text("command") ?? "bash").slice(0, 160)
    case "websearch": return `search ${text("query") ?? ""}`.trim()
    case "webfetch": return `fetch ${text("url") ?? ""}`.trim()
    case "question": return (text("question") ?? "question").slice(0, 160)
  }
  return name
}
