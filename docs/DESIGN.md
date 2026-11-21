---
name: oakgreen docs
description: The oakgreen.cc forest at night, framing a calm technical manual for the oakgreen stack.
colors:
  forest-black: "#0b190f"
  rail: "#0f2215"
  raised: "#10241a"
  hairline: "#163020"
  hairline-light: "#1d3a25"
  deep-green: "#173620"
  ring-green: "#1d4128"
  brand-green: "#3c9057"
  label-green: "#56ad70"
  mint-high: "#92d3a6"
  mint-ink: "#eef5ef"
  ink-1: "#d6e3d8"
  ink-2: "#b4c6b8"
  ink-3: "#87a08d"
  ink-4: "#557060"
  ink-5: "#24412d"
  code-ground: "#0f2116"
  code-chrome: "#0d1d12"
  earth-blue: "#4f7fd6"
  sputnik-gold: "#b8860b"
  moss-paper: "#f6f8f3"
  moss-rail: "#eef3eb"
  moss-raised: "#e3ebe2"
  moss-hairline: "#d3dfd2"
  moss-ring: "#cfdfd1"
  moss-accent-low: "#d5e8d9"
  brand-green-light: "#2e7547"
  forest-ink: "#0b190f"
  forest-ink-2: "#2b4434"
typography:
  display:
    fontSize: "clamp(2.25rem, 1rem + 5vw, 4.5rem)"
    fontWeight: 200
    lineHeight: 1
    letterSpacing: "0.22em"
  wordmark:
    fontSize: "1rem"
    fontWeight: 300
    letterSpacing: "0.28em"
  headline:
    fontSize: "2.75rem"
    fontWeight: 300
    lineHeight: 1.2
    letterSpacing: "-0.015em"
  title:
    fontSize: "1.75rem"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  lead:
    fontSize: "clamp(1.0625rem, 0.9rem + 0.6vw, 1.3125rem)"
    fontWeight: 300
    lineHeight: 1.55
  body:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.7
  label:
    fontSize: "0.75rem"
    fontWeight: 500
    letterSpacing: "0.16em"
  table-head:
    fontSize: "0.8125rem"
    fontWeight: 500
    letterSpacing: "0.04em"
  code:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace"
rounded:
  inline-code: "0.3em"
  code-block: "0.625rem"
  card: "0.75rem"
  pill: "999rem"
spacing:
  xs: "0.5rem"
  sm: "0.75rem"
  md: "1.25rem"
  lg: "1.5rem"
  xl: "2.5rem"
  section: "2.75rem"
components:
  button-primary:
    backgroundColor: "{colors.brand-green}"
    textColor: "{colors.forest-black}"
    rounded: "{rounded.pill}"
  button-primary-light:
    backgroundColor: "{colors.brand-green-light}"
    textColor: "{colors.moss-paper}"
    rounded: "{rounded.pill}"
  button-minimal:
    textColor: "{colors.mint-ink}"
  button-minimal-hover:
    textColor: "{colors.label-green}"
  nav-link:
    textColor: "{colors.ink-2}"
    rounded: "{rounded.pill}"
  nav-link-current:
    backgroundColor: "{colors.deep-green}"
    textColor: "{colors.mint-ink}"
    rounded: "{rounded.pill}"
  nav-group-label:
    textColor: "{colors.label-green}"
    typography: "{typography.label}"
  search-field:
    backgroundColor: "{colors.raised}"
    rounded: "{rounded.pill}"
  link-card:
    textColor: "{colors.mint-ink}"
    rounded: "{rounded.card}"
  inline-code:
    backgroundColor: "{colors.deep-green}"
    textColor: "{colors.mint-ink}"
    rounded: "{rounded.inline-code}"
    padding: "0.1em 0.35em"
  code-block:
    backgroundColor: "{colors.code-ground}"
    rounded: "{rounded.code-block}"
---

# Design System: oakgreen docs

## Overview

**Creative North Star: "The Forest Manual"**

