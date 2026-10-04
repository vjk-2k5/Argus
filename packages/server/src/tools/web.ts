const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-",
  hellip: "…", lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', copy: "(c)", reg: "(r)", trade: "(tm)",
  times: "x", middot: "·", bull: "-", deg: "°", laquo: "<<", raquo: ">>", eacute: "é", egrave: "è",
  agrave: "à", ccedil: "ç", uuml: "ü", ouml: "ö", auml: "ä", szlig: "ß",
}

export function decodeEntities(input: string) {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return ENTITIES[body.toLowerCase()] ?? match
  })
}

export function stripTags(input: string) {
  return decodeEntities(input.replace(/<[^>]*>/g, ""))
}

export function htmlToMarkdown(html: string) {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|template|svg|head|iframe|object)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(li|p|div|section|article|tr|table|ul|ol|dl|blockquote|pre)>/gi, "\n\n")
    .replace(/<h1\b[^>]*>/gi, "\n\n# ")
    .replace(/<h2\b[^>]*>/gi, "\n\n## ")
    .replace(/<h3\b[^>]*>/gi, "\n\n### ")
    .replace(/<h4\b[^>]*>/gi, "\n\n#### ")
    .replace(/<h5\b[^>]*>/gi, "\n\n##### ")
    .replace(/<h6\b[^>]*>/gi, "\n\n###### ")
    .replace(/<strong\b[^>]*>/gi, "**").replace(/<\/strong>/gi, "**")
    .replace(/<b\b[^>]*>/gi, "**").replace(/<\/b>/gi, "**")
    .replace(/<em\b[^>]*>/gi, "*").replace(/<\/em>/gi, "*")
    .replace(/<i\b[^>]*>/gi, "*").replace(/<\/i>/gi, "*")
    .replace(/<code\b[^>]*>/gi, "`").replace(/<\/code>/gi, "`")
    .replace(/<pre\b[^>]*>/gi, "\n\n```\n").replace(/<\/pre>/gi, "\n```\n\n")
    .replace(/<blockquote\b[^>]*>/gi, "\n\n> ").replace(/<\/blockquote>/gi, "\n\n")
    .replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_match, href: string, label: string) => {
      const text = label.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()
      return text ? `[${text}](${href})` : href
    })
    .replace(/<[^>]+>/g, "")
  text = decodeEntities(text)
  text = text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^[\t ]+([^\n])/gm, (_match, char: string) => char)
    .trim()
  return text
}

export function collapseWhitespace(input: string) {
  return input.replace(/\s+/g, " ").trim()
}

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

export type SearchProviderId = "exa" | "duckduckgo" | "tavily" | "brave"

export function searchProvider(): SearchProviderId {
  const configured = process.env.ARGUS_SEARCH_PROVIDER?.trim().toLowerCase()
  if (configured === "exa" || configured === "tavily" || configured === "brave" || configured === "duckduckgo") return configured
  if (process.env.ARGUS_TAVILY_API_KEY?.trim()) return "tavily"
  if (process.env.ARGUS_BRAVE_API_KEY?.trim()) return "brave"
  return "exa"
}

/** Providers tried in order until one returns results. Exa needs no key, so it leads. */
function providerChain(): SearchProviderId[] {
  const primary = searchProvider()
  const rest: SearchProviderId[] = ["exa", "duckduckgo"]
  if (process.env.ARGUS_TAVILY_API_KEY?.trim()) rest.unshift("tavily")
  if (process.env.ARGUS_BRAVE_API_KEY?.trim()) rest.unshift("brave")
  return [primary, ...rest.filter((item) => item !== primary)]
}

interface McpCall {
  url: string
  tool: string
  args: Record<string, unknown>
}

/**
 * Exa exposes a public MCP endpoint that works without a key. It speaks JSON-RPC `tools/call`
 * over HTTP and answers with a single SSE message, so the payload has to be unwrapped from a
 * `data:` line rather than read straight off the body.
 */
async function callExaMcp(input: {
  query: string
  type: string
  numResults: number
  livecrawl: string
  contextMaxCharacters: number
  timeoutMs: number
}) {
  const key = process.env.EXA_API_KEY?.trim()
  const url = key
    ? `https://mcp.exa.ai/mcp?exaApiKey=${encodeURIComponent(key)}`
    : "https://mcp.exa.ai/mcp"

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "web_search_exa",
        arguments: {
          query: input.query,
          type: input.type,
          numResults: input.numResults,
          livecrawl: input.livecrawl,
          contextMaxCharacters: input.contextMaxCharacters,
        },
      },
    }),
    signal: AbortSignal.timeout(input.timeoutMs),
  })
  if (!response.ok) throw new Error(`Exa search failed (HTTP ${response.status})`)
  return parseMcpText(await response.text())
}

