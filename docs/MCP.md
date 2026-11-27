# MCP tools in tvision

tvision mounts the MCP manager with an empty server list. A server is
configured in the profile patch, and its tools then appear to the model as
`mcp__<server>__<tool>` — ordinary tool cards in the transcript, no new
window. There is no server settings page in the desktop; this is the
configuration path.

The manager is `@deepseek-ai/dsh-mcp-manager`; the current pins target dsh
0.2.2-rc.5. It owns the servers, and `@deepseek-ai/dsh-mcp-client` supplies the
per-server bridge. Because the shipped list is empty, no child process starts
and the model sees no MCP tools until you add one.

## Add a stdio server

Edit `~/.dsh/profiles/tvision/cordis.patch.yml` (or the patch layer that owns
the deployment):

```yaml
- id: mcp-manager
  config:
    servers:
      github:
        transport: stdio
        command: npx
        args: ['-y', '@modelcontextprotocol/server-github']
        env:
          GITHUB_TOKEN: '${credential:GITHUB_TOKEN}'
```

`github` is the server name and the tool namespace: the model sees
`mcp__github__create_issue`, `mcp__github__search_issues`, and so on. The name
must match `[A-Za-z0-9_-]{1,32}` and must be unique across configured entries
and servers registered by plugins.

A patch replaces the targeted row's whole `config`, so keep every server you
want in the one `servers` map. Entries are enabled by default; add
`enabled: false` to keep one configured but not running.

## Add a Streamable HTTP server

```yaml
- id: mcp-manager
  config:
    servers:
      internal:
        transport: streamable-http
        url: https://mcp.example.com/mcp
        headers:
          Authorization: 'Bearer ${credential:MCP_TOKEN}'
```

`headers` is for ordinary request headers; prefer a credential reference over a
literal token, and keep tokens in the credentials store rather than the profile
patch. Values the manager expands are redacted from diagnostics and tool-call
failures by the client.

## What the model gets

- Tool names are stable for a given `(server, tool)` pair:
  `mcp__<serverName>__<rawName>`, normalized to the function-name contract. Two
  servers may both publish `search`; they stay apart as `mcp__a__search` and
  `mcp__b__search`.
- Results arrive as text in a normal tool card. The desktop has no image
  protocol, so an image or audio result is at best model-visible; the transcript
  shows the text projection.
- Server instructions join the logged system prompt beside the other prompt
  sections. MCP prompt templates are not supported.
- If a server fails to connect, its tools simply do not appear in the next
  turn's catalog. There is no dialog for it; the harness log carries the
  connection error.

## Trust and breakpoints

Configured servers run code or receive requests on your behalf, so the profile
patch is a trust boundary. The desktop's breakpoints can hold any MCP call
before it runs:

```text
/breakpoint mcp__*
```

`Ctrl+B` manages the rules. A hold is a `tools/pre-execute` gate, so it applies
to MCP calls exactly as it does to `bash` and `edit`; `y` runs one call, `a`
covers the rule for the session, and `n` refuses and tells the model.

## Limits

- No server list, status panel, or add/edit dialog. A management surface is
  future work; until then, edit the profile patch and restart.
- A server that fails its startup budget does not fail the desktop; its tools
  are absent. Set `startupTimeoutMs` on an entry if a slow server needs a
  longer budget.
- MCP images are not drawn in the terminal. Text results, resource links, and
  resource reads are.
- The manager is host-global, not per-session. tvision is a single-agent
  process, so every configured server is available to its agent; there is no
  per-session MCP scope.
