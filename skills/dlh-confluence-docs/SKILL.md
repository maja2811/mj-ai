---
name: "dlh-confluence-docs"
description: "Manage Danish project documentation in Confluence for DLH projects under Team BI Operations. Use when reading, auditing, creating, or updating documentation pages after code or business-rule changes. Depends on dlh-confluence for connection."
metadata:
  version: "1.0.0"
---

# DLH Confluence Documentation Management

Manage project documentation in Confluence for DLH projects under Team BI Operations. All documentation is written in Danish. Supports reading, auditing, creating, and updating documentation pages.

## When to Use This Skill

- Checking if Confluence documentation is up to date after code changes
- Writing new documentation for a DLH project in Confluence
- Auditing existing documentation against code/business rules
- Creating standard documentation pages for a new or existing project
- Updating business rule documentation after a feature or hotfix
- End-of-cycle documentation review

## Prerequisites

- `dlh-confluence` skill loaded (for connection and API patterns)
- Confluence PAT obtained (via user prompt or `CONFLUENCE_TOKEN` env var). If no token is available, direct the user to create one at: https://confluence.dsb.dk/plugins/personalaccesstokens/usertokens.action
- Project page already identified in Confluence (via `dlh-confluence` discovery)

## Standard Documentation Structure

Every DLH project under Team BI Operations should have these sub-pages. All content must be in **Danish**.

| Page Title | Purpose | Priority |
|------------|---------|----------|
| **Driftsdokumentation** | Jobs, schedules, source interfaces, error handling procedures | Required |
| **Forretningsregler og Beregninger** | Business rules hierarchy with sub-pages per rule domain | Required |
| **Modeloversigt** | Star schema diagram, table/dimension descriptions, PK/FK | Required |
| **Datakvalitet og Opdateringsfrekvens** | Update frequency, rolling window logic, DQ checks | Required |
| **Roller og Ansvarlige** | Team members, roles, responsibility matrix | Required |
| **Semantisk model (Power BI)** | Measures, KPIs, DAX definitions, Power BI links | If Power BI exists |
| **Adgang til Datamart og Rapporter** | How consumers access the data, permissions | Recommended |
| **Forbindelse til Data fra Power BI** | Connection guide for Power BI Desktop/Service | If Power BI exists |

### Sub-page Structure for Forretningsregler

Business rules should be split into sub-pages, one per rule domain:

```
Forretningsregler og Beregninger/
  ├── Beregning af <measure> (<column_name>)
  ├── Forretningslogik for <domain>
  └── Klassificering af <entity>
```

Each business rule page must follow this structure:
1. **Formål** - What this rule does and why
2. **Rule table** - Prioritized rules (Prioritet, Regelnavn, Hvornår/Hvordan)
3. **Opsummering** - Summary of the logic

## Writing Conventions

### Language
- ALL documentation in **Danish**
- Technical terms (table names, column names, code references) stay in English
- Use inline code formatting for table/column names: `<code>table_name</code>`

### Tone
- Write for business users and analysts, not developers
- Explain the "why" behind rules, not just the "what"
- Use clear, non-technical language for rule descriptions
- Include concrete examples where possible

### Formatting (Confluence Storage Format)

All content must be in Confluence storage format (HTML). Key patterns:

**Business Rule Table:**
```html
<table>
  <tbody>
    <tr>
      <td><strong>Prioritet</strong></td>
      <td><strong>Regelnavn</strong></td>
      <td><strong>Hvornår reglen anvendes og hvordan den virker</strong></td>
    </tr>
    <tr>
      <td><strong>1</strong></td>
      <td><strong>Rule Name</strong> (description)</td>
      <td>
        <p><strong>Gælder for:</strong> When this rule applies.</p>
        <p><strong>Beregning/Regel/Klassificering:</strong> How it works.</p>
      </td>
    </tr>
  </tbody>
</table>
```

**Section with heading and explanation:**
```html
<h3>Section Title</h3>
<h4>Formål</h4>
<p>Description of purpose...</p>
<h4>Details</h4>
<p>Detailed explanation referencing <code>table_name</code> and <code>column_name</code>.</p>
```

**Inline code for technical terms:**
```html
<span class="inline-code">column_name</span>
<!-- or simply -->
<code>column_name</code>
```

## Documentation Audit Workflow

Use this workflow to check if Confluence documentation is current after code changes.

### Step 1: Identify Code Changes

```bash
git diff main..HEAD --stat
git diff main..HEAD -- "adb/curated/" "adb/datamart/" --name-only
```

Look for changes in:
- `adb/curated/tables/` or `adb/curated/views/` -- business logic
- `adb/datamart/` -- datamart transformations
- `adb/curated/functions/` or `adb/functions/` -- shared business logic functions
- `adb/jobs/` -- job definitions (affects Driftsdokumentation)

