// Per-tool Open Graph image generator.
// Returns SVG (1200x630) branded with the tool name + short tagline.
// Public endpoint: /api/og/<slug>.svg
// Cached for 7 days at the edge (caches.default + Cache-Control: public, max-age=604800).
// ponytail: SVG, not PNG — the 5-15 KB response is cheap to cache and free of canvas
// dependencies; modern social platforms (LinkedIn, Slack, Discord, Telegram, iMessage)
// render SVG OG images, and platforms that don't (Twitter, Facebook) fall back to /og-image.png.
import { parseManifest } from '../../../libs/manifest.js';

// XML-escape for the SVG text nodes. This used to be a no-op (each replace mapped a
// character to itself), so any tool name or description containing &, < or > would
// produce invalid XML and a broken social card.
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function wrapLines(s,maxLen,maxLines){
  const words=String(s||'').split(/\s+/);
  const lines=[];let cur='';
  for(const w of words){
    if((cur+' '+w).trim().length>maxLen){
      lines.push(cur.trim());cur=w;
      if(lines.length>=maxLines)break;
    }else cur=(cur?cur+' ':'')+w;
  }
  if(lines.length<maxLines)lines.push(cur.trim());
  return lines;
}
// BUG-513: one manifest parser for every reader (libs/manifest.js). This file used
// to carry its own copy of the row contract.
async function loadManifest(assets,baseUrl){
  try{
    const mr=await assets.fetch(new URL('/manifest.txt?cb='+Date.now(),baseUrl));
    if(!mr.ok)return {};
    const tools={};
    for(const t of parseManifest(await mr.text())){
      if(t.slug)tools[t.slug]={category:t.category,name:t.name,desc:t.desc};
    }
    return tools;
  }catch{return{};}
}

const CAT_ACCENT={
  'formatters':'#667eea',
  'calculators':'#10b981',
  'generators':'#f59e0b',
  'converters':'#3b82f6',
  'media':'#ec4899',
  'network':'#06b6d4',
  'code-testing':'#8b5cf6',
  'pdf-tools':'#ef4444',
  'life':'#84cc16',
  'finance':'#f97316',
  'ai-language':'#a855f7',
};
const CAT_LABEL={
  'formatters':'Code Formatters',
  'calculators':'Calculators',
  'generators':'Generators',
  'converters':'Converters',
  'media':'Media Tools',
  'network':'Network Tools',
  'code-testing':'Code Testing',
  'pdf-tools':'PDF Tools',
  'life':'Daily Life',
  'finance':'Money & Markets',
  'ai-language':'AI Language',
};

export async function onRequest(context){
  const url=new URL(context.request.url);
  // The route param keeps the ".svg" suffix (/api/og/<slug>.svg), so the manifest
  // lookup missed every tool and every card fell back to the generic one — with the
  // suffix still glued to the title ("Json Formattersvg"). Strip it first.
  const slug=(context.params.slug||'').toLowerCase().replace(/\.svg$/,'').replace(/[^a-z0-9-]/g,'').slice(0,80);
  if(!slug)return new Response('Missing slug',{status:400});

  const cache=context.caches?.default;
  const cacheKey=new Request(url.toString(),{method:'GET',headers:{'Accept':context.request.headers.get('Accept')||'image/*'}});
  if(cache){
    const hit=await cache.match(cacheKey);
    if(hit)return hit;
  }

  const tools=await loadManifest(context.env.ASSETS,url);
  const tool=tools[slug];
  let name,desc,categoryLabel,accent;
  if(tool){
    name=(tool.name||'').split(/\s+-\s+/)[0]||tool.name||slug;
    desc=(tool.desc||'').slice(0,160);
    categoryLabel=CAT_LABEL[tool.category]||tool.category||'Developer Tools';
    accent=CAT_ACCENT[tool.category]||'#667eea';
  }else{
    name=slug.split('-').map(s=>s.charAt(0).toUpperCase()+s.slice(1)).join(' ');
    desc='Free online developer tool. No signup, no tracking, all client-side.';
    categoryLabel='Developer Tools';
    accent='#667eea';
  }

  const lines=wrapLines(desc,76,2);
  const tspanLines=lines.map((ln,i)=>`<tspan x="80" ${i?'dy="42"':''}>${esc(ln)}</tspan>`).join('');
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0f0f23"/>
      <stop offset="50%" stop-color="#1a1b3a"/>
      <stop offset="100%" stop-color="#0f0f23"/>
    </linearGradient>
    <linearGradient id="acc" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${accent}"/>
      <stop offset="100%" stop-color="#a855f7"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect x="0" y="0" width="1200" height="4" fill="url(#acc)"/>
  <g font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif" fill="#e8e8f0">
    <text x="80" y="100" font-size="22" font-weight="600" fill="${accent}" letter-spacing="2">DEVTOOLS HUB</text>
    <text x="80" y="135" font-size="18" fill="#9090b0">${esc(categoryLabel)} · Free online developer tool</text>
    <text x="80" y="310" font-size="76" font-weight="700">${esc(name)}</text>
    <text x="80" y="380" font-size="30" fill="#c8c8e0">${tspanLines}</text>
    <text x="80" y="570" font-size="22" fill="#9090b0">tools.scoreroute.com/tools/${esc(slug)}/</text>
  </g>
  <circle cx="1080" cy="500" r="100" fill="${accent}" opacity="0.12"/>
  <circle cx="1080" cy="500" r="60" fill="${accent}" opacity="0.4"/>
  <text x="1080" y="520" font-size="60" text-anchor="middle" fill="#fff" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">⚡</text>
</svg>`;

  const resp=new Response(svg,{
    headers:{
      'Content-Type':'image/svg+xml; charset=utf-8',
      'Cache-Control':'public, max-age=604800',
    }
  });
  if(cache&&cacheKey){
    try{await cache.put(cacheKey,resp.clone());}catch(e){}
  }
  return resp;
}
