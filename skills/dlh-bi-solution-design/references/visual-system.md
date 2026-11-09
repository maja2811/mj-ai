# Visual system and provenance

All three packaged HTML templates use the existing estimate presentation at `files/otc/presentation/index.html` as their sole visual source, with `files/otc/presentation/brand-spec.md` as its style reference. The HTML/CSS/SVG source is revision `34cf9f0db1d871dc59393dc37590350904840c78`.

- Georgia/Times display type with Arial/Helvetica interface text.
- White panels on a soft gray canvas, fine gray rules, restrained shadows, pale yellow evidence notes, and DSB red for navigation and action.
- Reuse the presentation's headers, information panels, data tables, estimate components, responsive layout, focus treatment, reduced-motion handling, and print styling. Keep diagram labels readable and color-independent.
- Use native SVG for architecture and star topology. The older `files/otc/solution_design.html` supplies the high-level story and flow semantics only; its older visual styling is not a template default.
- The DSB mark is copied unchanged only where appropriate. `assets/README.md` records its source; do not redraw, trace, stylize, or replace it.

This is an example-derived visual language, not a new mandatory brand policy. Change project content and topology, not the visual identity, unless the user asks for a redesign.
