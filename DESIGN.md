---
name: Spoilt
description: A calm, tactile content shield built around healthy digital boundaries.
colors:
  boundary-blue: "#5B5BD6"
  boundary-blue-hover: "#4A4ABC"
  paper-white: "#FBFCFE"
  paper-raised: "#FFFFFF"
  paper-fiber: "#F1F3F8"
  graphite: "#252634"
  graphite-muted: "#5D6072"
  rule-soft: "#D8DBE7"
  correction-white: "#FFFDF6"
  marker-charcoal: "#30313A"
  success-leaf: "#3C7A5D"
  warning-clay: "#A64B38"
typography:
  headline:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "2rem"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 650
    lineHeight: 1.25
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 600
    lineHeight: 1.25
rounded:
  control: "8px"
  surface: "12px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.boundary-blue}"
    textColor: "{colors.paper-raised}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
  button-primary-hover:
    backgroundColor: "{colors.boundary-blue-hover}"
    textColor: "{colors.paper-raised}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
  button-secondary:
    backgroundColor: "{colors.paper-raised}"
    textColor: "{colors.graphite}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
  input:
    backgroundColor: "{colors.paper-raised}"
    textColor: "{colors.graphite}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
---

# Design System: Spoilt

## Overview

**Creative North Star: "The Protective Paper Desk"**

Spoilt feels like a clear, well-kept workspace where a person can establish boundaries and return to browsing. Its light theme borrows Proton's orderly density, generous padding, and moderate radii, then adds restrained physical cues from paper, correction tape, and marker redaction. The result is calm and protective rather than clinical or severe.

Material effects must remain plausible and quiet. Fine paper grain, compressed fibers, soft edge lift, and imperfect marker coverage are useful when they clarify masking or grouping. They must never reduce legibility, compete with controls, or turn the extension into a scrapbook.

The system explicitly rejects Codex-template styling, "brutalist" blacks, and generic SaaS settings pages. Controls are familiar, surfaces are breathable, and motion communicates state only.

**Key Characteristics:**
- Light-first surfaces with cool, nearly neutral paper tones.
- Proton-like grouping, spacing, and moderate corner radii.
- A restrained boundary-blue accent reserved for actions and active states.
- Physical redaction cues used as functional feedback.
- Compact product typography with clear hierarchy and no display theatrics.

## Colors

The palette combines cool paper neutrals with one composed blue-violet accent, graphite text, and quiet semantic colors.

### Primary
- **Boundary Blue:** The primary action, enabled state, current selection, and focus identity. It should occupy less than 10% of a typical screen.
- **Boundary Blue Hover:** The darker interaction state for primary controls.

### Secondary
- **Correction White:** The warmest surface in the system, reserved for tape-like masking and small tactile highlights rather than page backgrounds.

### Tertiary
- **Success Leaf:** Confirmed saves, healthy active status, and successful preparation.
- **Warning Clay:** Errors, destructive actions, and conditions requiring attention. Never use it decoratively.

### Neutral
- **Paper White:** The options-page canvas.
- **Paper Raised:** Controls and raised working surfaces.
- **Paper Fiber:** Secondary groups, inset regions, and subtle material texture.
- **Graphite:** Primary text and icons.
- **Graphite Muted:** Secondary text that still meets contrast requirements.
- **Rule Soft:** Dividers, field borders, and quiet surface boundaries.
- **Marker Charcoal:** Redaction marks and concealed-content treatments; it is not a page or panel color.

### Named Rules

**The Ten Percent Boundary Rule.** Boundary Blue is used for primary actions, selection, focus, and enabled state only; its rarity carries meaning.

**The Charcoal Is a Tool Rule.** Marker Charcoal belongs to redaction marks, not large interface surfaces.

## Typography

**Display Font:** Inter with system sans-serif fallbacks
**Body Font:** Inter with system sans-serif fallbacks
**Label Font:** Inter with system sans-serif fallbacks

**Character:** One calm humanist-geometric family keeps the extension coherent and task-focused. Weight and spacing establish hierarchy without mixing editorial serif and monospaced utility voices.

