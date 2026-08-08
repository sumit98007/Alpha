# Alpha Design Language

Version 1.0 — reference for the browser extension, gateway-facing UI, product pages, and future brand assets.

## Brand idea

Alpha should feel decisive, intelligent, and slightly unconventional. The visual system combines a restrained technical foundation with one energetic action color. Interfaces stay compact, direct, and calm until the user asks Alpha to act.

## Core palette

| Token | Value | Role |
| --- | --- | --- |
| `alpha.black` | `#000000` / `rgb(0, 0, 0)` | Primary dark surface, strongest text, high-contrast framing |
| `alpha.blue` | `#233D4D` / `rgb(35, 61, 77)` | Secondary surface, status, focus support, calm technical tone |
| `alpha.orange` | `#FE7F2D` / `rgb(254, 127, 45)` | Primary action, active state, brand signal, warnings |
| `alpha.grey` | `#EAECF0` / `rgb(234, 236, 240)` | Light canvas, text on dark surfaces, separators and quiet controls |

Use the exact hexadecimal values for solid brand colors. Transparent tints may be created from these colors only. White can appear when imposed by a host surface; Alpha-owned surfaces use `alpha.grey` instead.

### Color hierarchy

- Use black or grey for the main canvas.
- Use deep blue to separate supporting regions from primary content.
- Use orange once per view as the dominant action or active signal.
- Avoid large orange backgrounds behind long text.
- Do not introduce substitute reds, greens, or blues for routine states. Pair icons and plain-language labels with the palette so meaning never depends on color alone.

### Recommended combinations

- Grey text on black: primary dark UI.
- Black text on grey: primary light UI.
- Grey text on deep blue: secondary dark UI.
- Black text on orange: primary buttons and compact highlights.
- Orange on black: brand labels, focus accents, and active indicators.

## Typography

### Display face

**Boldonse Regular** is Alpha’s brand and display typeface. It is bundled locally at `extension/assets/fonts/Boldonse-Regular.ttf` under the SIL Open Font License.

Use Boldonse for:

- The Alpha wordmark
- Page or panel titles
- Short section labels
- Compact processing-state labels
- Marketing headlines

Do not use Boldonse for:

- Paragraphs
- Form values or placeholders
- Prompt content
- Dense settings
- Metadata smaller than 12px unless uppercase and extremely short

Boldonse is a visually heavy display face. Use weight `400`; simulated bold styling is not permitted. Keep headings short, use line-height `1.2–1.35`, and avoid italics.

### Interface face

Use the native system sans-serif stack for controls, body copy, form fields, prompt previews, and metadata:

`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`

This pairing protects readability while allowing Boldonse to remain distinctive.

## Shape and spacing

- Base spacing unit: `4px`.
- Common gaps: `8px`, `12px`, `16px`, `24px`.
- Icon control: `40–44px` square with a circular shape.
- Inputs and compact buttons: `10–12px` radius.
- Floating panels and cards: `16–18px` radius.
- Use one-pixel borders derived from blue or grey at 18–24% opacity.
- Prefer generous internal padding and compact external footprints.

## Elevation

Floating UI uses a black shadow, never a colored glow, except for a restrained orange active halo. Recommended panel shadow:

`0 24px 64px rgba(0, 0, 0, 0.34)`

Elevation communicates layering, not decoration.

## Motion and interaction

- The Alpha icon is the collapsed resting state.
- Expand the floating window from the icon’s edge using scale and fade over `160–220ms`.
- Re-anchor the icon when the host composer moves or is replaced.
- Once the user drags an open panel, preserve its viewport position until it is collapsed.
- Use orange for active/processing state and deep blue for settled status.
- Respect `prefers-reduced-motion` and remove non-essential animation.

## Voice and UI copy

Copy is brief, direct, and calm. Prefer “Use prompt”, “Copy”, and “Gateway offline” over clever or ambiguous language. Explain degraded or privacy-sensitive states plainly. Avoid exclamation marks in routine feedback.

## Accessibility

- Target WCAG AA contrast for all functional text.
- Never encode state using color alone.
- Maintain visible keyboard focus.
- Keep interactive targets at least `40px` where the host layout permits.
- Support Escape to collapse floating panels.
- Give icon-only controls an accessible name.
- Use system fonts for editable and long-form content.

## Component rules

### Floating launcher

Orange circle, black icon, 40–44px. On hover or expanded state, switch to deep blue with grey content. It stays close to the active composer without covering host controls.

### Floating window

Black surface, grey text, orange brand label, subtle blue/grey borders. The panel expands from the launcher, may be dragged, and collapses without losing the host input.

### Primary button

Orange background with black text. Use once as the strongest action in a view.

### Secondary button

Transparent or deep-blue surface with grey text and a low-contrast border.

### Fields

Use grey surfaces in light contexts and translucent grey on dark contexts. Focus uses an orange border plus a translucent orange ring.

## Governance

New components must use the named tokens before adding variants. Any new solid brand color or font requires an update to this document. Screens that intentionally deviate should record the accessibility or platform constraint that required the exception.