### Step 2: Classify the Impact

| Files Changed | Documentation Impact |
|---------------|---------------------|
| `adb/curated/tables/*.py` or `adb/curated/views/*.py` | Forretningsregler, Modeloversigt |
| `adb/datamart/tables/*.py` | Modeloversigt, Semantisk model |
| `adb/jobs/*.yml` | Driftsdokumentation |
| `adb/*/data_quality/*.yml` | Datakvalitet og Opdateringsfrekvens |
| New tables/views added | Modeloversigt (new entities) |
| Column changes | Modeloversigt, Forretningsregler |

### Step 3: Read Current Documentation

Load `dlh-confluence` skill and fetch the relevant Confluence pages:

```powershell
$headers = @{ Authorization = "Bearer $token" }

# Get project page and all children
$project = Invoke-RestMethod -Uri "https://confluence.dsb.dk/rest/api/content/{projectPageId}?expand=children.page" -Headers $headers

# Read each documentation page
foreach ($child in $project.children.page.results) {
    $page = Invoke-RestMethod -Uri "https://confluence.dsb.dk/rest/api/content/$($child.id)?expand=body.storage,children.page" -Headers $headers
    # Parse and compare against code changes
}
```

### Step 4: Compare and Report

For each changed file, check if the corresponding documentation:
- Exists at all
- Mentions the affected tables/columns/rules
- Reflects the current logic (compare rule hierarchies, calculations, etc.)

Report format:
```
## Confluence Documentation Audit

### Forretningsregler og Beregninger
- [x] Page exists
- [!] WARNING: hours_worked calculation changed in code but Confluence still shows old rule hierarchy
- [ ] MISSING: New rule "Klassificering af XYZ" not documented

### Driftsdokumentation
- [x] Page exists and is current
- [x] Job schedules match job YAML definitions

### Modeloversigt
- [!] WARNING: New dimension dim_xyz added but not in model overview
```

### Step 5: Draft Updates

When documentation needs updating:
1. Read the current page content
2. Identify the specific section that needs changing
3. Draft the updated HTML content **in Danish**
4. Present the draft to the user for review
5. **Ask the user before pushing** -- never auto-update Confluence without approval
6. Update the page via the API (increment version number)

## Creating New Documentation Pages

### For a New Project

When a DLH project has no Confluence documentation yet:

1. Find or create the project page under Team BI Operations (page ID `78027516`)
2. Create each required sub-page using the templates below
3. Populate with content derived from the codebase

### Driftsdokumentation Template

```html
<p>This is the maintenance documentation for <strong>{project_name}</strong> DLH backend. All jobs that load data into DLH and maintain DLH delta tables are made in Databricks Workflows. Below is a table describing all workflow jobs.</p>
<table>
  <colgroup><col /><col /><col /><col /><col /></colgroup>
  <tbody>
    <tr>
      <th>Job name</th>
      <th>Source interfaces</th>
      <th>Description</th>
      <th>Schedule</th>
      <th>Action in case of errors</th>
    </tr>
    <tr>
      <td>{job_name}</td>
      <td>{source}</td>
      <td>{description}</td>
      <td>{schedule}</td>
      <td>{error_action}</td>
    </tr>
  </tbody>
</table>
```

Populate by reading `adb/jobs/*.yml` files for job definitions.

### Forretningsregler Template

```html
<h4>Formål</h4>
<p>Denne sektion indeholder en detaljeret gennemgang af den kerne-forretningslogik og de beregninger, der transformerer rå kildedata til de værdifulde målinger, der findes i datamarten.</p>
<p>For at forstå, <em>hvordan</em> og <em>hvorfor</em> tallene i rapporterne er, som de er, er det essentielt at have kendskab til disse regler.</p>
```

Then create sub-pages for each rule domain.

### Business Rule Sub-page Template

```html
<h3>Beregning af {measure_name} <code>{column_name}</code></h3>
<h4>Formål</h4>
<p>{Description of what this measure/rule does and why it matters}</p>
<h4>Hierarkiet af Regler</h4>
<p>Beregningen sker ved at tjekke nedenstående regler i rækkefølge. Så snart en regel opfyldes, bruges den til at beregne {measure}, og systemet går ikke videre til de næste regler.</p>
<table>
  <tbody>
    <tr>
      <td><strong>Prioritet</strong></td>
      <td><strong>Regelnavn</strong></td>
      <td><strong>Hvornår reglen anvendes og hvordan den virker</strong></td>
    </tr>
    <tr>
      <td><strong>1</strong></td>
      <td><strong>{Rule Name}</strong> ({qualifier})</td>
      <td>
        <p><strong>Gælder for:</strong> {when}</p>
        <p><strong>Beregning:</strong> {how}</p>
      </td>
    </tr>
  </tbody>
</table>
<h4>Opsummering</h4>
<p>{Summary of the logic and its business value}</p>
```

