import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { server, internals } from "../src/index.js"

test("stableStringify sorts object keys", () => {
  assert.equal(internals.stableStringify({ b: 1, a: 2 }), internals.stableStringify({ a: 2, b: 1 }))
})

test("parseSse parses MCP event-stream payload", () => {
  const payload = internals.parseSse('event: message\ndata: {"result":{"content":[{"type":"text","text":"ok"}]}}\n')
  assert.equal(internals.formatMcpResult(payload), "ok")
})

test("tool caches identical MCP calls", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "opencode-mcp-cache-test-"))
  let upstreamCalls = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    upstreamCalls++
    return new Response('event: message\ndata: {"result":{"content":[{"type":"text","text":"cached-value"}]}}\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })
  }

  try {
    const plugin = await server({}, {
      enabled: true,
      cacheDir,
      servers: {
        context7: {
          enabled: true,
          url: "https://example.test/mcp",
          tools: { "query-docs": { enabled: true, ttlMs: 60_000 } },
        },
      },
    })
    const context = { metadata() {} }
    const call = { server: "context7", tool: "query-docs", arguments: { libraryId: "/x/y", query: "q" } }

    const first = await plugin.tool.mcp_cache_call.execute(call, context)
    const second = await plugin.tool.mcp_cache_call.execute(call, context)

    assert.equal(first.output, "cached-value")
    assert.equal(second.output, "cached-value")
    assert.equal(upstreamCalls, 1)
    assert.equal(second.metadata.cacheHit, true)
  } finally {
    globalThis.fetch = originalFetch
    await rm(cacheDir, { recursive: true, force: true })
  }
})
