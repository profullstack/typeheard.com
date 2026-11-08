# @profullstack/typeheard-mcp

MCP server for [typeheard.com](https://typeheard.pwa.pit.world): transcribe audio and video files
from any MCP client.

```json
{ "mcpServers": { "typeheard": { "command": "npx", "args": ["-y", "@profullstack/typeheard-mcp"],
  "env": { "TYPEHEARD_API_KEY": "th_..." } } } }
```

Tools: `transcribe_file`, `get_transcript`, `list_transcripts`. The CLI installs with
`curl -fsSL https://typeheard.pwa.pit.world/install.sh | sh`. Docs: https://typeheard.pwa.pit.world/docs

MIT, Profullstack, Inc.
