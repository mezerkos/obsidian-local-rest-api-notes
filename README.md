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
| `/periodic-note/*` | GET, PUT, POST, PATCH, DELETE | Read, write, or patch periodic notes (daily, weekly, monthly, quarterly, yearly) |
| `/note-move/` | POST | Move/rename a note (updates backlinks) |
| `/notes-openapi.yaml` | GET | OpenAPI spec for these endpoints |

The full OpenAPI specification is served at `/notes-openapi.yaml` when the plugin is running.

## Periodic Notes API

The `/periodic-note/*` endpoints provide enhanced access to periodic notes, improving upon the base `/periodic/` API from the parent plugin.

### Features

- **Date-specific access**: Get notes for any date, not just the current period
- **Direct period targeting**: Use ISO formats like `2026-W03` (week 3), `2026-03` (March), `2026-Q1` (Q1), `2026` (year)
- **Full PATCH support**: Append/prepend/replace on headings, blocks, and frontmatter (unlike base API which only supports heading insertion)
- **NoteJson format**: Structured JSON responses with metadata
- **Section extraction**: Get specific headings or blocks via headers
- **Hierarchical links**: Link headers point to parent periods (day → week → month → quarter → year)
- **Auto-creation**: POST/PATCH create notes from templates; PUT creates empty notes

### Endpoints

```
GET    /periodic-note/{period}/
GET    /periodic-note/{period}/{date}
PUT    /periodic-note/{period}/{date}
POST   /periodic-note/{period}/{date}
PATCH  /periodic-note/{period}/{date}
DELETE /periodic-note/{period}/{date}
```

**Periods**: `daily`, `weekly`, `monthly`, `quarterly`, `yearly`

### Date Formats

**ISO 8601 ordering** (year → month → day) with flexible separators (`.`, `/`, `-`).

| Period | Formats | Examples |
|--------|---------|----------|
| daily | `YYYY-MM-DD` | `2026-01-15`, `2026.01.15`, `2026/01/15` |
| weekly | `YYYY-Www` or `YYYY-MM-DD` | `2026-W03`, `2026.W03`, `2026-01-15` |
| monthly | `YYYY-MM` or `YYYY-MM-DD` | `2026-03`, `2026.03`, `2026-03-15` |
| quarterly | `YYYY-Qq` or `YYYY-MM-DD` | `2026-Q1`, `2026.Q1`, `2026-02-15` |
| yearly | `YYYY` or `YYYY-MM-DD` | `2026`, `2026-06-15` |

**Date normalization**: Invalid dates are automatically normalized. For example, `2026-02-31` becomes `2026-03-03`. The response includes both the requested and actual dates.

**Negative offsets**: You can use negative values to specify dates relative to the start of a period:
- `2026-W-4` → 4 weeks before week 1 of 2026 (late 2025)
- `2026--2` → 2 months before January 2026 (November 2025)
- `2026-Q-1` → 1 quarter before Q1 2026 (Q4 2025)
- `2026-01--5` → 5 days before January 1, 2026 (December 27, 2025)

### Examples

```bash
# Get today's daily note
curl -H "Authorization: Bearer $API_KEY" \
  http://localhost:27123/periodic-note/daily/

# Get specific date
curl -H "Authorization: Bearer $API_KEY" \
  http://localhost:27123/periodic-note/daily/2026-01-15

# Get week 3 of 2026
curl -H "Authorization: Bearer $API_KEY" \
  http://localhost:27123/periodic-note/weekly/2026-W03

# Get March 2026
curl -H "Authorization: Bearer $API_KEY" \
  http://localhost:27123/periodic-note/monthly/2026-03

# Get Q1 2026
curl -H "Authorization: Bearer $API_KEY" \
  http://localhost:27123/periodic-note/quarterly/2026-Q1

# Get year 2026
curl -H "Authorization: Bearer $API_KEY" \
  http://localhost:27123/periodic-note/yearly/2026

# Get NoteJson format with periodic metadata
curl -H "Authorization: Bearer $API_KEY" \
  -H "Accept: application/vnd.olrapi.note+json" \
  http://localhost:27123/periodic-note/daily/2026-01-15

# Patch a periodic note (full PATCH support)
curl -X PATCH \
  -H "Authorization: Bearer $API_KEY" \
  -H "Operation: append" \
  -H "Target-Type: heading" \
  -H "Target: Tasks" \
  -d "- New task" \
  http://localhost:27123/periodic-note/daily/2026-01-15

# Create note from template (POST auto-creates)
curl -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -d "Evening reflection\n" \
  http://localhost:27123/periodic-note/daily/2026-12-31
```

### Hierarchical Link Headers

Responses include Link headers for navigation to parent periods:

```http
Link: </periodic-note/daily/>; rel="current",
      </periodic-note/weekly/2026-W03>; rel="up"; title="week",
      </periodic-note/monthly/2026-01>; rel="up"; title="month",
      </periodic-note/quarterly/2026-Q1>; rel="up"; title="quarter",
      </periodic-note/yearly/2026>; rel="up"; title="year"
```

### Comparison with Base `/periodic/` API

| Feature | Base `/periodic/` | New `/periodic-note/` |
|---------|------------------|----------------------|
| Date-specific access | ❌ Current only | ✅ Any date |
| Direct period targeting | ❌ No | ✅ Yes (2026-W03, 2026-03, etc.) |
| PATCH operations | ⚠️ Heading only | ✅ Full (heading/block/frontmatter) |
| NoteJson format | ❌ No | ✅ Yes |
| Section extraction | ❌ No | ✅ Yes |
| Wiki-link resolution | ❌ No | ✅ Yes (via delegation) |

### Requirements

The [Periodic Notes](https://github.com/liamcain/obsidian-periodic-notes) plugin must be installed and enabled to use `/periodic-note/*` endpoints.

## License

[MIT](LICENSE)
