/**
 * Exact-string replacement with a chain of fallbacks, so an edit still lands when the model's
 * whitespace, indentation, or line endings drift slightly from the file. Strategies are tried
 * in order of decreasing confidence and the first one that yields a unique match wins.
 */
export type Replacer = (content: string, find: string) => Generator<string>

const SINGLE_CANDIDATE_SIMILARITY_THRESHOLD = 0.65
const MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD = 0.65

export function levenshtein(a: string, b: string): number {
  if (a === "" || b === "") return Math.max(a.length, b.length)
  const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      matrix[i]![j] = Math.min(matrix[i - 1]![j]! + 1, matrix[i]![j - 1]! + 1, matrix[i - 1]![j - 1]! + cost)
    }
  }
  return matrix[a.length]![b.length]!
}

export const SimpleReplacer: Replacer = function* (_content, find) {
  yield find
}

export const LineTrimmedReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n")
  const searchLines = find.split("\n")
  if (searchLines[searchLines.length - 1] === "") searchLines.pop()
  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let matches = true
    for (let j = 0; j < searchLines.length; j++) {
      if (originalLines[i + j]!.trim() !== searchLines[j]!.trim()) {
        matches = false
        break
      }
    }
    if (matches) yield span(originalLines, i, searchLines.length)
  }
}

export const BlockAnchorReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n")
  const searchLines = find.split("\n")
  if (searchLines.length < 3) return
  if (searchLines[searchLines.length - 1] === "") searchLines.pop()

  const firstLineSearch = searchLines[0]!.trim()
  const lastLineSearch = searchLines[searchLines.length - 1]!.trim()
  const searchBlockSize = searchLines.length
  const maxLineDelta = Math.max(1, Math.floor(searchBlockSize * 0.25))

  const candidates: Array<{ startLine: number; endLine: number }> = []
  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i]!.trim() !== firstLineSearch) continue
    for (let j = i + 2; j < originalLines.length; j++) {
      if (originalLines[j]!.trim() === lastLineSearch) {
        if (Math.abs(j - i + 1 - searchBlockSize) <= maxLineDelta) candidates.push({ startLine: i, endLine: j })
        break
      }
    }
  }
  if (candidates.length === 0) return

  const score = (startLine: number, endLine: number) => {
    const actualBlockSize = endLine - startLine + 1
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2)
    if (linesToCheck <= 0) return 1
    let similarity = 0
    for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
      const originalLine = originalLines[startLine + j]!.trim()
      const searchLine = searchLines[j]!.trim()
      const maxLen = Math.max(originalLine.length, searchLine.length)
      if (maxLen === 0) continue
      similarity += (1 - levenshtein(originalLine, searchLine) / maxLen) / linesToCheck
      if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) break
    }
    return similarity
  }

  if (candidates.length === 1) {
    const only = candidates[0]!
    if (score(only.startLine, only.endLine) >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
      yield span(originalLines, only.startLine, only.endLine - only.startLine + 1)
    }
    return
  }

  let best: { startLine: number; endLine: number } | undefined
  let maxSimilarity = -1
  for (const candidate of candidates) {
    const similarity = score(candidate.startLine, candidate.endLine)
    if (similarity > maxSimilarity) {
      maxSimilarity = similarity
      best = candidate
    }
  }
  if (best && maxSimilarity >= MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD) {
    yield span(originalLines, best.startLine, best.endLine - best.startLine + 1)
  }
}

export const WhitespaceNormalizedReplacer: Replacer = function* (content, find) {
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim()
  const normalizedFind = normalize(find)
  const lines = content.split("\n")
  for (const line of lines) {
    if (normalize(line) === normalizedFind) {
      yield line
      continue
    }
    if (!normalize(line).includes(normalizedFind)) continue
    const words = find.trim().split(/\s+/)
    if (words.length === 0) continue
    const pattern = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+")
    try {
      const match = line.match(new RegExp(pattern))
      if (match?.[0]) yield match[0]
    } catch {
      // Invalid regex from an odd word; skip this line.
    }
  }
  const findLines = find.split("\n")
  if (findLines.length > 1) {
    for (let i = 0; i <= lines.length - findLines.length; i++) {
      const block = lines.slice(i, i + findLines.length).join("\n")
      if (normalize(block) === normalizedFind) yield block
    }
  }
}

export const IndentationFlexibleReplacer: Replacer = function* (content, find) {
  const removeIndentation = (text: string) => {
    const lines = text.split("\n")
    const nonEmpty = lines.filter((line) => line.trim().length > 0)
    if (nonEmpty.length === 0) return text
    const minIndent = Math.min(...nonEmpty.map((line) => line.match(/^(\s*)/)?.[1]?.length ?? 0))
    return lines.map((line) => (line.trim().length === 0 ? line : line.slice(minIndent))).join("\n")
  }
  const normalizedFind = removeIndentation(find)
  const contentLines = content.split("\n")
  const findLines = find.split("\n")
  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    const block = contentLines.slice(i, i + findLines.length).join("\n")
    if (removeIndentation(block) === normalizedFind) yield block
  }
}

export const EscapeNormalizedReplacer: Replacer = function* (content, find) {
  const unescape = (text: string) => text.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (match, char: string) => {
    if (char === "n" || char === "\n") return "\n"
    if (char === "t") return "\t"
    if (char === "r") return "\r"
    return char
  })
  const unescapedFind = unescape(find)
  if (content.includes(unescapedFind)) yield unescapedFind
  const lines = content.split("\n")
  const findLines = unescapedFind.split("\n")
  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join("\n")
    if (unescape(block) === unescapedFind) yield block
  }
}

