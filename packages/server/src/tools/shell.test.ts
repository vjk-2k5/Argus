import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkCommand, runShell, shellSpec } from "./shell"

const spillDir = await mkdtemp(join(tmpdir(), "argus-shell-test-"))
process.env.ARGUS_TRUNCATION_DIR = spillDir

afterAll(async () => {
  delete process.env.ARGUS_TRUNCATION_DIR
  await rm(spillDir, { recursive: true, force: true })
})

const powershell = shellSpec().kind === "powershell"
/** Enough lines to overflow a small budget, spelled for whichever shell is actually in use. */
function lines(count: number, pad = "padding-padding-padding") {
  return powershell
    ? `1..${count} | ForEach-Object { "line $_ ${pad}" }`
    : `for i in $(seq 1 ${count}); do echo "line $i ${pad}"; done`
}

function run(command: string, overrides: Partial<Parameters<typeof runShell>[0]> = {}) {
  return runShell({
    command,
    cwd: process.cwd(),
    timeoutMs: 60_000,
    signal: new AbortController().signal,
    ...overrides,
  })
}

describe("shell exit statuses", () => {
  test("a successful command reports its real exit code", async () => {
    const result = await run(powershell ? "Write-Output done" : "echo done")
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.aborted).toBe(false)
  })

  test("a failing command reports its real exit code", async () => {
    const result = await run("exit 7")
    expect(result.exitCode).toBe(7)
  })

  /**
   * Regression: the reader used to stop at the output budget, which left the child blocked on a
   * full pipe so it never exited and the runner reported -1 for a command that had succeeded.
   */
  test("output past the budget still reports the real exit code", async () => {
    const result = await run(lines(400), { maxOutput: 500 })
    expect(result.exitCode).toBe(0)
    expect(result.exitCode).not.toBe(-1)
    expect(result.truncated).toBe(true)
    expect(result.outputPath).toBeDefined()
  })

  test("the spill file holds the whole stream, not just the retained prefix", async () => {
    const result = await run(lines(400), { maxOutput: 500 })
    const spilled = await readFile(result.outputPath!, "utf8")
    expect(spilled).toContain("line 1 ")
    expect(spilled.trimEnd()).toEndWith("line 400 padding-padding-padding")
  })

  test("a timeout terminates without inventing an exit code", async () => {
    const result = await run(powershell ? "Start-Sleep -Seconds 30" : "sleep 30", { timeoutMs: 1_000 })
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBeNull()
    expect(result.output).toContain("retry with a larger timeout")
  })

  test("an abort terminates without inventing an exit code", async () => {
    const controller = new AbortController()
    const pending = runShell({
      command: powershell ? "Start-Sleep -Seconds 30" : "sleep 30",
      cwd: process.cwd(),
      timeoutMs: 60_000,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 500)
    const result = await pending
    expect(result.aborted).toBe(true)
    expect(result.exitCode).toBeNull()
  })
})

describe("command policy", () => {
  test("destructive commands stay refused", () => {
    expect(checkCommand("rm -rf /").allowed).toBe(false)
    expect(checkCommand("format c:").allowed).toBe(false)
    expect(checkCommand("   ").allowed).toBe(false)
  })

  test("ordinary commands stay allowed", () => {
    expect(checkCommand("git status").allowed).toBe(true)
    expect(checkCommand("Get-ChildItem").allowed).toBe(true)
  })
})