The docs are the oakgreen.cc forest at night with a technical manual laid open in it. The ground is near-black green, every surface is a slightly lighter step of the same green, and the only mark is the tree ring: stroked, round-capped, open with a radial notch. Reading pages are calm and dense the way a reference should be: a 46rem column, generous 1.7 leading, hairline rules between sections, and green that points at exactly one thing at a time (the current page, the primary action, a link).

The brand's play is quarantined to the home page. There the ring turns slowly, large and deep green, bleeding off the right edge while the copy owns the left column, with an earth, a teapot and a sputnik in orbit. Every other page carries the ring only as a faint watermark cropped off the top-right of the title block. Dark is the default theme; light mode is moss paper with forest ink and keeps the same structure.

The world refuses stock Starlight blue-grey and generic neon-on-black dev-docs styling: no glow, no gradient, no saturated accent on a black void.

**Key Characteristics:**
- One hue family. Grounds, rails, hairlines, marks and actions are all forest greens; blue and gold appear only as orbiters.
- Flat. No shadows anywhere; depth is tonal steps plus 1px hairlines.
- The tree ring is the only ornament: logo, home stage, title watermark.
- Wordmark voice (light weight, wide-tracked uppercase) for the brand name and for navigation group labels only.
- Pills for things you press or navigate to; 0.75rem corners for cards; code at 0.625rem.
- Motion is slow and optional: 40s ring turn on home, 150ms ease-out state changes elsewhere, all gated by reduced-motion.

## Colors

A single forest-green family from near-black to mint, with two small non-green accents that exist only in orbit.

### Primary
- **Brand Green** (`brand-green`): the action colour. Fills the primary pill button, draws the header mark and favicon, colours the hero title, focus outlines, caret and text selection (at 45% mix). In light mode it deepens to **Deep Brand Green** (`brand-green-light`) to hold contrast on paper.
- **Label Green** (`label-green`): a lighter step of Brand Green for small text that has to read on the forest ground: navigation group labels, the "On this page" heading, the current TOC entry, card icons on the home index, minimal-button and search hover. In light mode it collapses to Deep Brand Green.
- **Mint High** (`mint-high`): Starlight's high accent, used for accent text such as links on the dark ground.

### Secondary
- **Ring Green** (`ring-green`): the colour of the mark at scale. The turning home ring and the title watermark use it; it sits just above the ground so the ring reads as texture, never as content. Light mode: **Moss Ring** (`moss-ring`).
- **Deep Green** (`deep-green`): Starlight's low accent. Current sidebar link fill, inline code ground, the open state of the mobile menu button. Light mode: **Moss Accent** (`moss-accent-low`).

### Tertiary
- **Earth Blue** (`earth-blue`) and **Sputnik Gold** (`sputnik-gold`): orbiter colours on the home stage only. They never appear in reading UI.

### Neutral
- **Forest Black** (`forest-black`): page ground, header ground, inverted text on Brand Green. Also the `theme-color` meta.
- **Rail** (`rail`): the sidebar ground, one step above the page.
- **Raised** (`raised`): search field and mobile menu button ground.
- **Hairline / Hairline Light** (`hairline`, `hairline-light`): header and sidebar edges; section rules, table rules, card and code-frame borders.
- **Mint Ink** (`mint-ink`) through **Ink 5** (`ink-1`…`ink-5`): the text ramp. Mint Ink for headings and current items, Ink 1 for the tagline and table heads, Ink 2 for card body copy, Ink 3 for footer meta, Ink 5 for table head rules and scrollbars.
- **Code Ground / Code Chrome** (`code-ground`, `code-chrome`): expressive-code block ground and its tab bar or terminal title bar, tuned to sit between ground and rail. Light: Moss Rail and Moss Raised.
- **Moss Paper, Moss Rail, Moss Raised, Moss Hairline** (`moss-*`): the light-mode ground, sidebar, raised surface and hairline. **Forest Ink** (`forest-ink`, `forest-ink-2`) is the light-mode text.

