# devtools-hub

Free browser-based developer tools — formatters, validators, converters, generators,
calculators, PDF and media utilities. Everything runs in the visitor's browser:
no signup, no API key, no upload.

**Live site: https://tools.scoreroute.com/**

## Popular tools

- [Age Calculator by Photo - How Old Do I Look?](https://tools.scoreroute.com/tools/face-age-estimator/) - free AI face age estimator, runs in your browser
- [Voice Changer - Free Online Audio Voice Effects](https://tools.scoreroute.com/tools/voice-changer/) - 10 presets plus custom pitch and speed
- [Audio Editor - Free Online Audio Effects & Editing Tool](https://tools.scoreroute.com/tools/audio-editor/) - cut, fade, normalize, EQ, reverse
- [Audio to Text Converter - Free Online Speech to Text](https://tools.scoreroute.com/tools/audio-to-text/) - real-time browser speech recognition
- [Free AI PPT Maker - Generate Editable Powerpoint Slides](https://tools.scoreroute.com/tools/ai-ppt-maker/) - real editable .pptx files in 10 seconds
- [AI Image Generator - Free Unlimited Image Creation](https://tools.scoreroute.com/tools/ai-image-generator/) - no API key, no watermark, no daily limit
- [Free Poster Maker - Custom Online Poster Design Tool](https://tools.scoreroute.com/tools/poster-maker/) - 8 templates, 9 sizes, PNG/PDF export
- [Condom Size Calculator - Find Your Exact Fit](https://tools.scoreroute.com/tools/condom-size-calculator/) - girth and length to nominal width, privately
- [URL Metadata Extractor - Link Preview and Meta Tags](https://tools.scoreroute.com/tools/url-metadata-extractor/) - OG tags, Twitter cards, JSON-LD, headings

## Categories

- [Code Formatters](https://tools.scoreroute.com/tools/formatters/)
- [Calculators](https://tools.scoreroute.com/tools/calculators/)
- [Generators](https://tools.scoreroute.com/tools/generators/)
- [Converters](https://tools.scoreroute.com/tools/converters/)
- [Media Tools](https://tools.scoreroute.com/tools/media/)
- [Network Tools](https://tools.scoreroute.com/tools/network/)
- [Code Testing](https://tools.scoreroute.com/tools/code-testing/)
- [PDF Tools](https://tools.scoreroute.com/tools/pdf-tools/)
- [Daily Life](https://tools.scoreroute.com/tools/life/)
- [Money & Markets](https://tools.scoreroute.com/tools/finance/)
- [AI Language](https://tools.scoreroute.com/tools/ai-language/)

## For coding agents

- [`/api/tools`](https://tools.scoreroute.com/api/tools) - the catalogue (slug, name, description, tags, category) as JSON
- [`/llms.txt`](https://tools.scoreroute.com/llms.txt) - compact index of every tool
- [`/AGENTS.md`](https://tools.scoreroute.com/AGENTS.md) - how to cite a tool correctly
- [`/sitemap.xml`](https://tools.scoreroute.com/sitemap.xml) - every published URL

## Run it locally

```bash
npm install
npx wrangler pages dev .
```

`manifest.txt` is the single source of truth for the tool catalogue - a tool row is
`slug|category|featured|isnew|name|description|tags`. The Pages Functions read it at
request time, so adding a tool is one manifest line plus `tools/<slug>/index.html`.

## Deploy

**One command. Do not push to `main` by hand and do not open a PR by hand.**

```bash
git add -A && git commit -m "what changed"
bash scripts/publish.sh
```

It builds the site (52 local gates - a red build publishes nothing), pushes a
tree snapshot to `publish/snapshot`, opens a pull request, waits for the `gates`
check to go green, squash-merges it, waits for the Cloudflare Pages build to
succeed, runs a 406-check health pass against the live domain, verifies the
tool(s) this publish added, and prints the verdict. "Published" means the last
lines say `deployment ... success`, `health = green`, `new tool check = green`
and `gates ... PASS 52`.

Run it again with nothing changed and it stops at "tree unchanged -> not
pushing" without touching production.

Adding a tool is a manifest line plus `tools/<slug>/index.html`, then
`bash scripts/build.sh` before committing (the build regenerates the page's
head metadata and `.well-known/`), then commit and publish. Check one tool on
its own with `node scripts/verify-new-tool.js <slug>`.

One thing to expect when you add a tool: the gate `bug406` measures how long a
"New" badge may live against the newest tool's date, so a brand-new tool pushes
that window forward and older badges fall out of it. The build then fails with
`no stale "New" badge on an old tool` and names the tools to fix - set their
`isnew` field in `manifest.txt` to `no` and build again. Do not edit the gate.

After a successful publish, open the new tool: the publish step prints its live
URL, and `node scripts/verify-new-tool.js <slug>` re-checks it (link, browser
errors, mobile overflow, and the site's own bug queue).

If `new tool check = red`, read which group failed. LINK/BROWSER failures are in
the code you just shipped - fix it, commit, publish again. A REPORT failure
("no unresolved bug filed against this tool") is in the site's feedback queue,
not in the code: fixing the code will not clear it. Only mark such an entry
resolved when the finding is really fixed, then re-run the verifier - no
republish is needed for that one.

`scripts/pre-deploy.sh` (direct `wrangler pages deploy`) and
`scripts/publish-github.sh` (snapshot only) are building blocks of that flow,
not entry points.