### Hierarchy
- **Headline** (700, 2rem, 1.1): Options-page title only; use balanced wrapping and never uppercase it.
- **Title** (650, 1.25rem, 1.25): Section and rule titles.
- **Body** (400, 0.9375rem, 1.5): Explanations, statuses, and field guidance; prose is capped near 70 characters.
- **Label** (600, 0.8125rem, 1.25): Field labels and compact button text in sentence case.

### Named Rules

**The Quiet Interface Rule.** No display font, tracked uppercase eyebrow, or oversized fluid heading is permitted inside the popup or options workflow.

## Elevation

The system is layered, not floaty. Most grouping comes from changes in paper tone and soft borders. A low, short shadow may lift a popup menu or tactile tape edge, but permanent panels remain close to the page.

### Shadow Vocabulary
- **Surface Lift** (`0 2px 6px rgba(37, 38, 52, 0.10)`): Temporary menus and the most important floating surface only.
- **Tape Edge** (`0 1px 2px rgba(37, 38, 52, 0.16)`): Correction-tape masks and small physical-material details.

### Named Rules

**The Desk-Level Rule.** Surfaces rest on the same visual desk by default; elevation appears only when interaction or material meaning requires it.

## Components

### Buttons
- **Shape:** Moderately curved rectangle (8px radius), never a pill for ordinary commands.
- **Primary:** Boundary Blue with white text and 10px by 16px padding.
- **Hover / Focus:** Darken one step on hover; use a clear 2px focus ring with 2px offset. Active feedback moves no more than 1px.
- **Secondary:** White paper with a soft rule border and graphite text.
- **Destructive:** White paper with warning-clay text and border; reserve filled clay for final confirmation.

### Cards / Containers
- **Corner Style:** Gently rounded paper surface (12px radius).
- **Background:** Paper Raised over Paper White or Paper Fiber.
- **Shadow Strategy:** Flat by default; use Surface Lift only when a surface genuinely floats.
- **Border:** One soft rule around interactive or repeatable groups. Do not combine a border with a wide decorative shadow.
- **Internal Padding:** 16px in the popup and 20-24px in the options page.

### Inputs / Fields
- **Style:** White paper, 1px soft-rule border, 8px radius, graphite text, and a minimum 40px control height.
- **Focus:** Boundary-blue border and visible focus ring.
- **Error / Disabled:** Pair semantic color with text or an icon. Disabled controls retain readable text and obvious non-interactivity.

### Navigation
- The popup is a compact status-and-action surface; the options page is the full configuration workspace. Links between them use familiar text-and-icon commands, consistent control shapes, and sentence-case labels.

### Redaction Material
- **Marker mode:** Use layered, slightly irregular charcoal coverage with controlled edge variation. Keep the concealed text fully inaccessible visually.
- **Whiteout mode:** Use opaque correction-white tape with a faint fiber texture and Tape Edge shadow. It must remain distinguishable from the host page.
- **Host-page safety:** Avoid broad filters, blend modes, or inherited typography. Redaction CSS must be strongly scoped and robust on arbitrary pages.

## Do's and Don'ts

### Do:
- **Do** use cool paper neutrals, measured spacing, and moderate 8-12px radii.
- **Do** make enabled, disabled, loading, success, and error states explicit in words or icons as well as color.
- **Do** use marker and correction-tape effects where they explain concealed content.
- **Do** preserve visible keyboard focus, reduced-motion support, and readable contrast.
- **Do** keep the popup compact and the options page breathable.

### Don't:
- **Don't** use Codex-template styling: generic card grids, decorative gradients, oversized marketing typography, or repetitive eyebrow labels.
- **Don't** use "brutalist" blacks: harsh black-dominated surfaces, square high-contrast blocks, or aggressive warning-sign aesthetics.
- **Don't** reproduce a generic SaaS settings page with abstract decoration or emotionally cold copy.
- **Don't** use Marker Charcoal as a page, hero, panel, or ordinary button background.
- **Don't** use paper grain strongly enough to impair text or make controls look dirty.
- **Don't** add gradient text, glassmorphism, striped decoration, or wide soft shadows paired with 1px borders.
