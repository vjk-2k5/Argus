import { existsSync } from "node:fs"
import { mkdir, open } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { sessionsRoot } from "./fs"

const DESTRUCTIVE: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /:\s*\(\s*\)\s*\{.*\}\s*;\s*:/, reason: "fork bomb" },
  { pattern: /:\(\)\{\s*:\|:&\s*\};:/, reason: "fork bomb" },
  {
    pattern: /(?:\brm\b|\bdel\b|\bRemove-Item\b|\brmdir\b|\brd\b|\bmv\b|\bmove\b|\bcp\b|\bcopy\b)[^\n]*?(?:^|\s)(?:~|\$HOME|[a-zA-Z]:\\?|\/)\s*$/i,
    reason: "recursive delete, move, or copy of a home, drive root, or filesystem root",
  },
  { pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+\/(?!\w)/, reason: "recursive delete at the filesystem root" },
  { pattern: /\brm\s+-rf?\s+\/(etc|usr|var|boot|bin|sbin|lib|opt|System)\b/i, reason: "recursive delete of a system path" },
  { pattern: /\bformat\s+[a-zA-Z]:/i, reason: "formatting a drive" },
  { pattern: /\bmkfs\b|\bdiskpart\b|\bfdisk\b/i, reason: "raw disk operation" },
  { pattern: /\bdd\s+[^\n]*of=\/dev\//i, reason: "raw device write" },
  { pattern: />\s*\/dev\/[sh]d[a-z]/i, reason: "raw device write" },
  { pattern: /\b(shutdown|reboot|halt|poweroff|stop-computer)\b/i, reason: "host power or shutdown command" },
  { pattern: /\bRemove-Item\b[^\n]*\bC:\\Windows\b[^\n]*-Recurse/i, reason: "recursive delete inside a system path" },
  { pattern: /\bDROP\s+(DATABASE|SCHEMA|TABLE)\b/i, reason: "destructive SQL statement" },
  { pattern: /\bTRUNCATE\s+TABLE\b/i, reason: "destructive SQL statement" },
  { pattern: /\bDELETE\s+FROM\s+\w+\s*(;|$)/i, reason: "unbounded SQL delete" },
  { pattern: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|k)?sh\b/i, reason: "piping a download straight into a shell" },
  { pattern: /\biex\b|\bInvoke-Expression\b|\beval\s+["'$]/i, reason: "dynamic code evaluation" },
  { pattern: /\breg\s+delete\b|\bregedit\b/i, reason: "registry modification" },
  { pattern: /\btakeown\b|\bicacls\b|\bcacls\b|\battrib\b/i, reason: "permission or attribute tampering" },
  { pattern: /\bcipher\s+\/w|\bbcdedit\b|\bSet-ExecutionPolicy\b/i, reason: "secure-boot or execution-policy tampering" },
  { pattern: /\bnetsh\s+advfirewall\b|\bSet-NetFirewallProfile\b/i, reason: "firewall reconfiguration" },
  { pattern: /\bhistory\s+-c\b|\bClear-Content\b[^\n]*history/i, reason: "shell history tampering" },
]

const PROTECTED_PATH = /\bC:\\Windows\b|\bC:\\Program Files|\bC:\\ProgramData\b|\/etc\/|\/boot\/|\/usr\/(bin|sbin)\/|\/bin\/|\/sbin\/|\/var\/lib\//i
const MUTATION = /\brm\b|\bdel\b|\brmdir\b|\bRemove-Item\b|\bmv\b|\bmove\b|\bcp\b|\bcopy\b|chmod|chown|takeown|icacls|>\s*|Set-Content|Add-Content|Out-File|New-Item|tee\b/i

export interface CommandVerdict {
  allowed: boolean
  reason?: string
}

export function checkCommand(command: string): CommandVerdict {
  const trimmed = command.trim()
  if (!trimmed) return { allowed: false, reason: "empty command" }
  for (const rule of DESTRUCTIVE) {
    if (rule.pattern.test(trimmed)) return { allowed: false, reason: `blocked: ${rule.reason}` }
  }
  if (PROTECTED_PATH.test(trimmed) && MUTATION.test(trimmed)) {
    return { allowed: false, reason: "blocked: modifying a protected system path" }
  }
  return { allowed: true }
}

export interface ShellResult {
  /** Null when the command was terminated by a timeout or an abort rather than exiting on its own. */
  exitCode: number | null
  output: string
  truncated: boolean
  /** Set when output overflowed the in-memory budget and the full stream was written here. */
  outputPath?: string
  timedOut: boolean
  aborted: boolean
  durationMs: number
}

const DEFAULT_MAX_OUTPUT = 60_000
const TEARDOWN_GRACE_MS = 3_000

type ShellKind = "powershell" | "posix" | "cmd"

interface ShellSpec {
  name: string
  kind: ShellKind
  executable: string
  legacy: boolean
}

let cachedShell: ShellSpec | undefined

/**
 * Git Bash ships inside the Git for Windows install rather than on PATH, so it is located
 * relative to `git.exe`. It matters because models write POSIX shell syntax by default, and
 * Windows PowerShell rejects `&&`, `||`, and most pipelines.
 */
function gitBash(): string | undefined {
  if (process.platform !== "win32") return undefined
  const override = process.env.ARGUS_GIT_BASH_PATH?.trim()
  if (override) return override
  const git = Bun.which("git")
  if (!git) return undefined
  const candidate = join(dirname(git), "..", "..", "bin", "bash.exe")
  return existsSync(candidate) ? candidate : undefined
}

function detectShell(): ShellSpec {
  const override = process.env.ARGUS_SHELL?.trim()
  if (override) {
    const resolved = Bun.which(override) ?? (existsSync(override) ? override : undefined)
    if (resolved) {
      const base = basename(resolved).toLowerCase()
      return base.startsWith("pwsh") || base.startsWith("powershell")
        ? { name: basename(resolved), kind: "powershell", executable: resolved, legacy: base.startsWith("powershell") && !base.startsWith("pwsh") }
        : base === "cmd.exe" || base === "cmd"
          ? { name: "cmd.exe", kind: "cmd", executable: resolved, legacy: false }
          : { name: basename(resolved), kind: "posix", executable: resolved, legacy: false }
    }
  }
  if (process.platform !== "win32") {
    const preferred = process.env.SHELL?.trim()
    const bash = Bun.which("bash") ?? "/bin/bash"
    return preferred && existsSync(preferred)
      ? { name: basename(preferred), kind: "posix", executable: preferred, legacy: false }
      : { name: "bash", kind: "posix", executable: bash, legacy: false }
  }
  const pwsh = Bun.which("pwsh")
  if (pwsh) return { name: "PowerShell 7", kind: "powershell", executable: pwsh, legacy: false }
  const windowsPowerShell = Bun.which("powershell.exe") ?? Bun.which("powershell")
  if (windowsPowerShell) return { name: "Windows PowerShell 5.1", kind: "powershell", executable: windowsPowerShell, legacy: true }
  const bash = gitBash()
  if (bash) return { name: "Git Bash", kind: "posix", executable: bash, legacy: false }
  const comspec = process.env.COMSPEC?.trim() || "cmd.exe"
  return { name: "cmd.exe", kind: "cmd", executable: comspec, legacy: false }
}

export function shellSpec(): ShellSpec {
  cachedShell ??= detectShell()
  return cachedShell
}

export function shellName() {
  return shellSpec().name
}

function shellArgv(spec: ShellSpec, command: string): string[] {
  if (spec.kind === "powershell") {
    return [spec.executable, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]
  }
  if (spec.kind === "posix") return [spec.executable, "-lc", command]
  return [spec.executable, "/d", "/s", "/c", command]
}

/** One line the model can act on, tailored to the shell that actually ran the command. */
export function shellSyntaxHint() {
  const spec = shellSpec()
  if (spec.kind === "posix") {
    return `Shell: ${spec.name}. POSIX syntax is available, including && , || , pipes, and redirection. Each call starts a fresh shell, so cd and exported variables do not carry over between calls; pass a workdir instead.`
  }
  if (spec.kind === "cmd") {
    return `Shell: ${spec.name}. Use cmd.exe syntax, not bash: dir instead of ls, type instead of cat, and %VAR% instead of $VAR. Each call starts a fresh shell, so cd does not carry over; pass a workdir instead.`
  }
  return `Shell: ${spec.name}. PowerShell syntax, not bash: Get-ChildItem instead of ls, Get-Content instead of cat, $env:VAR instead of $VAR. Each call starts a fresh shell, so cd does not carry over; pass a workdir instead.`
}

/**
 * Consumes a stream to completion while keeping only `budget` bytes in memory and spilling the
 * rest to disk.
 *
 * The read loop must never stop early. A child that writes more than the OS pipe buffer holds
 * blocks on write forever, so abandoning the stream deadlocks the child: it never exits, and the
 * runner then reports a synthetic failure for a command that actually succeeded. Reading to the
 * end and discarding (or spilling) the overflow is what keeps the exit code truthful.
 */
class OutputSink {
  private kept: Uint8Array[] = []
  private keptBytes = 0
  private file: FileHandle | undefined
  private filePath: string | undefined
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly budget: number) {}

  push(chunk: Uint8Array) {
    this.queue = this.queue.then(() => this.write(chunk)).catch(() => undefined)
    return this.queue
  }

  private async write(chunk: Uint8Array) {
    if (this.file) {
      await this.file.write(chunk)
      return
    }
    if (this.keptBytes + chunk.byteLength <= this.budget) {
      this.kept.push(chunk)
      this.keptBytes += chunk.byteLength
      return
    }
    // Past the budget: open the spill file, seed it with what was already captured so the file
    // holds the complete stream, and send everything after it to disk.
    try {
      const spill = await openSpill()
      this.file = spill.handle
      this.filePath = spill.path
      for (const earlier of this.kept) await this.file.write(earlier)
      await this.file.write(chunk)
      this.kept = []
    } catch {
      // Without a spill file the overflow is dropped, but the read still completes.
    }
  }

  async close() {
    await this.queue
    try {
      await this.file?.close()
    } catch {
      // Already closed.
    }
    const merged = new Uint8Array(this.keptBytes)
    let offset = 0
    for (const chunk of this.kept) {
      merged.set(chunk, offset)
      offset += chunk.byteLength
    }
    return {
      text: new TextDecoder("utf-8", { fatal: false }).decode(merged),
      outputPath: this.filePath,
    }
  }
}

