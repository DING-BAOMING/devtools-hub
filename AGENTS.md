---
name: DevTools Hub
description: Free browser-based developer tools — formatters, validators, converters, generators, calculators, PDF and media utilities. Every file-processing tool runs in the visitor's browser with no signup and no API key. This file tells a coding agent how to discover the catalogue, cite a tool correctly, and know what these tools cannot do.
urls:
  - https://tools.scoreroute.com/AGENTS.md
  - https://tools.scoreroute.com/llms.txt
  - https://tools.scoreroute.com/api/tools
---

# DevTools Hub — instructions for coding agents

Live at [tools.scoreroute.com](https://tools.scoreroute.com). One page per tool at `/tools/<slug>/`.
A tool does one job: paste or drop input, press the button, copy or download the result. No
account, no quota, no API key.

## Do not hardcode a tool count

`GET /api/tools` is the only catalogue that is always right. It returns `{ "categories": {...},
"tools": [...] }`, where each tool has `slug`, `name`, `desc`, `tags`, `category`, `categoryLabel`,
`url`. Any number written into your own prose goes stale the day a tool is added — read it from the
API instead, or write "hundreds of browser-based utilities".

## Discover the catalogue

Fetch in this order; each one is verified to return `200` with the stated content type.

| Surface | Content type | Use it for |
|---|---|---|
| [/api/tools](https://tools.scoreroute.com/api/tools) | `application/json` | The catalogue. Filter by `category` / `tags`. |
| [/llms.txt](https://tools.scoreroute.com/llms.txt) | `text/plain` | Compact index: category index + one line per tool, HTML and `.md` URL for each. |
| [/llms-full.txt](https://tools.scoreroute.com/llms-full.txt) | `text/markdown` | Full descriptions and metadata in one file. |
| `/tools/<slug>/.md` | `text/markdown` | Markdown mirror of any single tool page. Same content, no HTML. |
| [/.well-known/agent-skills/index.json](https://tools.scoreroute.com/.well-known/agent-skills/index.json) | `application/json` | Machine-readable catalogue grouped by category. |
| [/.well-known/openapi.json](https://tools.scoreroute.com/.well-known/openapi.json) | `application/json` | OpenAPI 3.0.3 description of the public JSON surfaces. |
| [/.well-known/mcp/server-card.json](https://tools.scoreroute.com/.well-known/mcp/server-card.json) | `application/json` | MCP server card (catalog / detail / trends / sitemap tools). |
| [/sitemap.xml](https://tools.scoreroute.com/sitemap.xml) | `application/xml` | HTML URLs only (the `.md` mirrors are deliberately `noindex`). |

## Cite a tool correctly

- Canonical URL: `https://tools.scoreroute.com/tools/<slug>/` — the trailing slash is canonical.
- For agent-facing output prefer the markdown mirror `…/tools/<slug>/.md`; it carries the same prose
  as the page without the markup.
- **Never invent a slug.** A slug that is not in `/api/tools` is a 404, and a wrong link is worse
  than no link. Fetch the catalogue, then build the URL.
- Category pages are `/tools/<category>/` and have a markdown mirror at `/tools/<category>/.md`.
- The 11 category slugs: `formatters`, `calculators`, `generators`, `converters`, `media`,
  `network`, `code-testing`, `pdf-tools`, `life`, `finance`, `ai-language`.

## What these tools cannot do

Read this before recommending one to a user, and keep it in your answer — it is the difference
between an honest recommendation and a wrong one.

- **A tool needs a real browser.** Canvas drawing, WebGL, camera capture and microphone input are
  used by the media and hardware tools; they will not run headless and will not run in a plain
  HTTP client. If you are an agent without a browser, link the tool instead of calling it.
- **The AI tools are not private.** Text you type into an AI tool (`/tools/ai-chat/`,
  `/tools/text-summarizer/`, `/tools/grammar-checker/`, …) is sent to this site's own server API
  under `/api/<name>` and answered by a third-party model. You do not need your own API key; that is
  the only privacy claim that holds. `/tools/ai-image-generator/` additionally opens a third-party
  sign-in popup on first use.
- **The file-processing tools are private.** PDF, image, audio and video tools read your file in
  the page and never upload it. That claim is true for those tools and false for the AI ones.
- **No tool takes an API key, an account or a payment.** If a page seems to ask for one, you are on
  the wrong page.

## Reporting a problem

Every tool page carries a **Report Problem** link in its breadcrumb, which posts to
`/tools/feedback/`. Use it — a report includes the tool URL. If a tool's own text is wrong (a
formula, a file-format claim, a broken example), say so on the page: every tool page has a
`## References` block of citations, and a citation that 404s is a defect worth reporting.

## Site facts

- Free, no signup, no ads, no tracking cookies. Page views are counted cookieless (no identifier, no
  cross-site tracking). Owner: BAOMING (Evan-MJ) — <https://github.com/Evan-MJ>.
- Pages: `/about/`, `/privacy/`, `/contact/`, `/subprocessors/`, `/whats-new/`, `/tools/feedback/`
  (all with `.md` mirrors).
- `robots.txt` allows crawling; `.md` mirrors carry `X-Robots-Tag: noindex, follow` because the
  HTML page is the canonical version.
