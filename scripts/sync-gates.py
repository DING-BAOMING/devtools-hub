#!/usr/bin/env python3
"""Copy static gates from the docs repo into the site repo and make each one
resolve the site tree relative to its own location.

In the docs repo the tree is a sibling (../../devtools-hub); in the site repo
the gate lives in test-scripts/ and the tree is its parent (..). A copied gate
must therefore use its own module's directory, in the dialect that module
actually is: CommonJS has __dirname, ES modules have import.meta.dirname.
"""
import os
import re
import sys
from pathlib import Path

# The docs repo is a sibling of the site repo, so the default resolves without
# hardcoding anyone's home directory.
SITE = Path(__file__).resolve().parent.parent
DOCS = Path(os.environ.get('DOCS_GATES_DIR') or SITE.parent / 'devtools-hub-docs' / 'test-scripts')
ABS = str(SITE)

# A path literal that points into the site tree. The suffix after the tree
# root becomes extra path.join() segments.
ABS_LITERAL = re.compile(r"'" + re.escape(ABS) + r"([^']*)'")
# A module specifier that points into the site tree's libs/.
ABS_IMPORT = re.compile(r"'" + re.escape(ABS) + r"/libs/([^']+)'")

CJS_RULES = [
    ("path.resolve(__dirname, '..', '..', 'devtools-hub')",
     "path.resolve(__dirname, '..')"),
    ("path.resolve(__dirname, '../../devtools-hub')",
     "path.resolve(__dirname, '..')"),
    ("path.join(__dirname, '..', '..', 'devtools-hub')",
     "path.join(__dirname, '..')"),
    ("join(__dirname, '..', '..', 'devtools-hub')",
     "join(__dirname, '..')"),
    ("path.join(process.cwd(), 'devtools-hub')",
     "path.join(__dirname, '..')"),
    ("'../../devtools-hub/libs/", "'../libs/"),
    ("resolve(__dirname, '../../devtools-hub", "resolve(__dirname, '.."),
    ("path.resolve(HERE, '../../devtools-hub')", "path.resolve(HERE, '..')"),
    ("new URL('../../devtools-hub', import.meta.url)", "new URL('..', import.meta.url)"),
]

ESM_RULES = [
    ("path.resolve(__dirname, '..', '..', 'devtools-hub')",
     "path.resolve(import.meta.dirname, '..')"),
    ("path.resolve(__dirname, '../../devtools-hub')",
     "path.resolve(import.meta.dirname, '..')"),
    ("path.join(__dirname, '..', '..', 'devtools-hub')",
     "path.join(import.meta.dirname, '..')"),
    ("join(__dirname, '..', '..', 'devtools-hub')",
     "join(import.meta.dirname, '..')"),
    ("path.resolve(import.meta.dirname, '../../devtools-hub')",
     "path.resolve(import.meta.dirname, '..')"),
    ("path.join(import.meta.dirname, '../../devtools-hub')",
     "path.join(import.meta.dirname, '..')"),
    ("new URL('../../devtools-hub/', import.meta.url)",
     "new URL('../', import.meta.url)"),
    ("path.join(process.cwd(), 'devtools-hub')",
     "path.join(import.meta.dirname, '..')"),
    ("'../../devtools-hub/libs/", "'../libs/"),
    ("resolve(__dirname, '../../devtools-hub", "resolve(import.meta.dirname, '.."),
    ("path.resolve(HERE, '../../devtools-hub')", "path.resolve(HERE, '..')"),
    ("new URL('../../devtools-hub', import.meta.url)", "new URL('..', import.meta.url)"),
]

CJS_PATH = re.compile(r"(const|let|var)\s+path\s*=|require\('path'\)|require\(\"path\"\)")
ESM_PATH = re.compile(r"from 'node:path'|from 'path'")
HAS_PATH_USE = re.compile(r"\bpath\.(join|resolve|dirname|basename)\b")


