# @profullstack/typeheard-mcp

MCP server for [typeheard.com](https://typeheard.com): transcribe audio and video files
from any MCP client.

```json
{ "mcpServers": { "typeheard": { "command": "npx", "args": ["-y", "@profullstack/typeheard-mcp"],
  "env": { "TYPEHEARD_API_KEY": "th_..." } } } }
```

Tools: `transcribe_file`, `get_transcript`, `list_transcripts`. The CLI installs with
`curl -fsSL https://typeheard.com/install.sh | sh`. Docs: https://typeheard.com/docs

MIT, Profullstack, Inc.
