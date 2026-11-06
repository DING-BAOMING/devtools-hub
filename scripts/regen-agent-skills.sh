#!/usr/bin/env bash
# Regenerate .well-known/agent-skills/index.json + .well-known/mcp/server-card.json
# from manifest.txt (single source of truth). Run after every manifest change.
# See /home/ubuntu/evan-ip-ddns-com/devtools-hub-docs/UPDATE-GUIDE.md
# Section ".well-known/ AI-discovery surfaces".
set -euo pipefail
cd "$(dirname "$0")/.."

# manifest.txt format: slug|category|optional-featured|optional-new|name|description|tags
node -e "
const fs=require('fs'), path=require('path');
const manifest=fs.readFileSync('manifest.txt','utf8').split('\n');
const tools=[];
for(const line of manifest){
  const t=line.trim();
  if(!t||t.startsWith('#'))continue;
  const p=t.split('|');
  if(p.length<6)continue;
  const [slug,cat,,,name,desc]=p;
  if(!slug)continue;
  tools.push({slug:slug.trim(),cat:cat.trim(),name:name.trim(),desc:desc.trim()});
}
const total=tools.length;
const categories=[...new Set(tools.map(t=>t.cat))].sort();
const base='https://tools.scoreroute.com';

// .well-known/agent-skills/index.json — machine-readable tool catalog
const asDir='.well-known/agent-skills'; fs.mkdirSync(asDir,{recursive:true});
const as={};
as['name']='DevTools Hub';
as['description']='Free collection of browser-based developer tools. No signup, no tracking, all client-side.';
as['version']='1.0.0';
as['homepage']=base+'/';
as['tool_count']=total;
as['categories']=categories;
as['llms_txt']=base+'/llms.txt';
as['llms_full_txt']=base+'/llms-full.txt';
as['sitemap']=base+'/sitemap.xml';
as['tools']=tools.map(t=>({name:t.name,url:base+'/tools/'+t.slug+'/',category:t.cat,markdown_url:base+'/tools/'+t.slug+'/.md',description:t.desc.length>120?t.desc.slice(0,117)+'...':t.desc}));
as['skills']=tools.map(t=>({name:t.name,url:base+'/tools/'+t.slug+'/',category:t.cat,markdown_url:base+'/tools/'+t.slug+'/.md',description:t.desc.length>120?t.desc.slice(0,117)+'...':t.desc}));
fs.writeFileSync(path.join(asDir,'index.json'),JSON.stringify(as,null,2)+'\n');

// .well-known/mcp/server-card.json — Model Context Protocol server card
const mcpDir='.well-known/mcp'; fs.mkdirSync(mcpDir,{recursive:true});
const mcp={};
mcp['name']='DevTools Hub';
mcp['description']='Free browser-based developer tools — '+total+' utilities across '+categories.length+' categories ('+categories.join(', ')+'). No signup, no tracking, all client-side.';
mcp['url']=base+'/llms.txt';
mcp['homepage']=base+'/';
mcp['version']='1.0.0';
mcp['tool_count']=total;
mcp['categories']=categories;
mcp['tools']=[
  {name:'tool_catalog',description:'Browse all '+total+' developer tools organized by category. Supports text search across tool names and descriptions.',url:base+'/llms.txt'},
  {name:'tool_detail',description:'Get detailed information about any specific tool, including its markdown variant for AI agents.',url:base+'/llms-full.txt'},
  {name:'search_trends',description:'Trending search keywords from Google Trends RSS, Bing Autosuggest, Wikipedia, GitHub Trending — refreshed per request.',url:base+'/api/trending-searches'},
  {name:'sitemap',description:'Machine-readable sitemap.xml listing every tool, category, and markdown variant.',url:base+'/sitemap.xml'},
];
fs.writeFileSync(path.join(mcpDir,'server-card.json'),JSON.stringify(mcp,null,2)+'\n');

console.log('regenerated: '+total+' tools, '+categories.length+' categories');
console.log('  '+path.join(asDir,'index.json'));
console.log('  '+path.join(mcpDir,'server-card.json'));
"
