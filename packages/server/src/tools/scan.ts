import { isAbsolute, relative, resolve, sep } from "node:path"

const WINDOWS_DRIVE = /^[a-zA-Z]:[\\/]?/
const URL_LIKE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** Split a command into tokens, keeping quoted spans intact so paths with spaces survive. */
export function tokenize(command: string) {
  const tokens: string[] = []
  let current = ""
  let quote: '"' | "'" | null = null
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!
    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) tokens.push(current)
      current = ""
      continue
    }
    // PowerShell escapes with backtick or caret. Backslash is deliberately not an escape
    // character here: treating it as one would corrupt Windows paths like C:\Windows.
    if (char === "`" || char === "^") {
      const next = command[index + 1]
      if (next !== undefined) {
        current += next
        index++
        continue
      }
    }
    current += char
  }
  if (current) tokens.push(current)
  return tokens
}

function looksLikePath(token: string) {
  if (!token || URL_LIKE.test(token) || ENV_ASSIGNMENT.test(token)) return false
  if (token.startsWith("-")) return false
  if (WINDOWS_DRIVE.test(token)) return true
  if (token.startsWith("~")) return true
  if (token.includes("/") || token.includes("\\")) return true
  if (token.startsWith(".")) return true
  if (/[*?]/.test(token)) return true
  return false
}

/** Wildcards cannot be resolved exactly, so audit the static directory prefix instead. */
function staticPrefix(token: string) {
  const wildcard = token.search(/[*?]/)
  if (wildcard < 0) return token
  const cut = token.slice(0, wildcard).replace(/[\\/]+$/, "")
  return cut === "" ? token : cut
}

function escapes(root: string, target: string) {
  const rel = relative(resolve(root), resolve(target))
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)
}

export interface PathScan {
  touched: string[]
  violations: string[]
}

/**
 * Audit the paths a shell command mentions. The other tools are confined to the session
 * workspace, and without this the shell would be the one way out of it.
 */
export function scanCommandPaths(command: string, workspace: string): PathScan {
  const touched: string[] = []
  const violations: string[] = []

  for (const token of tokenize(command)) {
    if (!looksLikePath(token)) continue
    const candidate = staticPrefix(token)

    if (candidate.startsWith("~")) {
      violations.push(`${token} (home directory)`)
      continue
    }
    const absolute = isAbsolute(candidate) ? candidate : resolve(workspace, candidate)
    if (escapes(workspace, absolute)) {
      violations.push(token)
      continue
    }
    touched.push(token)
  }

  // A `cd` out of the workspace is an escape even when no path token is obviously outside.
  if (/(^|[;&|]\s*)cd\s+\.\./.test(command) || /pushd\s+\.\./i.test(command)) {
    violations.push("cd .. (leaves the session workspace)")
  }

  return { touched: [...new Set(touched)], violations: [...new Set(violations)] }
}
