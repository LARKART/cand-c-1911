#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const searchUrl = (process.env.SEARCH_URL ?? '').replace(/\/$/, '');
if (!searchUrl) throw new Error('Set SEARCH_URL, for example http://localhost:3000');
const inventoryUrl = (process.env.INVENTORY_URL ?? 'http://localhost:4010').replace(/\/$/, '');
const rows = readFileSync(new URL('../eval/queries.jsonl', import.meta.url), 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
const listings = new Map(JSON.parse(readFileSync(new URL('../data/listings.json', import.meta.url), 'utf8')).map((x) => [x.id, x]));
const places = new Map(JSON.parse(readFileSync(new URL('../data/places.json', import.meta.url), 'utf8')).map((x) => [x.id, x]));
const dayDiff = (a, b) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000;
const distKm = (a, b) => { const rad=(n)=>n*Math.PI/180; const d1=rad(b.lat-a.lat),d2=rad(b.lng-a.lng); const x=Math.sin(d1/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(d2/2)**2; return 6371*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x)); };
let dcg = 0; let idealDcg = 0; let reciprocalRank = 0; let relevantFound = 0; let relevantTotal = 0;
let hardViolations = 0; let resultCount = 0; let livePriceMismatches = 0; const durations = [];
for (const row of rows) {
  const started = performance.now();
  const response = await fetch(`${searchUrl}/v1/search`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tenant': row.tenant, 'x-now': row.now }, body: JSON.stringify({ q: row.q, limit: 10 }) });
  if (!response.ok) throw new Error(`${row.id} search failed (${response.status}): ${await response.text()}`);
  const payload = await response.json(); const results = payload.results ?? []; durations.push(performance.now() - started); resultCount += results.length;
  const judgments = row.judgments ?? {}; const gains = results.map((r) => Number(judgments[r.listing_id] ?? 0));
  dcg += gains.reduce((s, rel, i) => s + (2 ** rel - 1) / Math.log2(i + 2), 0);
  const ideal = Object.values(judgments).map(Number).sort((a,b)=>b-a).slice(0,10);
  idealDcg += ideal.reduce((s, rel, i) => s + (2 ** rel - 1) / Math.log2(i + 2), 0);
  const judged = Object.entries(judgments).filter(([,rel]) => Number(rel) > 0).map(([id])=>id); relevantTotal += judged.length;
  const first = results.findIndex((r)=>Number(judgments[r.listing_id] ?? 0)>0); if(first>=0){ reciprocalRank+=1/(first+1); relevantFound+=results.filter((r)=>Number(judgments[r.listing_id]??0)>0).length; }
  const start = payload.understood?.dates?.check_in; const end = payload.understood?.dates?.check_out;
  const badIds=[];
  for (const result of results) {
    const listing=listings.get(result.listing_id); let bad=!listing;
    if (listing) {
      if (listing.visibility !== 'public' && listing.visibility !== `private:${row.tenant}`) bad=true;
      const c=row.checks??{}; if(c.guests && listing.sleeps<c.guests) bad=true; if(c.pets && !listing.pets_allowed) bad=true;
      if(c.place){ const actual=places.get(listing.place_id),target=places.get(c.place); if(!actual||!target||(c.near?distKm(target,listing)>40:actual.id!==target.id))bad=true; }
      if(c.places && !c.places.includes(listing.place_id)) bad=true;
      if(c.price){ if(result.currency!==c.price.currency||result[c.price.applies_to==='total'?'total':'nightly_avg']>c.price.maximum)bad=true; }
      if(result.nightly_avg===null||result.total===null||!start||!end)bad=true;
      if(!bad && start && end){ const quoteUrl=`${inventoryUrl}/v1/availability?ids=${encodeURIComponent(result.listing_id)}&check_in=${start}&check_out=${end}`; const inv=await fetch(quoteUrl); if(!inv.ok)bad=true; else {const q=(await inv.json()).results?.[0]; if(!q?.available||q.total!==result.total||q.nightly_avg!==result.nightly_avg||q.currency!==result.currency){livePriceMismatches++;bad=true;}} }
    }
    if(bad){hardViolations++;badIds.push(result.listing_id);}
  }
  if (badIds.length) console.log(`${row.id}: ${badIds.length} hard/live mismatch(es): ${badIds.join(', ')}`);
}
const meanMs=durations.reduce((s,n)=>s+n,0)/Math.max(durations.length,1); const sorted=durations.toSorted((a,b)=>a-b); const p95=sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*.95)-1)]??0;
console.log(`Queries: ${rows.length}`);
console.log(`Judged nDCG@10: ${idealDcg ? (dcg/idealDcg).toFixed(3) : 'n/a (add relevance judgments)'}`);
console.log(`Judged recall@10: ${relevantTotal ? (relevantFound/relevantTotal).toFixed(3) : 'n/a (add relevance judgments)'}`);
console.log(`Hard-rule/live-price violations: ${hardViolations} across ${resultCount} results`);
console.log(`Live quote mismatches: ${livePriceMismatches}`);
console.log(`Search latency: mean ${meanMs.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms`);