function parseMcpText(body: string) {
  const trimmed = body.trim()
  if (trimmed.startsWith("{")) {
    const direct = extractMcpText(trimmed)
    if (direct !== undefined) return direct
  }
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue
    const found = extractMcpText(line.slice(6))
    if (found !== undefined) return found
  }
  throw new Error("Exa search returned an unreadable response")
}

function extractMcpText(payload: string): string | undefined {
  const trimmed = payload.trim()
  if (!trimmed.startsWith("{")) return undefined
  try {
    const data = JSON.parse(trimmed) as { result?: { content?: Array<{ text?: string }> } }
    return data.result?.content?.find((item) => typeof item.text === "string")?.text
  } catch {
    return undefined
  }
}

async function searchDuckDuckGo(query: string, limit: number): Promise<SearchResult[]> {
  const response = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "Mozilla/5.0 (compatible; Argus/1.0; +https://github.com/argus)",
      "accept-language": "en-US,en;q=0.9",
    },
    body: new URLSearchParams({ q: query }).toString(),
    signal: AbortSignal.timeout(20_000),
    redirect: "follow",
  })
  if (!response.ok) throw new Error(`DuckDuckGo search failed (HTTP ${response.status})`)
  const html = await response.text()
  const results: SearchResult[] = []
  const blocks = html.split(/<div class="result results_links/).slice(1)
  for (const block of blocks) {
    const link = block.match(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
    if (!link?.[1]) continue
    const snippet = block.match(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i)
    results.push({
      title: stripTags(link[2] ?? "").trim(),
      url: decodeDuckDuckGoUrl(link[1]),
      snippet: collapseWhitespace(stripTags(snippet?.[1] ?? "")),
    })
    if (results.length >= limit) break
  }
  return results
}

function decodeDuckDuckGoUrl(raw: string) {
  const match = raw.match(/[?&]uddg=([^&]+)/)
  if (!match?.[1]) return raw
  try {
    return decodeURIComponent(match[1])
  } catch {
    return raw
  }
}

async function searchTavily(query: string, limit: number): Promise<SearchResult[]> {
  const key = process.env.ARGUS_TAVILY_API_KEY?.trim()
  if (!key) throw new Error("ARGUS_TAVILY_API_KEY is not configured")
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: key, query, max_results: Math.min(limit, 20), search_depth: "basic" }),
    signal: AbortSignal.timeout(25_000),
  })
  if (!response.ok) throw new Error(`Tavily search failed (HTTP ${response.status})`)
  const body = await response.json() as { results?: Array<{ title?: string; url?: string; content?: string }> }
  return (body.results ?? []).slice(0, limit).map((item) => ({
    title: collapseWhitespace(item.title ?? ""),
    url: item.url ?? "",
    snippet: collapseWhitespace(item.content ?? "").slice(0, 600),
  }))
}

async function searchBrave(query: string, limit: number): Promise<SearchResult[]> {
  const key = process.env.ARGUS_BRAVE_API_KEY?.trim()
  if (!key) throw new Error("ARGUS_BRAVE_API_KEY is not configured")
  const url = new URL("https://api.search.brave.com/res/v1/web/search")
  url.searchParams.set("q", query)
  url.searchParams.set("count", String(Math.min(limit, 20)))
  const response = await fetch(url, { headers: { "x-subscription-token": key, accept: "application/json" }, signal: AbortSignal.timeout(25_000) })
  if (!response.ok) throw new Error(`Brave search failed (HTTP ${response.status})`)
  const body = await response.json() as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } }
  return (body.web?.results ?? []).slice(0, limit).map((item) => ({
    title: collapseWhitespace(item.title ?? ""),
    url: item.url ?? "",
    snippet: collapseWhitespace(item.description ?? "").slice(0, 600),
  }))
}

export interface SearchOutcome {
  provider: SearchProviderId
  results: SearchResult[]
  content?: string
  attempts: Array<{ provider: SearchProviderId; error?: string }>
}

async function searchExa(
  query: string,
  limit: number,
  options: { type: string; livecrawl: string; contextMaxCharacters: number },
): Promise<{ results: SearchResult[]; content: string }> {
  const content = await callExaMcp({
    query,
    type: options.type,
    numResults: limit,
    livecrawl: options.livecrawl,
    contextMaxCharacters: options.contextMaxCharacters,
    timeoutMs: 25_000,
  })
  return { results: parseExaBlocks(content), content }
}

