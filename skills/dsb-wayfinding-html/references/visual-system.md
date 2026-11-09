# Visual system: DSB wayfinding (station concourse)

Source of truth for the CSS is the `<style>` block in `../templates/example-csf-guide.html`. This file explains it; change the template, not this summary, when the design evolves.

## Tokens (`:root`)

| Token | Value | Use |
|---|---|---|
| `--paper` / `--paper-2` | `#f4f1ea` / `#ebe5d8` | warm page ground, alternate band |
| `--card` | `#fffdf9` | card bands and panels |
| `--ink` / `--ink-2` | `#14202e` / `#3d4856` | text, dark bands / secondary text |
| `--panel` | `#1a2635` | dark panels (code, map) |
| `--red` | `#e2001a` | DSB red: signs, numbers, dots, warning ground |
| `--red-text` | `#b60017` | red text on light grounds (contrast) |
| `--red-tint` | `#fbe4e6` | quiet red highlight |
| `--rule` | `#d6cdbb` | hairlines |
| `--f-sign` | Bahnschrift, Arial Narrow, Segoe UI | headings, signs, numbers (DIN-like, ships with Windows) |
| `--f-body` | Segoe UI Variable Text, Segoe UI, system-ui | body text |
| `--f-mono` | Cascadia Code, Consolas | code |

Breakpoints: 1100, 900, 700 px. Print: A4, navigation and Copy buttons hidden, no breaks inside panels/code.

## Page skeleton

```html
<header class="masthead">
  <div class="wrap mast-grid">
    <div>
      <div class="mast-brand"><img src="data:image/png;base64,…" width="56" height="56" alt="DSB"><span>Kicker · Team</span></div>
      <h1>Main title: <span>red second line</span></h1>
      <p class="lead">One paragraph: who this is for and what it gives them.</p>
    </div>
    <aside class="warning" aria-label="Warning">
      <p class="sign-tag">Short sign label</p>
      <p><strong>The one thing everyone must know.</strong> Context.</p>
    </aside>
  </div>
</header>

<nav class="line" aria-label="Guide sections">
  <ol>
    <li><a href="#s-one"><span class="dot">1</span><span>Section one</span></a></li>
    <!-- one station per section; the script sets aria-current while scrolling -->
  </ol>
</nav>

<main>
  <section id="s-one" class="band paper">   <!-- band variants: paper | card | ink -->
    <div class="wrap">
      <header class="plate"><span class="num">1</span><h2>Section one</h2></header>
      <p class="intro">Lead sentence for the section.</p>
      …components…
    </div>
  </section>
</main>

<footer class="foot"><div class="wrap"><p>Source: … If this page and the Markdown files differ, the Markdown files win.</p></div></footer>
<script>/* scroll highlight + Copy: copy unchanged from the template */</script>
```

## Components (class names as in the template)

- **Two columns**: `div.two > div + div` for paired paragraphs.
- **Track** (`ol.track > li`): a short sequence of states drawn as a line with stations, e.g. Created → Confirmed → Changed → Refunded.
- **Tiles** (`div.tiles > div.tile`): departure-board facts. Inside: `span.tl` label, `span.tv` value (`span.tv.m` for monospace), optional `span.ts` small text.
- **Route** (`ol.route > li`): numbered path; `li.start` marks the entry point. Inside: `span.rl` stop label, `span.rs` short explanation.
- **Flag / cards** (`div.cols-2 > article.flag`): two short explanatory panels.
- **Map** (`.map` with `.tree`): a hierarchy as a line diagram. Root node is the main station; nodes with children get an interchange ring; leaves are stops. Add `.legend` explaining dot vs ring.
- **Definitions** (`div.defgrid > div.defcard`): term + one-line definition.
- **Versions** (`figure.versions > div.vtrack > div.v.v1/v2/v3`): versions over time, last one current, with a caption.
- **Rules** (`div.rules > article.rule.r1/.r2/.r3`): the core rules as colour-blocked signs: `span.rn` (Rule 1), `h3`, `p`, and a `code` line.
- **Checks** (`div.checks > article.check`): `span.tl` label, `h3`, `p`; follow with `p.report` for who is notified.
- **Alerts** (`ul.alerts > li`): limitations and caveats.
- **Table** (`div.tablewrap > table`): reference tables, scroll horizontally on mobile.
- **Link cards** (`div.links > a.linkcard`): further reading and contact.
- **Speed note** (`aside` before the queries) and **query rows** (`article.q#qN`): left column `span.qn` number, `h3`, `p`; right column `div.codebox > div.codebar (label + button.copy[data-copy=id]) + pre > code#id`.

## Motif discipline

One strong motif (railway wayfinding) carried by a few elements: the station line, the platform-number plates, the map, the rule signs, timetable rows. Do not add trains, tracks or icons as decoration.
