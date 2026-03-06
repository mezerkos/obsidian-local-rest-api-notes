# Obsidian Local REST API — Notes Extension

Extension plugin for [Obsidian Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) that adds wiki-link name resolution endpoints. Notes are resolved by their wiki-link name (including frontmatter aliases), not by vault path.

## Installation

```bash
npm install
npm run build
```

Copy or symlink `main.js` and `manifest.json` into your vault's `.obsidian/plugins/obsidian-local-rest-api-notes/` directory, then enable the plugin in Obsidian's Community Plugins settings. The parent [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin must be installed and enabled.

## Routes

| Route | Methods | Description |
|-------|---------|-------------|
| `/note/*` | GET, PUT, POST, PATCH, DELETE | Read, overwrite, append, patch, or delete a note by wiki-link name |
| `/note-move/` | POST | Move/rename a note (updates backlinks) |
| `/note-api.yaml` | GET | OpenAPI spec for these endpoints |

The full OpenAPI specification is served at `/note-api.yaml` when the plugin is running.

## License

[MIT](LICENSE)
