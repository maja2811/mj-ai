---
name: dsb-wayfinding-html
description: "Experimental. Build a modern, self-contained HTML guide, handover document or long-form explainer in DSB's 'station concourse' wayfinding style (warm paper, DSB red signs, ink bands, numbered station line, line diagrams, timetable-style code rows). Use when the user asks for a DSB-styled HTML page/guide/handover/explainer, or to try 'the wayfinding layout' or 'the CSF guide layout' on new content. Not for slide decks or dashboards."
---

# DSB wayfinding HTML (experimental)

A reusable layout for single-file HTML guides, first built for the CSF booking data handover (`templates/example-csf-guide.html`). It is a test towards a more modern DSB look than the BI documentation template (`dlh-bi-solution-design`); treat it as a draft system, not a brand policy.

Design idea, after the wayfinding studio Mijksenaar: the page is a station concourse. The reader should always know where they are, what comes next, and which few rules matter. Information design before decoration.

## When to use

- A guide, handover, onboarding page or explainer that people read on screen, receive by e-mail or SharePoint, and sometimes print.
- Content with a clear order (sections), a few must-know rules or warnings, and often a hierarchy, a path, or code examples.

Not for slide decks (use a deck format), dashboards, or apps.

## Workflow

1. **Read the content first.** Use only the user's content: no new facts, keep every caveat and link, code byte-identical to the source. Decide what the reader must find, and in which order: those become the stations (sections, ideally 5-10).
2. **Start from the template.** Copy `templates/example-csf-guide.html`. Keep the `<style>` block, the inline `<script>` and the DSB logo `<img>` (base64) unchanged; replace the content.
3. **Map content to components** (see `references/visual-system.md`). Use a component only when the content has that shape:

   | Content shape | Component |
   |---|---|
   | The one warning everyone must see | red `aside.warning` in the masthead |
   | Sections in reading order | `nav.line` stations + `section.band` with `header.plate` |
   | Key facts (where / when / who) | `.tiles` departure-board tiles |
   | A life cycle or sequence of states | `ol.track` |
   | A step-by-step path (click path, process) | `ol.route`, mark the entry step `li.start` |
   | A hierarchy or dependency tree | `.map` line diagram (rings for nodes with children) |
   | Versions over time | `figure.versions` |
   | 2-3 core rules | `.rules` colour-blocked signs (`r1` red, `r2` ink, `r3` white) |
   | Checks / guarantees | `.checks` |
   | Limitations, caveats | `ul.alerts` |
   | Code examples | `article.q` timetable rows with `.codebox` + Copy |
   | Reference table | `.tablewrap` table |

4. **Alternate bands** (`paper`, `card`, `ink`) so sections read as separate platforms; put at most one or two `ink` bands on the page (for the strongest visual, e.g. the map).
5. **Check** (below), then show the user the file path and a screenshot.

## Rules

- Self-contained: no web fonts, CDNs, external images or trackers. System fonts only (Bahnschrift, Segoe UI Variable, Cascadia Code/Consolas). Links to external pages are fine.
- Colours only from the tokens. Red is a signal (signs, numbers, dots, the warning), not a background for long text. No new colours, gradients, emoji or icon sets.
- The DSB logo is the official favicon mark (provenance: `dlh-bi-solution-design/assets/README.md`). Use it unchanged, embedded as base64. Do not redraw or recolour it.
- Readability: body ≥ 15 px, labels ≥ 12 px, contrast ≥ 4.5:1 (`--red-text` for red text on light grounds), visible focus, `prefers-reduced-motion` respected.
- Escape `<`, `>`, `&` in code. Insert code blocks programmatically from the source, never retype them.
- Labels you add (kickers, tile labels, short captions) must restate the source, not add facts. List them for the user.
- If an `.md` source exists, it stays the source of truth; say so in the footer.

## Checks

- `python scripts/check_code_blocks.py <page.html> <source.md>`: every code block in the page equals the source's fenced blocks, in order.
- `node scripts/check_page.js <page.html>` (Playwright with Edge, see the script header for setup): no console errors, no external requests, Copy works, no horizontal scroll at 390 px, scroll highlight follows the sections, nav and buttons hidden in print; writes screenshots and `print.pdf` next to the script's working directory.
- Look at the screenshots yourself before reporting.