### Named Rules
**The One Family Rule.** Every surface, line and mark is a green from the forest ramp. A non-green colour is allowed only as Starlight's semantic aside hues (tuned toward the palette) or as a home-page orbiter.

**The Green Points Rule.** Saturated green marks exactly one thing per region: the current page, the primary action, a link, a focus ring. Never use Brand Green as a large fill behind text other than the primary pill.

## Typography

**Body Font:** the system sans stack (Starlight default)
**Label/Mono Font:** the system monospace stack (Starlight default); code is themed with Everforest dark and light.

**Character:** One sans family, voiced two ways. Reading text is plain and comfortable; the brand voice is the same family set very light and very wide in uppercase.

### Hierarchy
- **Display** (200, clamp 2.25rem to 4.5rem, line-height 1, 0.22em tracking, uppercase, Brand Green): the home hero title only. A negative inline-end margin of the same 0.22em cancels trailing tracking.
- **Wordmark** (300, 1rem, 0.28em tracking, uppercase, Mint Ink): the site title beside the header ring.
- **Headline** (300, 2.25rem below 50em and 2.75rem above, line-height 1.2, -0.015em, balanced wrap): page titles on content pages.
- **Title** (500, h2 1.625rem/1.75rem, h3 1.3125rem/1.375rem, h4 1.125rem/1.1875rem, -0.01em, balanced wrap): section headings in the reading column. On home, h2 drops to 400.
- **Lead** (300, clamp 1.0625rem to 1.3125rem, line-height 1.55, max 36ch, pretty wrap): the home tagline.
- **Body** (400, 1rem, line-height 1.7, 46rem column): all reading text. Tables use tabular numerals.
- **Label** (500, 0.75rem, 0.16em tracking, uppercase, Label Green): sidebar group labels and the table-of-contents heading.
- **Table head** (500, 0.8125rem, 0.04em, Ink 1): table column heads, sentence case.

### Named Rules
**The Wordmark Voice Rule.** Wide-tracked uppercase belongs to the brand name, the home hero title and navigation labels. Never set a content heading, a card title or a line above a heading in it.

**The Light Title Rule.** Page titles are light (300); section headings carry the weight (500). Weight goes up as size goes down.

## Layout

Starlight's three-column frame: header, sidebar rail, 46rem reading column, table of contents. One responsive switch at 50em/50rem raises the heading sizes and turns the home hero into a 7fr/5fr grid.

Section rhythm: each h2 sits 2.75rem below the previous content with 1.25rem padding above a hairline rule. Home removes that rule because the tools index carries its own.

The home hero is the one composition that breaks the frame. Below 50rem the ring stage sits under the copy, pushed 42vw off the right edge. Above it the stage is absolutely positioned, clamp(34rem, 50vw, 52rem) wide, vertically centred and bled 12rem past the viewport's right edge; the page clips horizontal overflow so the bleed never causes scroll. The hero is at least 34rem tall with clamp(3rem, 1rem + 9vmin, 8rem) block padding.

The home tool list is an index, not a grid of boxes: two columns with a 2.5rem gutter and no row gap, each entry a top hairline, 1.25rem/1.5rem padding, icon and title on one line.

## Elevation & Depth

Flat. Nothing in the build casts a shadow: link cards, pagination, code frames and the mobile menu button all set `box-shadow: none`. Depth comes from three tonal steps (Forest Black ground, Rail sidebar, Raised controls) and 1px hairlines. The title watermark and home ring sit behind content as low-contrast texture, not as layers.

### Named Rules
**The Flat Forest Rule.** No shadows, glows or gradients. If something needs to separate, give it a tonal step or a hairline.

## Shapes

Two corner families. Things you press or navigate to are full pills (999rem): primary and minimal buttons, sidebar links, the search field. Containers have soft corners: link cards and pagination at 0.75rem, code blocks at 0.625rem, inline code at 0.3em. The home tools index has no corners at all, only a top rule.