function spillDirectory() {
  return process.env.ARGUS_TRUNCATION_DIR?.trim() || join(sessionsRoot(), ".truncations")
}

async function openSpill() {
  const directory = spillDirectory()
  await mkdir(directory, { recursive: true })
  const path = join(directory, `shell-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.log`)
  return { handle: await open(path, "w"), path }
}

export async function runShell(input: {
  command: string
  cwd: string
  timeoutMs: number
  signal: AbortSignal
  maxOutput?: number
  env?: Record<string, string>
}): Promise<ShellResult> {
  const started = Date.now()
  const spec = shellSpec()
  const cmd = shellArgv(spec, input.command)
  const maxOutput = input.maxOutput ?? DEFAULT_MAX_OUTPUT

  const child = Bun.spawn({
    cmd,
    cwd: input.cwd,
    env: { ...process.env, ...input.env, ARGUS_SHELL: spec.name },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })

  let timedOut = false
  let aborted = false
  let killed: Promise<void> | undefined

  // Killing only the shell leaves grandchildren holding the pipes open, so the read below would
  // never finish. Take down the whole tree, and await it so the exit status is settled before the
  // result is reported.
  const killTree = () => {
    killed ??= (async () => {
      if (process.platform === "win32") {
        try {
          const killer = Bun.spawn({
            cmd: ["taskkill", "/F", "/T", "/PID", String(child.pid)],
            stdout: "ignore",
            stderr: "ignore",
            windowsHide: true,
          })
          await killer.exited
          return
        } catch {
          // Fall through to a direct kill.
        }
      }
      try {
        child.kill()
      } catch {
        // The process already exited.
      }
    })()
    return killed
  }

  const timer = setTimeout(() => {
    timedOut = true
    void killTree()
  }, input.timeoutMs)
  const onAbort = () => {
    aborted = true
    void killTree()
  }
  input.signal.addEventListener("abort", onAbort, { once: true })

  const deadline = async <T>(work: Promise<T>) => {
    let handle: Timer | undefined
    const expiry = new Promise<undefined>((resolve) => {
      handle = setTimeout(() => resolve(undefined), TEARDOWN_GRACE_MS)
    })
    try {
      return await Promise.race([work, expiry])
    } finally {
      if (handle) clearTimeout(handle)
    }
  }

  // stdout and stderr share one sink so the spill file holds both streams in arrival order.
  const sink = new OutputSink(maxOutput)
  const drain = async (stream: ReadableStream<Uint8Array> | undefined) => {
    if (!stream) return
    const reader = stream.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value || value.byteLength === 0) continue
        await sink.push(value)
      }
    } finally {
      reader.releaseLock()
    }
  }

  try {
    await Promise.all([
      drain(child.stdout as ReadableStream<Uint8Array>),
      drain(child.stderr as ReadableStream<Uint8Array>),
    ])
    const settled = await deadline(child.exited)
    await killed
    const { text, outputPath } = await sink.close()

    let output = text
    let truncated = Boolean(outputPath)
    if (outputPath) {
      output = `${output}\n[output truncated at ${maxOutput} characters. Full output saved to ${outputPath}]`
    }
    // A terminated command has no exit status of its own, so report null rather than inventing one.
    const terminated = timedOut || aborted || settled === undefined
    const exitCode = terminated ? null : settled
    if (timedOut) {
      output = `${output}\n[command timed out after ${input.timeoutMs}ms and was terminated. If it was not waiting for interactive input, retry with a larger timeout]`
    }
    if (aborted) output = `${output}\n[command was aborted]`
    return {
      exitCode,
      output: output.trim(),
      truncated,
      ...(outputPath ? { outputPath } : {}),
      timedOut,
      aborted,
      durationMs: Date.now() - started,
    }
  } finally {
    clearTimeout(timer)
    input.signal.removeEventListener("abort", onAbort)
  }
}
