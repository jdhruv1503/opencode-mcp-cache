import { createHash } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { homedir } from "node:os"
import { tool } from "@opencode-ai/plugin"

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_CACHE_DIR = "~/.cache/opencode-mcp-cache"

function expandHome(path) {
  if (!path) return path
  if (path === "~") return homedir()
  if (path.startsWith("~/")) return join(homedir(), path.slice(2))
  return path
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

function normalizeOptions(options = {}) {
  const enabled = options.enabled === true
  const cacheDir = resolve(expandHome(String(options.cacheDir || DEFAULT_CACHE_DIR)))
  const defaultTtlMs = Number(options.defaultTtlMs || DEFAULT_TTL_MS)
  const servers = options.servers && typeof options.servers === "object" ? options.servers : {}
  return { enabled, cacheDir, defaultTtlMs, servers }
}

function enabledServers(config) {
  return Object.entries(config.servers).filter(([, server]) => server?.enabled === true)
}

function enabledToolNames(server) {
  const tools = server.tools && typeof server.tools === "object" ? server.tools : {}
  return Object.entries(tools)
    .filter(([, config]) => config?.enabled !== false)
    .map(([name]) => name)
}

function description(config) {
  const servers = enabledServers(config)
  const enabled = servers
    .map(([name, server]) => {
      const tools = enabledToolNames(server)
      return `${name}: ${tools.length > 0 ? tools.join(", ") : "any tool"}`
    })
    .join("; ")

  return [
    "Call one configured MCP tool through a local TTL cache. Use only when instructions mention a configured MCP service.",
    enabled ? `Enabled MCP tools: ${enabled}.` : "No MCP servers are enabled.",
    "For Context7, first call resolve-library-id unless the user supplied /org/project, then call query-docs."
  ].join(" ")
}

function resolveHeaders(server) {
  const headers = { ...(server.headers || {}) }
  const headerEnv = server.headerEnv || {}
  for (const [header, envName] of Object.entries(headerEnv)) {
    const value = process.env[String(envName)]
    if (value) headers[header] = value
  }
  return headers
}

function toolConfig(server, toolName) {
  const tools = server.tools && typeof server.tools === "object" ? server.tools : undefined
  if (!tools) return { enabled: true }
  return tools[toolName]
}

function cachePath(config, key) {
  return join(config.cacheDir, `${key}.json`)
}

async function readCache(config, key, ttlMs) {
  const path = cachePath(config, key)
  try {
    const raw = await readFile(path, "utf8")
    const entry = JSON.parse(raw)
    if (!entry || typeof entry.createdAt !== "number") return undefined
    if (Date.now() - entry.createdAt > ttlMs) return undefined
    return entry.result
  } catch {
    return undefined
  }
}

async function writeCache(config, key, result) {
  const path = cachePath(config, key)
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, JSON.stringify({ createdAt: Date.now(), result }), "utf8")
  await rename(temp, path)
}

function parseSse(text) {
  const data = []
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart())
  }
  if (data.length === 0) return JSON.parse(text)
  return JSON.parse(data.join("\n"))
}

function formatMcpResult(payload) {
  if (payload?.error) throw new Error(payload.error.message || JSON.stringify(payload.error))
  const result = payload?.result ?? payload
  const content = result?.content
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (part?.type === "text" && typeof part.text === "string") return part.text
        return JSON.stringify(part)
      })
      .join("\n")
    return text
  }
  if (typeof result === "string") return result
  return JSON.stringify(result, null, 2)
}

async function callRemoteMcp(server, toolName, args) {
  if (!server.url) throw new Error("Configured MCP server is missing url")
  const response = await fetch(server.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...resolveHeaders(server),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args,
      },
    }),
  })

  const text = await response.text()
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${text.slice(0, 500)}`)
  return formatMcpResult(parseSse(text))
}

async function clearCache(config, args) {
  void args
  if (existsSync(config.cacheDir)) await rm(config.cacheDir, { recursive: true, force: true })
  return "MCP cache cleared."
}

export const server = async (_ctx, options = {}) => {
  const config = normalizeOptions(options)

  return {
    tool: {
      mcp_cache_call: tool({
        description: description(config),
        args: {
          server: tool.schema.string().describe("Configured MCP server name, e.g. context7."),
          tool: tool.schema.string().describe("MCP tool name to call, e.g. resolve-library-id or query-docs."),
          arguments: tool.schema.record(tool.schema.any()).describe("Arguments object for the MCP tool."),
          bypassCache: tool.schema.boolean().optional().describe("If true, call upstream and refresh the cache."),
          clearCache: tool.schema.boolean().optional().describe("If true, clear this plugin cache instead of calling upstream."),
        },
        async execute(args, context) {
          if (!config.enabled) throw new Error("opencode-mcp-cache is disabled")
          if (args.clearCache) return clearCache(config, args)

          const configuredServer = config.servers[args.server]
          if (!configuredServer || configuredServer.enabled !== true) {
            throw new Error(`MCP server is not enabled: ${args.server}`)
          }

          const configuredTool = toolConfig(configuredServer, args.tool)
          if (!configuredTool || configuredTool.enabled === false) {
            throw new Error(`MCP tool is not enabled: ${args.server}.${args.tool}`)
          }

          const cacheable = configuredTool.cache !== false
          const ttlMs = Number(configuredTool.ttlMs || configuredServer.ttlMs || config.defaultTtlMs)
          const key = sha256(stableStringify({ server: args.server, tool: args.tool, arguments: args.arguments }))
          context.metadata({
            title: `${args.server}.${args.tool}`,
            metadata: { cacheKey: key, cacheable, ttlMs },
          })

          if (cacheable && args.bypassCache !== true) {
            const cached = await readCache(config, key, ttlMs)
            if (cached !== undefined) {
              context.metadata({ title: `${args.server}.${args.tool} (cache hit)`, metadata: { cacheHit: true, cacheKey: key } })
              return { output: cached, metadata: { cacheHit: true, cacheKey: key } }
            }
          }

          const result = await callRemoteMcp(configuredServer, args.tool, args.arguments || {})
          if (cacheable) await writeCache(config, key, result)
          context.metadata({ title: `${args.server}.${args.tool} (cache miss)`, metadata: { cacheHit: false, cacheKey: key } })
          return { output: result, metadata: { cacheHit: false, cacheKey: key } }
        },
      }),
    },
  }
}

export default server

export const internals = {
  stableStringify,
  parseSse,
  formatMcpResult,
  normalizeOptions,
}
