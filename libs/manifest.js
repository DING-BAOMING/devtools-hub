// manifest.txt is the catalogue's single source of truth — but nine files read it,
// and each one used to parse it on its own. The copies had drifted: some trimmed the
// featured/isnew flags before comparing them to "yes", some did not (so a row with a
// trailing space counted as false in one reader and true in another); some skipped rows
// with fewer than six fields, some seven; and the fetch-with-cache-buster was copied
// nine times too.
//
// One parser, one fetch, one contract:
//   slug | category | featured | isnew | name | description | tags
//
// A row is a tool only if it carries a name and a description (six fields or more).
export function parseManifest(text) {
  const tools = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const p = t.split('|');
    if (p.length < 6) continue;
    tools.push({
      slug: (p[0] || '').trim(),
      category: (p[1] || 'other').trim(),
      featured: (p[2] || '').trim() === 'yes',
      isnew: (p[3] || '').trim() === 'yes',
      name: (p[4] || '').trim(),
      desc: (p[5] || '').trim(),
      tags: (p[6] || '').split(',').map(s => s.trim()).filter(Boolean)
    });
  }
  return tools;
}

/** Fetch + parse manifest.txt through the Pages asset binding. Throws on a failed fetch. */
export async function loadManifest(assets, baseUrl) {
  const mr = await assets.fetch(new URL('/manifest.txt?cb=' + Date.now(), baseUrl));
  if (!mr.ok) throw new Error('Manifest ' + mr.status);
  return parseManifest(await mr.text());
}
