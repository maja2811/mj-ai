---
name: "dlh-confluence"
description: "Connect to DSB's Confluence Server, discover team projects, and read or write pages. Use when reading Confluence documentation, finding a DLH project's space, or creating/updating pages."
metadata:
  version: "1.0.0"
---

# DLH Confluence Integration

Connect to DSB's Confluence Server, discover team projects, and read/write pages.

## When to Use This Skill

- Connecting to Confluence for the first time in a session
- Finding a DLH project's documentation in Confluence
- Reading Confluence page content
- Creating or updating Confluence pages
- Searching for content across the DWBI space

## Prerequisites

- A Confluence Personal Access Token (PAT) for `https://confluence.dsb.dk`
- The token must have read/write permissions to the DWBI space

## Authentication

### Step 1: Obtain the Token

**CRITICAL: Ask the user for their Confluence PAT at the start of every session that needs Confluence access.**

Prompt the user:
> To connect to Confluence, I need your Personal Access Token (PAT).
> You can create one at: https://confluence.dsb.dk/plugins/personalaccesstokens/usertokens.action
> Please paste your token here.

Alternatively, check if the user has set the environment variable `CONFLUENCE_TOKEN`:
```powershell
$token = $env:CONFLUENCE_TOKEN
```

If neither is available, guide the user:
1. Go to https://confluence.dsb.dk
2. Click profile icon (top right) > Settings > Personal Access Tokens
3. Create a new token with a descriptive name (e.g., "opencode-agent")
4. Copy the token value

To persist the token across sessions, suggest:
```powershell
[System.Environment]::SetEnvironmentVariable("CONFLUENCE_TOKEN", "<token>", "User")
```

### Step 2: Test the Connection

DSB Confluence is a **Confluence Server** instance (not Cloud). Authentication uses **Bearer tokens**, NOT Basic auth.

```powershell
$token = "<USER_TOKEN>"
$headers = @{ Authorization = "Bearer $token" }

$response = Invoke-RestMethod -Uri "https://confluence.dsb.dk/rest/api/user/current" -Headers $headers -Method Get -TimeoutSec 15
Write-Output "Connected as: $($response.displayName) ($($response.username))"
```

**IMPORTANT**: Do NOT use Basic auth (`username:token` base64). It returns 401 on this server. Always use `Bearer <token>`.

## Team & Project Discovery

### Team Page

The Team BI Operations page is the root for all DLH projects:

| Property | Value |
|----------|-------|
| Space | `DWBI` |
| Page ID | `78027516` |
| Title | `Team BI Operations` |
| URL | `https://confluence.dsb.dk/spaces/DWBI/pages/78027516/Team+BI+Operations` |

### Finding a Project

Projects are child pages of Team BI Operations. Naming is **not strict** -- you must search by fuzzy match.

**Step 1: List all projects**

```powershell
$headers = @{ Authorization = "Bearer $token" }
$response = Invoke-RestMethod -Uri "https://confluence.dsb.dk/rest/api/content/78027516?expand=children.page" -Headers $headers -Method Get
foreach ($child in $response.children.page.results) {
    Write-Output "$($child.title) (id: $($child.id))"
}
```

**Step 2: Match to current repository**

Extract keywords from the repo name and search the child page titles:

```
Repository: bi-dlh-datamart-ivu-crew
Keywords to match: "ivu", "crew"
Match: "IVU - Crew" (id: 71965163)
```

Common patterns:
- `bi-dlh-src-*` and `bi-dlh-datamart-*` repos map to the same Confluence project page
- Strip prefixes (`bi-dlh-src-`, `bi-dlh-datamart-`, `bi-dlh-`) to get the project name
- Split on `-` and match remaining words against page titles (case-insensitive)
- If multiple matches or no match, present the full list and ask the user to pick

**Step 3: Use CQL search as fallback**

```powershell
$searchTerm = "IVU Crew"
$cql = [uri]::EscapeDataString("ancestor=78027516 AND title~""$searchTerm""")
$response = Invoke-RestMethod -Uri "https://confluence.dsb.dk/rest/api/content/search?cql=$cql" -Headers $headers -Method Get
```

### Known Projects (Team BI Operations)

As of last scan, these projects exist under Team BI Operations (page 78027516):

| Project | Page ID |
|---------|---------|
| Azure DLH: Migrations | 217290465 |
| Azure DLH: short term solutions | 215385402 |
| Azure function groups | 215384822 |
| Belægningsmodel (Azure) | 252609598 |
| DLS & Onboard | 210407901 |
| DS Energy | 207594782 |
| EREX - Intro page | 167094105 |
| GLOVA | 207594772 |
| INFA to DLH | 240567268 |
| Int - Train | 268206127 |
| IVU - Crew | 71965163 |
| IVU Overtime | 223905276 |
| IVU - Train | 144835270 |
| RDS (Azure) | 210407898 |
| SAP PM | 207594775 |
| TCI2 | 207594784 |
| Team info | 240559763 |
| TTI | 252609173 |

