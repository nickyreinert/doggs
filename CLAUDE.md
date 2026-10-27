# DOGGS External Archive API

Use DOGGS as a read-only local document archive. The API is disabled until the DOGGS host sets `EXTERNAL_API_TOKEN` in its environment and restarts the app.

## Connection

- Base URL: `http://<doggs-host>:<PORT>/api/external/v1`
- Authentication: `Authorization: Bearer <EXTERNAL_API_TOKEN>`
- Do not send the bearer token in URLs, prompts, logs, or committed files.
- The API returns `smb_url` pointers for original documents. Open those through the SMB client only when the user needs the source file.

## MCP

If the client supports MCP, connect to `http://<doggs-host>:<PORT>/api/external/v1/mcp` (Streamable HTTP, same bearer token) and use its tools: `search_documents`, `list_documents`, `get_document`, `get_document_text`, `list_catalog`. Clients that only launch local servers can use `mcp_stdio.py` with `DOGGS_URL` and `DOGGS_TOKEN` set.

## Workflow

1. Call `GET /catalog` to discover valid years, categories, and tags.
2. Call `GET /search` with a focused query, preferably in German because most documents are German. Add optional comma-separated `years`, `categories`, and `tags` filters. `mode` is `hybrid` (default), `keyword`, or `semantic`.
3. Use `limit` between 1 and 100; begin with a small limit. Results carry `snippets` with the best matching passages.
4. Call `GET /documents/<id>/text` to read a selected document's full text. Follow `next_offset` for long documents.
5. Use `GET /documents` for metadata-only listing and filtering, and `GET /documents/<id>` for one document's metadata.
6. Treat the summary and metadata as an index. Read the text, or open `smb_url`, when accuracy depends on the contents.

## Search Examples

```text
GET /search?q=Kaution%20Mietvertrag&limit=5
GET /search?q=Steuerbescheid%20Erstattung&years=2023,2024&mode=hybrid
GET /documents/<document-id>/text?offset=0&limit=20000
GET /documents?years=2025,2026&tags=invoice,utilities
```

## Safety

- This API is read-only. Do not infer that documents can be changed, deleted, or reclassified through it.
- Never expose archive data or SMB URLs outside the user's trusted network context.
- If `smb_url` is empty, ask the user to configure the SMB share in DOGGS Settings -> External API.