export const MultiOccurrenceReplacer: Replacer = function* (content, find) {
  let startIndex = 0
  while (true) {
    const index = content.indexOf(find, startIndex)
    if (index === -1) break
    yield find
    startIndex = index + find.length
  }
}

export const TrimmedBoundaryReplacer: Replacer = function* (content, find) {
  const trimmedFind = find.trim()
  if (trimmedFind === find) return
  if (content.includes(trimmedFind)) yield trimmedFind
  const lines = content.split("\n")
  const findLines = find.split("\n")
  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join("\n")
    if (block.trim() === trimmedFind) yield block
  }
}

export const ContextAwareReplacer: Replacer = function* (content, find) {
  const findLines = find.split("\n")
  if (findLines.length < 3) return
  if (findLines[findLines.length - 1] === "") findLines.pop()
  const contentLines = content.split("\n")
  const firstLine = findLines[0]!.trim()
  const lastLine = findLines[findLines.length - 1]!.trim()
  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i]!.trim() !== firstLine) continue
    for (let j = i + 2; j < contentLines.length; j++) {
      if (contentLines[j]!.trim() !== lastLine) continue
      const blockLines = contentLines.slice(i, j + 1)
      if (blockLines.length === findLines.length) {
        let matching = 0
        let total = 0
        for (let k = 1; k < blockLines.length - 1; k++) {
          const blockLine = blockLines[k]!.trim()
          const findLine = findLines[k]!.trim()
          if (blockLine.length > 0 || findLine.length > 0) {
            total++
            if (blockLine === findLine) matching++
          }
        }
        if (total === 0 || matching / total >= 0.5) {
          yield blockLines.join("\n")
          return
        }
      }
      break
    }
  }
}

function span(lines: string[], start: number, count: number) {
  let startIndex = 0
  for (let k = 0; k < start; k++) startIndex += lines[k]!.length + 1
  let endIndex = startIndex
  for (let k = 0; k < count; k++) {
    endIndex += lines[start + k]!.length
    if (k < count - 1) endIndex += 1
  }
  return lines.join("\n").slice(startIndex, endIndex)
}

function isDisproportionateMatch(search: string, oldString: string) {
  const oldLines = oldString.split("\n").length
  const searchLines = search.split("\n").length
  if (searchLines >= Math.max(oldLines + 3, oldLines * 2)) return true
  if (oldLines === 1) return false
  return search.trim().length > Math.max(oldString.trim().length + 500, oldString.trim().length * 4)
}

export type ReplaceResult =
  | { ok: true; content: string; strategy: string; matched: string; occurrences: number }
  | { ok: false; reason: "identical" | "empty" | "not_found" | "multiple" | "disproportionate"; message: string }

const STRATEGIES: Array<{ name: string; replacer: Replacer }> = [
  { name: "exact", replacer: SimpleReplacer },
  { name: "line-trimmed", replacer: LineTrimmedReplacer },
  { name: "block-anchor", replacer: BlockAnchorReplacer },
  { name: "whitespace-normalized", replacer: WhitespaceNormalizedReplacer },
  { name: "indentation-flexible", replacer: IndentationFlexibleReplacer },
  { name: "escape-normalized", replacer: EscapeNormalizedReplacer },
  { name: "trimmed-boundary", replacer: TrimmedBoundaryReplacer },
  { name: "context-aware", replacer: ContextAwareReplacer },
  { name: "multi-occurrence", replacer: MultiOccurrenceReplacer },
]

export function replace(content: string, oldString: string, newString: string, replaceAll = false): ReplaceResult {
  if (oldString === newString) {
    return {
      ok: false,
      reason: "identical",
      message: "No changes to apply: oldString and newString are identical.",
    }
  }
  if (oldString === "") {
    return {
      ok: false,
      reason: "empty",
      message: "oldString cannot be empty. Provide the exact text to replace, or use write for a full-file replacement.",
    }
  }

  let found = false
  for (const { name, replacer } of STRATEGIES) {
    for (const search of replacer(content, oldString)) {
      const index = content.indexOf(search)
      if (index === -1) continue
      found = true
      if (isDisproportionateMatch(search, oldString)) {
        return {
          ok: false,
          reason: "disproportionate",
          message: "Refusing replacement because the matched span is much larger than oldString. Re-read the file and provide the full exact oldString for the intended replacement.",
        }
      }
      if (replaceAll) {
        const occurrences = content.split(search).length - 1
        return { ok: true, content: content.split(search).join(newString), strategy: name, matched: search, occurrences }
      }
      const lastIndex = content.lastIndexOf(search)
      if (index !== lastIndex) continue
      const updated = content.slice(0, index) + newString + content.slice(index + search.length)
      return { ok: true, content: updated, strategy: name, matched: search, occurrences: 1 }
    }
  }

  if (!found) {
    return {
      ok: false,
      reason: "not_found",
      message: "Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings. Re-read the file to get the exact text.",
    }
  }
  return {
    ok: false,
    reason: "multiple",
    message: "Found multiple matches for oldString. Provide more surrounding lines in oldString to identify the correct match, or set replaceAll to change every occurrence.",
  }
}
