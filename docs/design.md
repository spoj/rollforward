# Design notes

The brief asked for a look that is "mature and dependable, but at the same time fresh and appealing", without the generic AI-generated look. The page, [web/index.html](../web/index.html), follows these notes in its default theme (see Themes).

## What the sources say

- Generic UI is an accumulation of defaults nobody chose: an indigo or violet accent, Inter, rounded cards with soft shadows, icons in rounded squares, pills, gradients, motion everywhere, and copy that restates its label.
- Swapping one fashionable default for another doesn't fix it; the current one is cream backgrounds with serif headings. Each choice should come from the product and its users.
- Design the awkward states too: empty, missing, in progress, disabled.
- Render, screenshot, get a critique from outside, and iterate.

Sources: [Layr design reference](https://layr.design/reference/layr-001-intentionality/foundation), [InterfaceKit](https://blog.interfacekit.io/what-makes-a-website-look-ai-generated), [samber's frontend-design-deslop skill](https://github.com/samber/cc-skills/blob/main/skills/frontend-design-deslop/SKILL.md), [unslop-preflight](https://unpkg.com/unslop-preflight@1.15.2/references/anti-ai-ui-slop.md), [fieldpacket's field guide](https://www.fieldpacket.dev/packets/agent-web-design.html).

## Choices

- **The colours carry provenance.** Blue marks a file a person uploaded and black a file the agent made, borrowing the spreadsheet habit of blue for typed-in values and black for calculated ones. A thread carries a gray triangle, like Excel's comment, on its tile and its cell; it turns red while the agent's ask waits on a person. A proposal, the agent's offer to act for its runner, is violet, labelled "proposes", apart from a question's red "asks". The only other colours mark a person's commit and a discard, a person's decision that something is done, and who drives a browser: Close and Approve are solid blue, Abandon is red, a delivery is green, and a run's browser you took control of has an orange border, as the browser's live view marks control.
- **Type:** IBM Plex Sans, a plain engineered face. IBM Plex Mono is used only for code and addresses: file types, cell references, paths and tool calls. Numerals are tabular everywhere.
- **Surfaces:** tiles have a 1px border and no shadow. Only floating things are raised: a tile's card and the dialogs. A card points at its tile, like an Excel comment. There are two radii: 4px for tiles and buttons, and 8px for cards.
- **The awkward states are drawn:**
  - a missing input, with how often closed instances had it;
  - a step or output not built yet;
  - a run in progress, with Close disabled until it ends;
  - a reply the agent hasn't picked up yet;
  - the asks still waiting at close, which closing accepts as the agent did them.
- **The slices:** Inputs, Steps and Outputs, side by side, each scrolling on its own, with no lines between tiles: hovering a tile outlines it and shades what it's made from, and its card names them. A Tiles | List toggle shows the slices as dense tables, one over the other, for a long list; tiles stay the default, the reviewer's view.
- **The sidebar is a cascade:** workspace, series, instance, each level indented under a rule. A row's actions sit in its corner, ⋯ for a menu and + for a new child, so the list holds only things and never grows a row of buttons. A row is a link all over, and shades under the pointer.
- **The frame:** a top bar names the app, what the page shows and you, whose menu has Sign out; the sidebar's foot has Settings, the version the server runs, and « to fold the sidebar to a rail. Counts sit at a row's end; the bar's wake and Take over, Add files and the panel's tabs lead with a line icon in their words' colour.
- **Menus and dialogs are the page's own.** A ⋯ menu drops from its button, with a rule before Archive or Abandon. A dialog's Close is its primary button, what takes something away, as Archive and Remove, is a danger button, and nothing in one scrolls sideways but a wide sheet's preview. A dialog dims the page behind it and closes on Escape or a click beside it. Names change in place, and settings save as they change, with Saved in the dialog's header. Buttons darken under the pointer, and stay dimmed while what they started runs.
- **Copy** names objects and consequences. There is no helper text that repeats a label. A Key chip on the canvas teaches the colour code on hover, by swatches, so that it holds in any theme.
- **Light throughout.** A dark band of the agent's work looked like leftover developer scaffolding.

## Never

- Gradients, glass, glow, emoji, or sparkle and robot icons.
- Pills or badges for ordinary labels, or icons in rounded squares.
- Motion, except to show state: a spinner while the agent works, one flash when a tile changes, and a pulsing corner on an ask that waits on a reply.
- A colour whose meaning neither the legend nor the button's label gives.

## Themes

The look is a layout and a theme, under [web/css/](../web/css). The page's layout, [layout.css](../web/css/layout.css), and the sign-in pages', [signin.css](../web/css/signin.css), draw everything in tokens and name no colour of their own; a theme gives the tokens their values. [test/themes.test.ts](../test/themes.test.ts) checks that the layouts name no colour and that the default gives every token.

- **default**, [theme-default.css](../web/css/theme-default.css), is the one these notes describe:

      paper #f6f7f8   sheet #ffffff   rule #e3e6ea   rule-2 #cdd2d9
      ink #15181d     ink-2 #474e5b   ink-3 #6b7280
      person #1f48c7  person-bg #eef2fc   red #d42a1e   edge #a3aab4   control #e83
      radius 4px (tiles, buttons), 8px (cards)

- **A deployment's own** is a stylesheet kept outside the checkout, which `RF_THEME` names by its absolute path. It is served on the default's tokens and gives only those it changes, so a token added here later keeps the default's value there; below its tokens it may restyle a few things beyond colour. A logo of the same name beside it, `.svg` or `.png`, tops the sidebar, level with the top bar, and the sign-in pages' box, wherever the deployment's brand has none. A deployment's theme answers to its own brand, and may part from the Never list where that does.

## Outside critique

Gemini 3.8 Flash reviewed the screenshots once.
- **Taken:**
  - style cell references as addresses rather than red alerts;
  - move the legend off the canvas;
  - anchor each card to its tile.
- **Rejected, because they undo the owner's choices:**
  - tables instead of file tiles;
  - pills instead of comment triangles.