**NOTE**: This list may be outdated. Always fetch the live list from the API.

## REST API Reference

Base URL: `https://confluence.dsb.dk`

All requests require: `Authorization: Bearer <token>`

### Read Operations

```powershell
# Get page with body content
Invoke-RestMethod -Uri "https://confluence.dsb.dk/rest/api/content/{pageId}?expand=body.storage" -Headers $headers

# Get page with children
Invoke-RestMethod -Uri "https://confluence.dsb.dk/rest/api/content/{pageId}?expand=children.page" -Headers $headers

# Get page with body AND children
Invoke-RestMethod -Uri "https://confluence.dsb.dk/rest/api/content/{pageId}?expand=body.storage,children.page,version" -Headers $headers

# Get page permissions/operations
Invoke-RestMethod -Uri "https://confluence.dsb.dk/rest/api/content/{pageId}?expand=operations" -Headers $headers

# Search with CQL
$cql = [uri]::EscapeDataString("space=DWBI AND title=""Some Title""")
Invoke-RestMethod -Uri "https://confluence.dsb.dk/rest/api/content/search?cql=$cql" -Headers $headers

# List all children (with pagination)
Invoke-RestMethod -Uri "https://confluence.dsb.dk/rest/api/content/{pageId}/child/page?limit=50&start=0" -Headers $headers
```

### Write Operations

**Create a child page:**

```powershell
$body = @{
    type = "page"
    title = "New Page Title"
    ancestors = @(@{ id = $parentPageId })
    space = @{ key = "DWBI" }
    body = @{
        storage = @{
            value = "<p>Page content in Confluence storage format (HTML)</p>"
            representation = "storage"
        }
    }
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Uri "https://confluence.dsb.dk/rest/api/content" `
    -Headers @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" } `
    -Method Post -Body $body
```

**Update an existing page:**

```powershell
# First, get the current version number
$current = Invoke-RestMethod -Uri "https://confluence.dsb.dk/rest/api/content/{pageId}?expand=version" -Headers $headers
$newVersion = $current.version.number + 1

$body = @{
    id = "{pageId}"
    type = "page"
    title = "Page Title"
    version = @{ number = $newVersion }
    body = @{
        storage = @{
            value = "<p>Updated content</p>"
            representation = "storage"
        }
    }
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Uri "https://confluence.dsb.dk/rest/api/content/{pageId}" `
    -Headers @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" } `
    -Method Put -Body $body
```

**Delete a page:**

```powershell
Invoke-RestMethod -Uri "https://confluence.dsb.dk/rest/api/content/{pageId}" `
    -Headers $headers -Method Delete
```

### Pagination

The Confluence API paginates results. Default limit is 25. Max is 200.

```powershell
$start = 0
$limit = 50
$allResults = @()

do {
    $response = Invoke-RestMethod -Uri "https://confluence.dsb.dk/rest/api/content/{pageId}/child/page?limit=$limit&start=$start" -Headers $headers
    $allResults += $response.results
    $start += $limit
} while ($response.size -eq $limit)
```

## Confluence Storage Format

Page content uses Confluence storage format (a subset of XHTML). Key elements:

| Element | Usage |
|---------|-------|
| `<p>` | Paragraph |
| `<h2>`, `<h3>`, `<h4>` | Headings |
| `<strong>` | Bold |
| `<em>` | Italic |
| `<code>` | Inline code |
| `<table><tbody><tr><th>/<td>` | Tables |
| `<ul><li>`, `<ol><li>` | Lists |
| `<ac:structured-macro>` | Confluence macros (TOC, Gliffy, etc.) |
| `<ac:link><ri:user ri:userkey="..."/>` | User mentions |
| `<ac:image>` | Embedded images |

When creating/updating pages, write content in this HTML format. Do NOT use markdown -- Confluence Server does not render it.

## Troubleshooting

| Issue | Cause | Solution |
|-------|-------|---------|
| 401 Unauthorized | Wrong auth method | Use `Bearer <token>`, NOT Basic auth |
| 401 Unauthorized | Token expired or revoked | Generate a new PAT in Confluence |
| 403 Forbidden | No write permissions to space | Ask space admin for write access to DWBI |
| 404 Not Found | Page ID doesn't exist | Verify the page ID via search or navigation |
| 409 Conflict | Version conflict on update | Re-fetch current version number and retry |
| Connection timeout | VPN not connected | Ensure you're on the DSB network or VPN |
| Empty children list | Pagination needed | Use `limit` and `start` parameters |

## Security Notes

- NEVER commit or log the Confluence token
- NEVER include the token in skill files, PR descriptions, or git history
- The token is personal -- each user has their own
- Tokens can be revoked at: https://confluence.dsb.dk/plugins/personalaccesstokens/usertokens.action