/** Exa returns one pre-rendered context block rather than a JSON result array. */
export function parseExaBlocks(content: string): SearchResult[] {
  const results: SearchResult[] = []
  const blocks = content.split(/\n(?=Title:\s)/)
  for (const block of blocks) {
    const title = block.match(/^Title:\s*(.+)$/m)?.[1]?.trim()
    const url = block.match(/^URL:\s*(.+)$/m)?.[1]?.trim()
    if (!title || !url) continue
    const author = block.match(/^Author:\s*(.+)$/m)?.[1]?.trim()
    const highlights = block.match(/^Highlights:\s*([\s\S]*)$/m)?.[1]?.trim()
    results.push({
      title,
      url,
      snippet: collapseWhitespace([
        author && author !== "N/A" ? `by ${author}` : "",
        highlights ?? "",
      ].filter(Boolean).join(" ")).slice(0, 600),
    })
  }
  return results
}

/**
 * Try each provider in turn. Exa returns full page content, so it is preferred; the
 * keyless DuckDuckGo path stays last as a floor so websearch never hard-fails.
 */
export async function searchWeb(input: {
  query: string
  limit: number
  type?: string
  livecrawl?: string
  contextMaxCharacters?: number
}): Promise<SearchOutcome> {
  const attempts: Array<{ provider: SearchProviderId; error?: string }> = []
  for (const provider of providerChain()) {
    try {
      if (provider === "exa") {
        const outcome = await searchExa(input.query, input.limit, {
          type: input.type ?? "auto",
          livecrawl: input.livecrawl ?? "fallback",
          contextMaxCharacters: input.contextMaxCharacters ?? 10_000,
        })
        attempts.push({ provider })
        if (outcome.results.length > 0 || outcome.content) return { provider, ...outcome, attempts }
        continue
      }
      const results = provider === "tavily"
        ? await searchTavily(input.query, input.limit)
        : provider === "brave"
          ? await searchBrave(input.query, input.limit)
          : await searchDuckDuckGo(input.query, input.limit)
      attempts.push({ provider })
      if (results.length > 0) return { provider, results, attempts }
    } catch (cause) {
      attempts.push({ provider, error: cause instanceof Error ? cause.message : String(cause) })
    }
  }
  return { provider: providerChain()[0]!, results: [], attempts }
}

export interface FetchedPage {
  url: string
  status: number
  contentType: string
  body: string
}

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024
const DEFAULT_TIMEOUT = 30_000
const MAX_TIMEOUT = 120_000

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36"
const HONEST_UA = "Argus/1.0 (+https://github.com/anomalyco/opencode)"

function acceptHeader(format: FetchFormat) {
  switch (format) {
    case "markdown":
      return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
    case "text":
      return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
    case "html":
      return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, */*;q=0.1"
  }
}

async function requestPage(url: string, format: FetchFormat, userAgent: string, timeoutMs: number) {
  return fetch(url, {
    headers: {
      "user-agent": userAgent,
      accept: acceptHeader(format),
      "accept-language": "en-US,en;q=0.9",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  })
}

export type FetchFormat = "markdown" | "text" | "html"

export async function fetchPage(url: string, maxChars: number, options: { format?: FetchFormat; timeoutMs?: number } = {}): Promise<FetchedPage> {
  const parsed = new URL(url)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported URL scheme: ${parsed.protocol}`)
  }
  const format = options.format ?? "markdown"
  const timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT, MAX_TIMEOUT)

  let response = await requestPage(url, format, BROWSER_UA, timeoutMs)
  // Cloudflare challenges a browser UA it cannot fingerprint; an honest UA often gets through.
  if (response.status === 403 && response.headers.get("cf-mitigated") === "challenge") {
    response = await requestPage(url, format, HONEST_UA, timeoutMs)
  }
  if (!response.ok) throw new Error(`Request failed (HTTP ${response.status})`)

  const declared = Number(response.headers.get("content-length") ?? 0)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_SIZE) {
    throw new Error(`Response too large (${Math.round(declared / 1024 / 1024)}MB exceeds the 5MB limit)`)
  }

  const contentType = response.headers.get("content-type") ?? ""
  const buffer = new Uint8Array(await response.arrayBuffer())
  if (buffer.byteLength > MAX_RESPONSE_SIZE) {
    throw new Error(`Response too large (${Math.round(buffer.byteLength / 1024 / 1024)}MB exceeds the 5MB limit)`)
  }

  let body = new TextDecoder("utf-8", { fatal: false }).decode(buffer)
  const isHtml = contentType.includes("html") || /^\s*<!doctype html/i.test(body)
  if (format === "html") {
    // leave as-is
  } else if (isHtml) {
    body = format === "text" ? stripTags(body) : htmlToMarkdown(body)
  }
  if (format === "text") body = body.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim()

  return {
    url: response.url || url,
    status: response.status,
    contentType,
    body: body.length > maxChars ? `${body.slice(0, maxChars)}\n\n[truncated at ${maxChars} characters]` : body,
  }
}