The signature form is the tree ring: three open concentric arcs inside a closed circle with a radial notch, stroked with round caps and joins (stroke 35 on a 500 viewBox, 40 at header size). It appears at three scales: 1.75rem header mark, a 17rem watermark cropped off the title block, and the home stage.

## Components

### Buttons
Brand-green pills, quiet and confident.
- **Shape:** full pill (999rem).
- **Primary:** Brand Green fill and border, Forest Black text, weight 500. Light mode: Deep Brand Green with Moss Paper text.
- **Hover:** fill mixes 15% toward Mint Ink; 150ms ease-out on background, colour and transform.
- **Minimal:** text only, Mint Ink; hover turns Label Green.
- **Focus:** 2px Brand Green outline, 2px offset (global).

### Cards / Containers
- **Link cards and pagination:** 0.75rem corners, Hairline Light border, no shadow, no fill. Hover: border turns Brand Green and the ground takes a 7% Brand Green wash. Titles at 500.
- **Home tools index:** borderless, fill-less entries separated by a top hairline; title 1.125rem/500 in Mint Ink, icon in Label Green with no tile, body at reading size in Ink 2.

### Inputs / Fields
- **Search:** pill, Hairline Light border, Raised ground at 70%. Hover: border turns Label Green.
- **Theme select:** Starlight's select, offering Dark (default) and Light only; no auto option.

### Navigation
- **Header:** Forest Black ground, Hairline bottom edge, ring mark plus wordmark at left. Hovering the title turns the ring -30deg over 600ms on cubic-bezier(0.16, 1, 0.3, 1).
- **Sidebar:** Rail ground, Hairline edge. Group labels in the Label voice. Links are pills: hover takes a 12% Brand Green wash and Mint Ink text; the current page is a Deep Green pill, Mint Ink, weight 500.
- **Table of contents:** heading in the Label voice; the current entry in Label Green.
- **Mobile menu button:** Hairline Light border, Raised ground, Ink 1 icon, no shadow; Deep Green ground while the menu is open.

### Reading column
- **Links:** accent text, 1px underline at 40% of the text colour, 0.2em offset; hover brings the underline to full strength.
- **Inline code:** Deep Green ground, Mint Ink text, 0.1em/0.35em padding, 0.3em corners. Inside headings the chip is dropped.
- **Code blocks:** Everforest themes, Code Ground body, Code Chrome tab and title bars, Hairline Light border, 0.625rem corners, no frame shadow.
- **Tables:** tabular numerals, Ink 5 rule under the head row, Hairline Light between rows.

### Tree ring (signature)
The logo as an inline SVG component with `currentColor` stroke, so each placement sets its colour: Brand Green in the header, Ring Green on the home stage and in the watermark (the watermark is the favicon used as a CSS mask). On home it turns once per 40s; an inner orbit (earth) counter-rotates at 90s and an outer orbit (teapot, sputnik) turns at 75s, the teapot also spinning on its own axis at 9s. All of it stops under `prefers-reduced-motion`.

## Do's and Don'ts

### Do:
- **Do** keep dark the default and give every new token a light-mode value on Moss Paper.
- **Do** separate surfaces with a tonal step or a 1px hairline (`hairline`, `hairline-light`).
- **Do** use the pill (999rem) for anything pressed or navigated to, and 0.75rem for containers.
- **Do** colour the ring through `currentColor`: Brand Green as a mark, Ring Green as texture.
- **Do** use Label Green, not Brand Green, for small text on the dark ground.
- **Do** wrap every animation in `prefers-reduced-motion: no-preference`; state transitions stay at 150ms ease-out.

### Don't:
- **Don't** add shadows, glows or gradients (The Flat Forest Rule).
- **Don't** bring the orbiters, the turning ring or Earth Blue and Sputnik Gold onto reading pages; play stays on home.
- **Don't** reintroduce Starlight's blue-grey or a neon accent on black.
- **Don't** set wide-tracked uppercase on content headings or as a label above a heading.
- **Don't** box the home tools index in bordered tiles; it is a ruled index.
