---
name: jira-assistant
description: Interact with Jira board — view, create, update, transition, and comment on issues using natural language
---

<!--
  CONFIGURED FOR: maja2811
  =================================
  Credentials:
  - Project and board details are hardcoded below (non-sensitive).
  - Primary authentication uses the configured Atlassian Rovo MCP server with OAuth.
  - REST API credentials are fallback only and must never be preferred when MCP is available.

  To authenticate:
    1. Enable the `atlassian` MCP server and follow MCP OAuth recovery below.
    2. Give the user the live authorization link to sign in with their DSB account.
    3. Use REST API credentials only if MCP is unavailable or lacks a required operation.
-->

## Connection Details

- **Jira URL:** `https://dsbdk.atlassian.net` (internal users may use `https://jira.at.dsb.dk` in a browser)
- **User:** Atlassian account email from `JIRA_CLOUD_EMAIL` or `ATLASSIAN_EMAIL`
- **Auth method:** Atlassian Rovo MCP OAuth, using the signed-in user's Jira permissions
- **REST fallback:** Jira Cloud basic authentication with Atlassian email and API token
- **Default Project:** `BIC` (BI_Commercial). Use this as the assumed project when none is specified. If the user mentions a different project key, use that instead.
- **Default Board:** current team board ID `721` — `https://dsbdk.atlassian.net/jira/people/712020:102d4b6b-b014-4ec8-b66d-b92e07d281b0/boards/721`. Use this board when the user refers to "my board" or "my tasks" without specifying a board. Before board-scoped reads or writes, discover its current Cloud metadata and filter; do not assume a migrated board name, project, or filter.

When REST fallback is necessary, PowerShell API calls construct a Basic auth header from the Atlassian email and API token:
```
$email = if ($env:JIRA_CLOUD_EMAIL) { $env:JIRA_CLOUD_EMAIL } else { $env:ATLASSIAN_EMAIL }
$token = if ($env:JIRA_CLOUD_API_TOKEN) { $env:JIRA_CLOUD_API_TOKEN } elseif ($env:JIRA_API_TOKEN) { $env:JIRA_API_TOKEN } else { $env:ATLASSIAN_API_TOKEN }
$basic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("${email}:${token}"))
-H "Authorization: Basic $basic"
```

> NOTE: Prefer MCP OAuth. If REST fallback returns 401, configure the Cloud email and API token and restart OpenCode.

REST fallback base URL: `https://dsbdk.atlassian.net/rest/api/3`
Use `https://jira.at.dsb.dk` only if it is confirmed to proxy the same Cloud tenant. Prefer the Atlassian Cloud hostname for API calls.

## Active DQX Migration Plan

For the currently planned legacy-to-DQX migration, follow
`bi-dlh-helper/plans/025-jira-dqx-migration.md`. Create one coordinating
Feature in BIC, then repository Tasks beneath it. Set Gitte Nørby Johnsen as
reporter and place all issues in Backlog. Resolve the reporter, the current
authenticated user, and every requested assignee to Jira Cloud `accountId`
values before writing; the Feature is assigned to the current authenticated
user. Use team board `721` only after discovering its current Cloud metadata
and filter. Do not repeat the dashboard investigation.

- Include Runtime 18, latest compatible `dlh-dmt-helper`, DQX YAML, `dq_check()`, central result reporting, preserved check coverage, tests, and deployment validation.
- Exclude `bi-dlh-src-commercial-tele` because no known legacy Soda checks ran in the previous seven days.
- For `bi-dlh-src-commercial-check-ind`, assign the current authenticated user and `milimat0810` only when multiple assignees are supported. Otherwise assign the current user and mention the resolved Jira identity for `milimat0810` in the Task.
- For `bi-dlh-src-commercial-cayzn`, assign the current authenticated user and `milimat0810` using the same fallback.
- For `bi-dlh-src-operations-sap-pm`, assign the current authenticated user instead of `Lukasz-Debski`.
- Keep all other repository assignments from the verified top-contributor plan unless the user changes them.


## Referring to Issues by Title

Users can refer to issues by their title (summary) instead of the issue key (e.g., DLS-42).

