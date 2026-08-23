# DOGGS External Archive API

Use DOGGS as a read-only local document archive. The API is disabled until the DOGGS host sets `EXTERNAL_API_TOKEN` in its environment and restarts the app.

## Connection

- Base URL: `http://<doggs-host>:<PORT>/api/external/v1`
- Authentication: `Authorization: Bearer <EXTERNAL_API_TOKEN>`
- Do not send the bearer token in URLs, prompts, logs, or committed files.
- The API returns `smb_url` pointers for original documents. Open those through the SMB client only when the user needs the source file.

## Workflow

1. Call `GET /catalog` to discover valid years, categories, and tags.
2. Call `GET /documents` with a focused natural-language `q` plus optional comma-separated `years`, `categories`, and `tags` filters.
3. Use `limit` between 1 and 100; begin with a small limit.
4. Call `GET /documents/<id>` only for a selected result.
5. Treat the returned summary and metadata as an index; use `smb_url` to inspect the original document when accuracy depends on its contents.

## Search Examples

```text
GET /documents?q=insurance&categories=insurance&limit=10
GET /documents?years=2025,2026&tags=invoice,utilities
GET /documents/<document-id>
```

## Safety

- This API is read-only. Do not infer that documents can be changed, deleted, or reclassified through it.
- Never expose archive data or SMB URLs outside the user's trusted network context.
- If `smb_url` is empty, ask the user to configure the SMB share in DOGGS Settings -> External API.
