# Design notes

The brief asked for a look that is "mature and dependable, but at the same time fresh and appealing", without the generic AI-generated look. The page, [web/index.html](../web/index.html), follows these notes.

## What the sources say

- Generic UI is an accumulation of defaults nobody chose: an indigo or violet accent, Inter, rounded cards with soft shadows, icons in rounded squares, pills, gradients, motion everywhere, and copy that restates its label.
- Swapping one fashionable default for another doesn't fix it; the current one is cream backgrounds with serif headings. Each choice should come from the product and its users.
- Design the awkward states too: empty, missing, in progress, disabled.
- Render, screenshot, get a critique from outside, and iterate.

Sources: [Layr design reference](https://layr.design/reference/layr-001-intentionality/foundation), [InterfaceKit](https://blog.interfacekit.io/what-makes-a-website-look-ai-generated), [samber's frontend-design-deslop skill](https://github.com/samber/cc-skills/blob/main/skills/frontend-design-deslop/SKILL.md), [unslop-preflight](https://unpkg.com/unslop-preflight@1.15.2/references/anti-ai-ui-slop.md), [fieldpacket's field guide](https://www.fieldpacket.dev/packets/agent-web-design.html).

## Choices

- **The colours carry provenance.** Blue marks a file a person uploaded and black a file the agent made, borrowing the spreadsheet habit of blue for typed-in values and black for calculated ones. A note carries a gray triangle, like Excel's comment, because it is for information; red is kept for a question, which needs a person. The only other colour marks the two ways an instance ends: Close instance is solid blue, a person's commit, and Abandon is red, a discard.
- **Type:** IBM Plex Sans, a plain engineered face. IBM Plex Mono is used only for code and addresses: file types, cell references, paths and tool calls. Numerals are tabular everywhere.
- **Surfaces:** tiles have a 1px border and no shadow. Only floating things are raised: question cards, and Advanced when expanded. A card points at its tile, like an Excel comment. There are two radii: 4px for tiles and buttons, and 8px for cards.
- **The awkward states are drawn:**
  - a missing input, with how often closed instances had it;
  - a step or output not built yet;
  - a run in progress, with Close disabled until it ends;
  - what each question defaults to if it's still unanswered at close.
- **The graph:** tiles in columns, inputs to steps, with Outputs in a column of their own that never scrolls away. Lines are thin gray curves behind the tiles, entering each tile at its own point and crossing a column only between tiles; hovering a tile turns its lineage black. Columns come from the longest path of steps; there is no layout library.
- **The sidebar is a cascade:** workspace, series, instance, each level indented under a rule. A row's actions sit in its corner, ⋯ for a menu and + for a new child, so the list holds only things and never grows a row of buttons. A row is a link all over, and shades under the pointer.
- **Menus and dialogs are the page's own.** A ⋯ menu drops from its button, with a rule before Archive or Abandon. A dialog dims the page behind it and closes on Escape or a click beside it. Names change in place, and settings save as they change, with Saved in the dialog's header. Buttons darken under the pointer, and stay dimmed while what they started runs.
- **Copy** names objects and consequences. There is no helper text that repeats a label. A legend in the sidebar teaches the colour code once.
- **Light throughout.** A dark Advanced band looked like leftover developer scaffolding.

## Never

- Gradients, glass, glow, emoji, or sparkle and robot icons.
- Pills or badges for ordinary labels, or icons in rounded squares.
- Motion, except to show state: a spinner while the agent works, a stripe on Outputs during a run, one flash when a tile changes, and a pulsing corner on an unanswered question.
- A colour whose meaning neither the legend nor the button's label gives.

## Tokens

    paper #f6f7f8   sheet #ffffff   rule #e3e6ea   rule-2 #cdd2d9
    ink #15181d     ink-2 #474e5b   ink-3 #6b7280
    person #1f48c7  person-bg #eef2fc   note #d42a1e   edge #a3aab4
    radius 4px (tiles, buttons), 8px (cards)

## Outside critique

Gemini 3.8 Flash reviewed the screenshots once.
- **Taken:**
  - style cell references as addresses rather than red alerts;
  - make Advanced light;
  - move the legend off the canvas;
  - anchor each card to its tile;
  - put each choice button on one line, and state the default below them.
- **Rejected, because they undo the owner's choices:**
  - tables instead of file tiles;
  - pills instead of comment triangles.
