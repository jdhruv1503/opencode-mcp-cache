# opencode-mcp-cache

One-tool OpenCode plugin that calls configured MCP tools through a local TTL cache.

The plugin is disabled by default. You opt in per MCP server and per tool, so the model only sees one small tool instead of every upstream MCP tool schema.

## Why

OpenCode cannot currently short-circuit existing MCP tool calls from `tool.execute.before`. To get real caching and lower context overhead, do not register the upstream MCP server directly. Register this plugin instead and let the plugin call the MCP server.

## Tool

The plugin exposes one tool: `mcp_cache_call`.

Arguments:

- `server`: configured MCP server name
- `tool`: upstream MCP tool name
- `arguments`: upstream MCP arguments object
- `bypassCache`: optional, refresh cache
- `clearCache`: optional, clear plugin cache

## Local OpenCode Usage

Create a local plugin shim in `~/.config/opencode/plugins/mcp-cache.js`:

```js
import config from "../mcp-cache.config.json" with { type: "json" }
import { server as McpCache } from "../vendor/opencode-mcp-cache/src/index.js"

export const McpCachePlugin = (ctx) => McpCache(ctx, config)
```

Example `~/.config/opencode/mcp-cache.config.json`:

```json
{
  "enabled": true,
  "cacheDir": "~/.cache/opencode-mcp-cache",
  "defaultTtlMs": 86400000,
  "servers": {
    "context7": {
      "enabled": true,
      "url": "https://mcp.context7.com/mcp",
      "headerEnv": {
        "CONTEXT7_API_KEY": "CONTEXT7_API_KEY"
      },
      "tools": {
        "resolve-library-id": { "enabled": true, "ttlMs": 604800000 },
        "query-docs": { "enabled": true, "ttlMs": 86400000 }
      }
    }
  }
}
```

Do not also configure the original Context7 MCP server in `opencode.json`; that would add its tool schemas back into context.

## Testing

```bash
npm install
npm test
```