### Modeloversigt Template

```html
<h3>Data Model Oversigt (Stjerneskema)</h3>
<h4>Formål</h4>
<p>Denne side giver et visuelt overblik over strukturen i {project_name}-datamarten.</p>
<h4>Sådan læser du diagrammet</h4>
<ul>
  <li><strong>Den centrale faktatabel (blå):</strong> {fact_table_description}</li>
  <li><strong>De beskrivende dimensionstabeller (grå):</strong> {dimension_tables_description}</li>
  <li><strong>Forbindelser (pile):</strong> Pilene viser, hvordan hver dimension er forbundet til faktatabellen.</li>
  <li><strong>Nøgler (PK / FK):</strong>
    <ul>
      <li><code>PK (Primary Key)</code>: Den unikke identifikator for hver række.</li>
      <li><code>FK (Foreign Key)</code>: En nøgle, der refererer til primærnøglen i en anden tabel.</li>
    </ul>
  </li>
</ul>
<h3>Gennemgang af Modellen</h3>
<h4>Faktatabellen (<code>{fact_table_name}</code>)</h4>
<p>{Description}</p>
<h4>Dimensionstabellerne</h4>
<ul>
  <li><strong><code>{dim_table}</code></strong>: <strong>{question_it_answers}</strong> {description}</li>
</ul>
```

### Datakvalitet og Opdateringsfrekvens Template

```html
<h4>Formål</h4>
<p>Denne side beskriver, hvor ofte data i {project_name}-datamarten bliver opdateret, og hvilken proces der sikrer, at dataene altid er så præcise og ajourførte som muligt.</p>
<h4>Opdateringsfrekvens</h4>
<table>
  <tbody>
    <tr><td><strong>System</strong></td><td><strong>Frekvens</strong></td><td><strong>Beskrivelse</strong></td></tr>
    <tr><td><strong>Kildedata (Backend)</strong></td><td>{frequency}</td><td>{description}</td></tr>
    <tr><td><strong>Datamart (Fact Table)</strong></td><td>{frequency}</td><td>{description}</td></tr>
  </tbody>
</table>
<h4>Databehandlingsproces</h4>
<p>{Description of the load pattern, rolling window, delete+insert, etc.}</p>
<h4>Håndtering af Ændringer og Datakvalitet</h4>
<p>{Description of how changes in source data are handled}</p>
```

## Change Documentation Workflow

When a feature or hotfix changes business logic, follow this workflow:

### Step 1: Detect Business Logic Changes

From the git diff, identify:
- New or modified SQL/PySpark transformations in curated/datamart
- Changed filter conditions, join logic, or calculation formulas
- New tables, views, or columns
- Modified job schedules or orchestration

### Step 2: Map Changes to Documentation Pages

For each code change, determine which Confluence page(s) need updating:
- Calculation changes -> Forretningsregler sub-pages
- New tables/columns -> Modeloversigt
- Job changes -> Driftsdokumentation
- DQ rule changes -> Datakvalitet og Opdateringsfrekvens

### Step 3: Read Current Documentation

Fetch the relevant Confluence pages and parse their content.

### Step 4: Draft the Update

Write the updated content **in Danish**, following these rules:
- Preserve the existing page structure and formatting
- Only modify the sections affected by the code change
- Add a changelog note at the bottom of the page if one exists
- Use the same terminology as the existing documentation
- Reference the branch/PR that introduced the change

### Step 5: Review and Push

1. Present the draft to the user in readable format
2. **Always ask for approval before updating Confluence**
3. On approval, update the page via the REST API
4. Confirm the update was successful and provide the page URL

## End-of-Cycle Documentation Review

At the end of a development cycle (sprint, release), run a comprehensive review:

1. **Load skills**: Load `dlh-confluence` and this skill
2. **Get all commits since last release**: `git log <last-release-tag>..HEAD`
3. **Identify all business logic changes** across the cycle
4. **Read all Confluence documentation** for the project
5. **Cross-reference** code changes against documentation
6. **Generate a report** listing:
   - Pages that are up to date
   - Pages that need updating (with specific sections)
   - Pages that are missing entirely
   - Suggested content for missing/outdated sections (in Danish)
7. **Offer to update** each page individually, with user approval

## Troubleshooting

| Issue | Cause | Solution |
|-------|-------|---------|
| Documentation doesn't match code | Last code change wasn't documented | Run the audit workflow |
| Page content is empty placeholder | Page was created but never filled in | Use templates to populate |
| Business rules have no sub-pages | Flat structure instead of hierarchy | Create sub-pages per rule domain |
| Documentation is in English | Convention violation | Translate to Danish, keeping technical terms |
| Can't find the right page to update | Project naming mismatch | Use `dlh-confluence` discovery to locate |
