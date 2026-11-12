# «هویت سازمانی» — a workspace that looks like the company, not like us

Every company that signs up can repaint the product. Not a colour picker bolted
onto a marketing page: the same input changes the panel its recruiters use every
day, the sign-in screen its staff see, and the career portal its candidates open.

**Where it lives:** `تنظیمات → هویت سازمانی` (`/app/settings/branding`).
**Who can change it:** workspace admins. Everyone else reads it.
**What a new workspace sees:** HOVIDA's own identity — nothing to configure.

---

## What can be changed

| Area | Knob | Where it shows up |
|---|---|---|
| Identity | full logo (PNG/JPEG/WebP/SVG/ICO, ≤380 KB), square mark/favicon, logo height (18–64 px) | sidebar, mobile header, browser tab, login screen, career portal header |
| Identity | the name the panel calls itself | sidebar wordmark, mobile header, document title, empty states |
| Identity | «ساخته‌شده با هویدا» on/off | sidebar footer — off = fully white-label |
| Colour | brand colour + secondary colour | buttons, links, charts, focus rings, meters, progress ring, sidebar active item |
| Colour | derived shades (hover, pressed, text-on-white, soft/tint surfaces) | computed, never hand-entered |
| Layout | sidebar style — light / brand-tinted / dark | every screen |
| Layout | sidebar width (224–296 px) | every screen, mobile unaffected |
| Layout | corner radius — sharp / soft / round | cards, inputs, buttons, modals |
| Layout | light or dark panel | the entire authenticated app |
| Layout | font — Vazirmatn or the device's system font | the entire panel |
| Words | the four nouns: candidate / job / interview / offer | navigation, page headers, buttons, empty states, e-mail subject lines that use them |
| Words | rename any navigation item | sidebar + mobile sheet |
| Words | hide navigation items the team never uses | sidebar + mobile sheet (`settings` cannot be hidden) |
| Words | where people land after signing in | the redirect after login |
| Sign-in | headline, subtitle, background style (gradient / plain / mesh) | `/login?ws=<career-slug>` |
| Public portal | heading, wide cover image | `/careers/<slug>` |

Two deliberate limits, stated in the UI:

* **«تنظیمات» can never be hidden.** A workspace that hid the page where nav is
  configured would have no way back.
* **Colours are a contract, not free text.** A pale brand colour cannot become
  white text on a button; HOVIDA derives the button shade until it reaches
  WCAG AA (4.5:1) and tells the admin, in Persian, that it did.

---

## How it works

### Server

`OrgRecord.branding` holds the whole identity (one object, merged over defaults
on every load so a field added later can never break an older workspace). All
data-URIs live in the record itself: no extra storage dependency, nothing to go
missing if object storage is unavailable.

```
GET   /api/org/branding          any member → { branding, tokens, warnings, presets, isCustom }
PUT   /api/org/branding          admin      → validated, saved, answered with the new tokens
POST  /api/org/branding/reset    admin      → back to HOVIDA exactly
GET   /api/auth/workspace?ws=…   public     → name + identity of one public workspace
```

Validation is strict where it reaches the DOM and generous everywhere else:

| Input | Rule |
|---|---|
| images | strict `data:image/(png\|jpeg\|webp\|svg+xml\|x-icon);base64,` pattern, size cap (380 KB logo/cover, 128 KB mark/ICO) |
| SVG | decoded and refused if it contains `<script`, `<foreignObject`, `javascript:` or an `on*=…` handler |
| colours | real `#RGB` / `#RRGGBB`, normalised to upper case |
| nav | only known keys can be hidden or renamed; unknown keys are dropped |
| numbers | clamps: logo height 18–64, sidebar width 224–296 |
| strings | bounded lengths; empty strings fall back to the default, never to blank UI |

Anything refused leaves the previous identity intact — a bad upload never leaves
a workspace looking broken.

### The colour engine — `src/lib/brand.ts`

One input colour, every shade derived, all contrast-checked:

* `--color-brand` — as chosen (decoration, marks, meters).
* `--color-brand-strong` — walked darker until white text on it reaches 4.5:1.
* `--color-brand-stronger` — the hover/pressed shade (≥ 6:1).
* `--color-brand-ink` — the same colour, walked until it is readable *as text*
  on the panel surface.
* `--color-brand-soft` / `--color-brand-tint` — mixed surfaces for chips and rows.

The dark panel is HOVIDA's own palette (not an inversion of the customer's
colour), so a yellow brand never produces a yellow page.

### Client

`BrandingProvider` (`src/components/brand/BrandingProvider.tsx`) writes those
custom properties onto `<html>`. The design system already reads them, so the
whole panel follows — tables, charts, focus rings, toasts — without a single
component knowing this feature exists. It also:

* swaps the tab icon and title to the workspace's;
* removes the overrides on sign-out, so the next person's login screen is never
  tinted with the previous company's colour;
* applies nothing at all for an unbranded workspace (no flash, no drift).

`BrandLock` / `BrandMark` render logo → wordmark → HOVIDA, in that order, so a
company without a logo still never sees a panel claiming to be another product.

The editor (`src/pages/settings/BrandingTab.tsx`) is lazy-loaded and shows a live
miniature of the panel using **the very same token function** — what the admin
sees in the preview is what the team gets.

---

## The public side

* **Career portal** — `/careers/<slug>` uses the company's logo, colours, corners,
  heading and cover image. Only public information travels: no members, no
  internal navigation choices.
* **Branded sign-in** — share `/login?ws=<career-slug>` with staff. The page
  resolves one *public* workspace slug (never an e-mail address, so no way to
  probe whether someone works somewhere), then wears its logo, copy and colours.
  An unknown slug silently falls back to HOVIDA's login.

---

## What this does *not* do (and why)

| Not covered | Honest reason |
|---|---|
| Custom domain (`hr.company.ir`) | Needs DNS + TLS automation on the deployment; the branding is ready, the hosting step is not. |
| E-mail templates (logo inside the letter) | The mail settings already own the signature and sender; adding a branded HTML wrapper needs the same per-tenant asset serving decision as the domain above. |
| Per-role themes | Deliberate: one workspace, one identity. A member seeing different colours than their manager is a bug, not a feature. |
| Arbitrary CSS / custom fonts uploaded | Would let one workspace break the shared bundle and (with a font URL) leak visitor IPs. Offered alternatives: system font or Vazirmatn, plus full colour and geometry control. |
| Dashboard card choice | The dashboard is still HOVIDA's composition; hiding cards is the next candidate in this area. |

---

## Proof

`npm run test:branding` (39 checks) starts the built server and proves, end to
end: a fresh workspace is unbranded; a save reaches the panel tokens; a pale
colour is darkened until white text passes AA and the admin is warned in
Persian; script-bearing SVG, `javascript:` URIs, oversized files and bogus
colours are refused without damaging the saved identity; the public portal and
`/login?ws=` carry the company's look; members can read but not write; company B
never sees company A's identity; reset returns HOVIDA exactly.