When the user refers to an issue by title (anything in quotes or that doesn't match the KEY-123 pattern):

1. **Search for the issue** using JQL, prioritizing the user's own assigned issues:
   ```
    summary ~ "user's text" AND assignee = currentUser() ORDER BY updated DESC
   ```

2. **If exactly 1 result** — proceed with the requested action immediately.

3. **If multiple results** — show the user a numbered list with issue key, full summary, status, and project. Ask which one they meant.

4. **If 0 results** — broaden the search by removing the assignee filter:
   ```
   summary ~ "user's text" ORDER BY updated DESC
   ```
   If still no results, tell the user no matching issues were found.

## Operations

### MCP usage

Use the configured `atlassian` MCP server for Jira searches, issue reads, issue creation, updates, comments, and transitions whenever it is available. MCP uses OAuth and acts with the signed-in user's permissions.

Before any write operation, use MCP to verify the target project, issue types, required fields, users, and current issue state. Do not mix MCP and REST for one write unless MCP lacks the required operation.

If MCP needs authentication, follow MCP OAuth recovery below first. Use the documented Jira Cloud REST fallback only when MCP is unavailable or lacks a required operation and the user has configured fallback credentials. Never use the retired Server endpoint or Server PAT.

> **IMPORTANT — Default behavior:** When this skill is loaded via `/jira` (or any trigger that doesn't include an explicit action like "show my tasks", "create a task", etc.), do **NOT** automatically fetch or display issues. Always wait for the user's next instruction first.

### 0. Await Command (`/jira`) — DEFAULT

When the user types `/jira` **without** an explicit action in the same message, do **NOT** fetch any issues. Simply respond with:

> Jira assistant ready. What would you like to do? (e.g., show my tasks, create a task, update an issue, move a task to a new status)

Only fetch issues when the user explicitly asks for them (e.g., "show my tasks", "my board", "show current tasks").

### 1. View Issues in a Project or Board

For a board-scoped request, first retrieve board `721` metadata and its current
filter through Atlassian MCP. Use the discovered filter/JQL to retrieve its
issues, then apply an authenticated-user assignee constraint for personal
requests. Never infer a board's scope from its URL or reuse a legacy board ID.

```bash
  # Use the Basic auth header shown above.
  curl -s -H "Authorization: Basic $basic" \
  "https://dsbdk.atlassian.net/rest/api/3/search/jql?jql=project%3D{PROJECT_KEY}+AND+assignee%3D%22{ACCOUNT_ID}%22+AND+resolution%3DUnresolved+ORDER+BY+updated+DESC&fields=summary,status,priority,issuetype,assignee&maxResults=20"
```

### 2. Search with JQL

Allow the user to provide arbitrary JQL or translate their natural language into JQL.

> **HARD RULE — ASSIGNEE ENFORCEMENT:** Always constrain personal searches to the authenticated Atlassian `accountId`. After receiving the API response, loop through every item and check `fields.assignee.accountId`. Do not include issues assigned to another account.

```bash
curl -s -H "Authorization: Basic $basic" \
  "https://dsbdk.atlassian.net/rest/api/3/search/jql?jql={URL_ENCODED_JQL}&fields=summary,status,priority,issuetype,project,assignee&maxResults=25"
```

### 3. View Issue Details

```bash
curl -s -H "Authorization: Basic $basic" \
  "https://dsbdk.atlassian.net/rest/api/3/issue/{ISSUE_KEY}"
```

Present a summary including: key, summary, status, type, priority, assignee, reporter, description, and recent comments.

### 4. Create an Issue

**Before creating an issue, resolve its placement and acceptance criteria. Do not create it until the applicable items below are settled.**

**1. Parent feature**
> "What feature does this belong to? (paste the feature/epic key like BIC-123, or say 'backlog' if it goes to the backlog)"

- If the user provides a key, look it up to confirm the title, then discover the Cloud hierarchy field through create metadata before including it. Do not assume old Server custom-field IDs.
- An issue may be created without a parent when it is explicitly destined for the backlog or when the user identifies the project as a maintenance/support board without feature hierarchy. Otherwise, treat a bare "none" as unresolved and ask again: a parent feature, or the backlog.

**2. Sprint**
> "Which sprint should this go in?"

- Skip this question when the issue is going to the backlog or the user identifies the project as a maintenance/support board. Do not set a sprint in either case unless the user explicitly requests one.
- Discover the sprint field ID from create metadata (`getJiraIssueTypeMetaWithFields`) — it is a tenant-specific custom field. Never hardcode a Server-era field ID.
- Find candidate sprints before offering options (for example JQL `project = <KEY> AND sprint in openSprints()`, or the board's sprint list). Do not invent sprint names or IDs.
- If no sprint is active or the user is unsure, say so and place the issue in the backlog rather than guessing.

**3. Acceptance criteria**

- Required on Tasks and Stories. Do not create one without them.
- Draft them from the context of the conversation, then show the draft and ask the user to confirm or adjust. Do not silently invent criteria and do not leave the section out.
- For Bugs, expected-vs-actual behaviour serves this purpose. Sub-tasks may inherit the parent's criteria — say so explicitly rather than omitting silently.
- If the user genuinely cannot define them yet, create the issue in the backlog and note that acceptance criteria are outstanding.

### 4a. Description Format and Template (DSB/BIC Standard)

Jira Cloud descriptions and comments must be sent as Atlassian Document Format (ADF). Never submit Jira wiki markup (`h2.`, `#`, or `*`) as literal description text: it will render incorrectly.

Keep descriptions concise by default. Use plain ADF paragraphs, headings, and bullet/numbered lists only where they improve readability. Use the full structure below when the task needs that context; omit empty sections and collapse short support tasks to the essential context and acceptance criteria.

**Always include:**
- Background heading — context and reason for the task
- Purpose heading — what the task aims to achieve
- Users heading — who will use or benefit from the output
- Acceptance Criteria heading — numbered conditions that must be true for the task to be considered done

**Only include if the user provides content:**
- Refinement Notes heading — open questions, assumptions, or things to clarify before/during development

**Rules:**
- Never include a section with placeholder text (e.g. "_To be filled in_") — omit the section entirely if there is no content for it
- Acceptance Criteria are required on Tasks and Stories (see step 4) — draft them and confirm with the user rather than omitting the section
- Refinement Notes are optional — do not prompt the user for them unless they ask, or unless context clearly warrants it
- When the user provides notes, requirements, or bullet points, use your judgement to distribute content across the appropriate sections
- Acceptance Criteria items should be written as independently verifiable statements (not vague goals)

### 4b. Refinement + Acceptance Criteria Template (Power BI tasks)

When the user asks to "refine" a task or "write acceptance criteria" for a Power BI-related issue, always use this specific structure. Apply it whether the task is a new report, dashboard, data model, or any BI deliverable.

**Structure to use (rendered as ADF headings and lists):**

```
Background
{Explain why this task exists - what business need or gap it addresses}

Purpose
{What the deliverable aims to achieve - the outcome, not the activity}

Users
{Who will use or benefit from this - be specific about roles or teams}

Refinement Notes
- {Open question or assumption #1}
- {Open question or assumption #2}
- {Add more as needed - things to clarify before or during development}

Acceptance Criteria
1. {Functional requirement 1 - specific and verifiable}
2. {Functional requirement 2}
3. {... task-specific criteria derived from the requirements ...}
4. The report/dashboard is built in accordance with DSB BI best practices (naming conventions, data model structure, DAX patterns, and visual standards)
5. The report/dashboard has been validated through the PBI Reviewer tool and passes all applicable governance and BPA checks
6. The report/dashboard is published to the DSB enterprise Power BI capacity (not a personal or shared capacity)
7. The report workspace and access permissions are configured so that all relevant end users can view the report
8. The report has been reviewed and formally accepted by the designated stakeholder
```

**Rules for this template:**
- The last 5 Acceptance Criteria items (DSB best practices, PBI Reviewer, enterprise capacity, access permissions, stakeholder sign-off) are **always included** for any Power BI task — do not omit them
- Task-specific criteria (the functional ones) come **before** the standard DSB/governance criteria
- Refinement Notes should capture open questions about data sources, definitions, filters, time granularity, and access — use your judgement based on the task description
- If the issue already has a partial description, preserve and incorporate existing content rather than replacing it wholesale
- **Before writing or updating the description, always ask the user:** "Is there a specific stakeholder name who will sign off on this? (e.g., 'Morten', or say 'unknown' to leave it generic)" — then substitute the name into the final AC item: "The report has been reviewed and formally accepted by {Name}"

For REST fallback, construct an ADF document with structured nodes for headings and lists. Do not serialize wiki markup into an ADF paragraph.

> Cloud custom fields are tenant-specific. Discover the field ID and schema through `/rest/api/3/field` and create metadata before using an Epic/Feature link. Do not reuse Server field IDs blindly.

Issue type IDs and names are Cloud-tenant-specific. Discover them with project create metadata before creating an issue. Resolve users with `accountId`, not the removed Server `name` or `key` fields.

After creating, confirm with the new issue key and a link: `https://dsbdk.atlassian.net/browse/{KEY}`

### 5. Update an Issue

```bash
curl -s -X PUT \
  -H "Authorization: Basic $basic" \
  -H "Content-Type: application/json" \
  -d "{\"fields\":{\"{FIELD_NAME}\":\"{NEW_VALUE}\"}}" \
  "https://dsbdk.atlassian.net/rest/api/3/issue/{ISSUE_KEY}"
```

Common fields: `summary`, `description`, `priority`, `assignee` (use `{"accountId": "ACCOUNT_ID"}`), `labels`.

### 6. Add a Comment

```bash
curl -s -X POST \
  -H "Authorization: Basic $basic" \
  -H "Content-Type: application/json" \
  -d "{\"body\":{\"type\":\"doc\",\"version\":1,\"content\":[{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"{COMMENT_TEXT}\"}]}]}}" \
  "https://dsbdk.atlassian.net/rest/api/3/issue/{ISSUE_KEY}/comment"
```

### 7. Transition an Issue (Change Status)

#### Cloud Transition Handling

Jira Cloud transition IDs are tenant/workflow-specific. Fetch transitions for
every issue, match the exact target status name, then apply the returned ID.
Never reuse Server IDs, cached Cloud IDs, or a transition ID from another
issue, including BIC issues.

First fetch available transitions:

```bash
curl -s -H "Authorization: Basic $basic" \
  "https://dsbdk.atlassian.net/rest/api/3/issue/{ISSUE_KEY}/transitions"
```

Map common user language to transition names:
- "to do", "backlog" — look for transitions like "To Do", "Backlog", "Open"
- "in progress", "start" — look for "In Progress", "Start Progress"
- "done", "close", "finish", "complete" — look for "Done", "Close", "Resolve", "Complete"
- "review", "in review" — look for "In Review", "Ready for Review"
- "blocked" — look for "Blocked"
- "in test", "testing" — look for "In Test"

If the target status is unavailable, report available transitions and stop instead of guessing.

## Output Formatting Rules

1. **Always present issue lists as proper markdown tables** with columns: Key, Status, Type, Priority, Summary
2. **Key column must be a clickable link** using the format `[KEY](https://dsbdk.atlassian.net/browse/KEY)`
3. **Always include the Priority column** — extract `fields.priority.name`
4. **Do NOT truncate summaries** in tables — show the full summary text
5. **Include a summary line after the table** that describes the breakdown of statuses (e.g., "You have 1 item **In Progress**, 1 **To Do**, and 3 **In Test**.")
6. **If all issues are in the same project**, mention that above or below the table (e.g., "All issues are in the **BIC** project.")
7. **If issues span multiple projects**, add a Project column to the table
8. **Show total count** when listing issues: "Showing 15 of 42 results" (only if results are paginated/capped)
9. **Status should be human-readable** — extract `fields.status.name` not the raw status object
10. **Do NOT use python to parse JSON** — present the output directly in markdown

## Error Handling

- If MCP needs sign-in or returns an authentication error, follow MCP OAuth recovery below. Use API-token fallback only when the user explicitly configures it.
- If MCP returns 403, especially `The app is not installed on this instance`, and the user can open the issue in their browser, try fresh OAuth consent before escalating to an admin. A connected MCP server and successful identity lookup do not prove that its Jira grant is sufficient. Do not diagnose an app-installation or project-permission failure from this message alone.
- If REST fallback returns 401, the Cloud email or API token is missing/invalid. Tell the user to generate a token at https://id.atlassian.com/manage-profile/security/api-tokens, set `JIRA_CLOUD_EMAIL` and `JIRA_CLOUD_API_TOKEN`, and fully restart OpenCode.
- If a 404 is received, the issue or project likely doesn't exist — ask the user to double-check
- If a 400 is received, show the error message from Jira to help debug the request
- Always check HTTP status codes and handle errors gracefully

### MCP OAuth recovery (give the authorization link)

1. Remind the user to reauthorize Atlassian MCP. Use `/mcps` → `atlassian` → sign in by default. If the user asks the agent to run the command, run `opencode.cmd mcp auth atlassian` in the background with no timeout (`background: true`, `timeout: 0`), so the browser flow has time to finish. Do not log out or clear credentials without approval.
2. When running the command, read its current output once to retrieve the live `https://auth.atlassian.com/authorize?...` URL and give the user a clickable **Authorize Atlassian** link. Do this even if the command says it opened a browser; the user may see no popup. Copy the complete URL unchanged from this attempt. Do not invent, truncate, reuse, or save an old authorization URL in the skill.
3. Ask the user to use their DSB account and select `dsbdk.atlassian.net` if prompted. Keep the command running while they authorize. Wait for the background completion notification rather than polling. If the command times out, do not report success; its callback may no longer work, so start a fresh attempt when needed and provide its new link.
4. After the command confirms connection, retry the failed Jira read through the `jira` agent. Report whether it succeeds; command-level connection alone does not confirm issue access. Escalate to Atlassian/site admins if the same 403 persists after fresh consent, sharing the exact sanitized error and the checks performed.

## Execution Mode: Use Sub-Agent (Task Tool)

**IMPORTANT:** Use the configured Atlassian MCP for Jira operations when available. Delegate REST fallback calls to a sub-agent using the Task tool (subagent_type: "general") so raw credentials and API output stay out of the conversation. The user should only see the final formatted result (markdown tables, confirmation messages, etc.).

When the user makes a Jira request:
1. Load this skill to understand the operation needed.
2. Use Atlassian MCP tools directly for the operation when available.
3. If MCP cannot perform the operation, launch a "general" sub-agent using the **Sub-Agent Prompt Template** below for REST fallback.
4. Present only the final formatted result to the user.

### Sub-Agent Prompt Template

Use this compact template when launching sub-agents. Copy it verbatim and only replace `{OPERATION}`. The sub-agent runs PowerShell and must construct the Cloud Basic auth header from the environment variables above:

```
You are a Jira Cloud API helper running on Windows PowerShell.
Construct Basic auth from `$env:JIRA_CLOUD_EMAIL` or `$env:ATLASSIAN_EMAIL` and `$env:JIRA_CLOUD_API_TOKEN`, `$env:JIRA_API_TOKEN`, or `$env:ATLASSIAN_API_TOKEN`.
Base URL: https://dsbdk.atlassian.net/rest/api/3
Browse URL: https://dsbdk.atlassian.net/browse/{KEY}
Resolve the authenticated user via GET /myself and use its accountId. Default project: BIC.
Cloud transition IDs and custom-field IDs are not cached. Discover them before use.

TASK: {OPERATION}

OUTPUT RULES:
- Return ONLY the final formatted markdown, no raw JSON or curl explanations
- Issue lists: markdown table with columns Key, Status, Type, Priority, Summary
- Keys must be clickable links: [KEY](https://dsbdk.atlassian.net/browse/KEY)
- Include a summary line after tables (status breakdown, total count)
- If all issues are in the same project, mention it
- If 0 results, say so clearly
- For transitions: confirm the issue key, old status, and new status
- For creates/updates: confirm with issue key and link
- ASSIGNEE FILTER (HARD RULE): For personal issue lists, use the authenticated user's `accountId` from `/myself`, constrain JQL to `assignee = currentUser()`, and verify `fields.assignee.accountId` before output.
```

### Session Loading Rule

Only load this skill **once per conversation**. After the first load, you already have the connection details, Cloud account-ID/auth rules, formatting rules, and sub-agent template in context. Do NOT re-load the skill for subsequent Jira requests in the same session.

## When to use me

Use this skill whenever the user mentions "jira" in their request or clearly wants to interact with their Jira board (e.g., "show my tasks", "what am I working on", "create a ticket", `/jira`).
