---
name: "dlh-confluence"
description: "Connect to DSB's Confluence Server (confluence.dsb.dk) and read pages: find a page or project, read its content and children, and search with CQL. Read-only. Use when a task needs information from Confluence."
metadata:
  version: "2.0.0"
---

# DSB Confluence (read-only)

Connect to `https://confluence.dsb.dk` and read pages. This skill does not create, update or
delete pages. If a task needs a write, ask the user first.

## Connect

DSB Confluence is **Confluence Server**, not Cloud. Authenticate with a Personal Access Token
(PAT) as a **Bearer** token. Basic auth returns 401.

Use `$env:CONFLUENCE_TOKEN` when set. Otherwise ask the user for a PAT, created at
https://confluence.dsb.dk/plugins/personalaccesstokens/usertokens.action. To keep it across
sessions: `[System.Environment]::SetEnvironmentVariable("CONFLUENCE_TOKEN", "<token>", "User")`.

```powershell
$headers = @{ Authorization = "Bearer $env:CONFLUENCE_TOKEN" }
$me = Invoke-RestMethod -Uri "https://confluence.dsb.dk/rest/api/user/current" -Headers $headers -TimeoutSec 15
"Connected as $($me.displayName)"
```

Never write the token to files, logs, commits or PR text.

## Find a page

A link like `https://confluence.dsb.dk/pages/viewpage.action?pageId=210410057&spaceKey=SCBA`
already contains the page ID. Otherwise search with CQL:

```powershell
$cql = [uri]::EscapeDataString('space=DWBI AND type=page AND title~"Customer Sales Flow"')
(Invoke-RestMethod -Uri "https://confluence.dsb.dk/rest/api/content/search?cql=$cql&limit=25" -Headers $headers).results |
    ForEach-Object { "$($_.id) | $($_.title)" }
```

- Drop `space=DWBI AND` to search all spaces. Use `text~"..."` to search page content.
- DLH project pages live in the `DWBI` space under the owning team's page, for example
  Team BI Operations (`78027516`). Take the owning team from the repository README. To list a
  team's projects, read the team page's children.
- Titles do not follow the repository name. Try the project title from the README
  (e.g. `csf` is "Customer Sales Flow") and keywords from the repo name.

## Read

```powershell
# Content (storage format HTML), version and children
$page = Invoke-RestMethod -Uri "https://confluence.dsb.dk/rest/api/content/$pageId?expand=body.storage,version,children.page" -Headers $headers
$page.title
$page.body.storage.value

# All child pages, paged (default limit 25, max 200)
$start = 0; $children = @()
do {
    $r = Invoke-RestMethod -Uri "https://confluence.dsb.dk/rest/api/content/$pageId/child/page?limit=100&start=$start" -Headers $headers
    $children += $r.results; $start += 100
} while ($r.size -eq 100)
```

The body is Confluence storage format (XHTML with `ac:` macros). Strip tags or read it as HTML.
Diagrams in Gliffy/draw.io macros are attachments and are not in the body text.

## Troubleshooting

| Issue | Fix |
|---|---|
| 401 | Use `Bearer <token>`, not Basic auth. Otherwise the PAT expired: create a new one |
| 403 | No read access to the space. Ask the space admin |
| 404 | Wrong page ID or no access. Search by title |
| Timeout | Connect to the DSB network or VPN |
| Missing children | Page with `limit` and `start` |