GATES = [
    'acla-log-analyzer-logic-test.mjs',
    'blood-type-calculator-logic-gate.js',
    'bug306-find.js',
    'bug306-map.js',
    'bug306-orphans.js',
    'bug306-refs.js',
    'bug307-static-refs.js',
    'bug308-outline-base.js',
    'bug308-static-gate.js',
    'bug309-beacon-token.js',
    'bug312-jsonld-parses-static-gate.js',
    'bug313-cat-intro-gate.js',
    'bug317-dead-external-links-gate.js',
    'bug321-puter-image-models-gate.js',
    'bug326-autocomplete-tokens-gate.js',
    'bug327-ai-provider-gate.js',
    'bug328-no-pinned-model-id-gate.js',
    'bug332-tool-script-parses-gate.js',
    'bug333-th-has-data-cells-gate.js',
    'bug336-category-label-gate.js',
    'bug343-table-name-gate.js',
    'bug347-th-in-source-gate.js',
    'bug348-heading-hierarchy-gate.js',
    'bug350-broken-internal-links-gate.js',
    'bug352-manifest-desc-gate.js',
    'bug358-tab-labels-in-md-gate.js',
    'bug362-admin-secret-gate.js',
    'bug367-group-pressed-gate.js',
    'bug368-div-control-gate.js',
    'bug371-h1-entity-gate.js',
    'bug372-table-headers-gate.js',
    'bug376-tap-target-gate.js',
    'bug390-semantic-search-rank-gate.js',
    'bug404-radiogroup-required-children-gate.js',
    'bug405-title-fragment-gate.js',
    'bug406-isnew-window-gate.js',
    'bug407-no-false-model-claim-gate.js',
    'bug410-viewport-gate.js',
    'bug425-template-secrets-gate.js',
    'bug442-lyrics-proxy-gate.js',
    'bug447-ctr-metadata-gate.js',
    'bug451-lastmod-honesty-gate.js',
    'bug532-benign-guard-gate.js',
    'bug452-plaintext-credentials-gate.js',
    'bug480-permissions-policy-gate.js',
    'compliance-claims-gate.js',
    'cron-evaluator-selftest.js',
    'deai-prayer-times.mjs',
    'deai-sitemap-audit.mjs',
    'excel-formula-translator-gate.js',
    'lcn-select-gate.js',
    'make-bug360-baseline.js',
    'seo-audit-logic-test.mjs',
    'sitemap-audit-logic-test.mjs',
    'text-summarizer-splitter-test.js',
    'zodiac-compat-logic-gate.cjs'
]


def is_esm(text):
    return bool(re.search(r"^\s*(import|export)\s", text, re.M))


def abs_literal(m, base):
    parts = [p for p in m.group(1).split('/') if p]
    return base + ''.join(", '%s'" % p for p in parts) + ')'


# The credential store is outside both repos. Keep the local default but let the
# environment point somewhere else (CI has no /home/ubuntu).
PORTABILITY = [
    ("readFileSync('/home/ubuntu/.secrets/devtools-hub.env', 'utf8')",
     "readFileSync(process.env.DEVTOOLS_SECRET_STORE || '/home/ubuntu/.secrets/devtools-hub.env', 'utf8')"),
    ("arg('--store', '/home/ubuntu/.secrets/devtools-hub.env')",
     "arg('--store', process.env.DEVTOOLS_SECRET_STORE || '/home/ubuntu/.secrets/devtools-hub.env')"),
    ("// rootDir defaults to /home/ubuntu/evan-ip-ddns-com/devtools-hub",
     "// rootDir defaults to the site tree (the parent of this directory)"),
    ("//   rootDir defaults to /home/ubuntu/evan-ip-ddns-com/devtools-hub",
     "//   rootDir defaults to the site tree (the parent of this directory)"),
    ("// Run: node devtools-hub-docs/test-scripts/", "// Run: node test-scripts/"),
]


def migrate(text):
    esm = is_esm(text)
    base = "path.join(import.meta.dirname, '..'" if esm else "path.join(__dirname, '..'"
    for old, new in (ESM_RULES if esm else CJS_RULES):
        text = text.replace(old, new)
    for old, new in PORTABILITY:
        text = text.replace(old, new)
    text = ABS_IMPORT.sub(lambda m: "'../libs/%s'" % m.group(1), text)
    text = ABS_LITERAL.sub(lambda m: abs_literal(m, base), text)
    # generic: a path that climbs two levels to reach the sibling tree
    text = text.replace("'../../devtools-hub/", "'../")
    text = text.replace("'../../devtools-hub'", "'..'")
    if HAS_PATH_USE.search(text):
        if esm and not ESM_PATH.search(text):
            lines = text.split('\n')
            last = max(i for i, l in enumerate(lines)
                       if re.match(r"^\s*import\s", l))
            lines.insert(last + 1, "import path from 'node:path';")
            text = '\n'.join(lines)
        elif not esm and not CJS_PATH.search(text):
            lines = text.split('\n')
            idx = 0
            for i, l in enumerate(lines):
                if re.match(r"^\s*(const|let)\s", l):
                    idx = i
                    break
            lines.insert(idx, "const path = require('path');")
            text = '\n'.join(lines)
    return text


def main():
    names = sys.argv[1:] or GATES
    for name in names:
        src = DOCS / name
        if not src.exists():
            print('MISSING', name)
            continue
        (SITE / 'test-scripts' / name).write_text(migrate(src.read_text()))
        print('copied', name)


if __name__ == '__main__':
    main()
