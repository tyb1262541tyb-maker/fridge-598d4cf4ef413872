// Run: node tests/verify-macros.mjs
// Uses Ego Lite and a fresh loopback origin. GitHub requests are mocked, never sent.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import {spawn} from 'node:child_process';
const root = path.resolve(import.meta.dirname, '..');
const source = await fs.readFile(path.join(root, 'index.html'), 'utf8');
const css = source.match(/<style>([\s\S]*?)<\/style>/)[1];
for (const [,script] of source.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(script);
const defined = new Set([...css.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map(m => m[1]));
const used = new Set();
for (const [,attr] of source.matchAll(/class="([^"\n]*)"/g)) {
  const plain = attr.replace(/\$\{[\s\S]*?\}/g, expr => {
    for (const [,literal] of expr.matchAll(/[?:]\s*'([^']*)'/g)) {
      for (const name of literal.split(/\s+/)) if (/^[a-zA-Z_][\w-]*$/.test(name)) used.add(name);
    }
    return '';
  });
  for (const name of plain.split(/\s+/)) if (/^[a-zA-Z_][\w-]*$/.test(name)) used.add(name);
}
const missing = [...used].filter(name => !defined.has(name));
assert.deepEqual(missing, [], 'All HTML/template classes must have CSS definitions');
console.log(`PASS static: ${used.size} classes defined, all scripts parse`);
const server = http.createServer(async (req,res) => {
  const relative = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const target = path.resolve(root, '.' + relative + (relative.endsWith('/') ? 'index.html' : ''));
  if (!target.startsWith(root + '/')) {res.writeHead(403).end(); return;}
  try {
    const body = await fs.readFile(target);
    const types = {'.html':'text/html; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'};
    res.writeHead(200, {'Content-Type':types[path.extname(target)] || 'application/octet-stream'}).end(body);
  } catch {res.writeHead(404).end();}
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
async function browserTests(url) {
  const assert = (await import('node:assert/strict')).default;
  const task = await taskSpace('fridge-macros-20261027');
  const page = task.page('p1');
  await page.cdp('Page.addScriptToEvaluateOnNewDocument', {source:`window.__errors=[]; window.addEventListener('error',e=>window.__errors.push(e.message)); window.addEventListener('unhandledrejection',e=>window.__errors.push(String(e.reason))); window.alert=window.confirm=window.prompt=()=>{throw new Error('Unexpected popup');};`});
  await page.cdp('Emulation.setDeviceMetricsOverride',{width:1280,height:1000,deviceScaleFactor:1,mobile:false});
  await page.goto(url);
  assert.equal(await page.evaluate(() => !!SY.cfg.token), false, 'fresh test origin has no sync credential');
  await page.snapshot();
  const click = async selector => {
    await page.evaluate(selector=>document.querySelector(selector)?.scrollIntoView({block:'center',behavior:'instant'}),selector);
    await page.click(selector);
  };
  const fill = (selector, value) => page.fill(selector, String(value));
  const macros = async (prefix, values) => {
    for (const [k,v] of Object.entries(values)) await fill(`#${prefix}-${k}`,v);
  };
  const totals = () => page.evaluate(() => dayTotals(CUR_DAY));
  const eq = (actual,expected) => assert.deepEqual(actual,expected);
  await click('[data-act="meal"][data-v="lunch"]');
  await click('[data-act="custom-toggle"]');
  assert.equal(await page.evaluate(() => document.querySelectorAll('#custom-food-box input').length),6);
  await fill('#cf-name','麦当劳双层吉士汉堡');
  await fill('#cf-g',100);
  await macros('cf',{kcal:450,p:25,f:24,c:34});
  await click('[data-act="custom-submit"]');
  eq(await totals(),{kcal:450,p:25,f:24,c:34});
  const saved = await page.evaluate(() => {
    const item = DB.items.find(i=>i.name==='麦当劳双层吉士汉堡');
    const match = foodMatch(item.name), parsed = parseLocal(item.name).items[0];
    return {nut:item.nut,match:match.nut,parsed:{kcal:parsed.kcal,p:parsed.p,f:parsed.f,c:parsed.c},meal:dayLog(CUR_DAY)[0].meal,
      bars:[...document.querySelectorAll('#hero .progress-fill')].map(el=>parseFloat(el.style.width))};
  });
  eq(saved.nut,{kcal:450,p:25,f:24,c:34,fb:0}); eq(saved.match,saved.nut);
  eq(saved.parsed,{kcal:450,p:25,f:24,c:34}); assert.equal(saved.meal,'lunch');
  for (const [i,v] of [25,18,24/55*100,34/185*100].entries()) assert.ok(Math.abs(saved.bars[i]-v)<.001);
  console.log('PASS (a): custom meal, all four progress bars, DB.items, foodMatch and parseLocal');

  await fill('#food-input','烧腊双拼饭 1份'); await click('[data-act="parse"]');
  await page.waitForSelector('#pv-0-kcal');
  assert.equal(await page.evaluate(()=>UI.preview[0].needsNutrition),true);
  await macros('pv-0',{kcal:720,p:32,f:28,c:85});
  await click('[data-act="pv-commit"]');
  eq(await totals(),{kcal:1170,p:57,f:52,c:119});
  await fill('#food-input','外卖烤肉饭 650kcal 35p 22f 75c'); await click('[data-act="parse"]');
  await page.waitForFunction(()=>UI.preview.length===1);
  eq(await page.evaluate(()=>{const {kcal,p,f,c}=UI.preview[0];return {kcal,p,f,c};}),{kcal:650,p:35,f:22,c:75});
  await click('[data-act="pv-macros"]');
  await macros('pv-0',{kcal:660,p:36,f:23,c:76});
  await click('[data-act="pv-step"][data-v="10"]');
  assert.equal(await page.evaluate(()=>UI.preview[0].kcal),726);
  await click('[data-act="pv-commit"]');
  eq(await totals(),{kcal:1896,p:96.6,f:77.3,c:202.6});
  console.log('PASS (b): unknown takeaway, shorthand, inline edit, gram scaling and commit');

  const entryId = await page.evaluate(()=>dayLog(CUR_DAY)[0].id);
  await click(`[data-act="entry"][data-id="${entryId}"]`);
  await macros('entry-'+entryId,{kcal:500,p:30,f:25,c:40});
  await click('[data-act="entry-save-macros"]');
  eq(await totals(),{kcal:1946,p:101.6,f:78.3,c:208.6});
  assert.match(await page.evaluate(()=>document.querySelector('#meal-list').textContent),/500/);
  await click(`[data-act="e-step"][data-id="${entryId}"][data-v="10"]`);
  eq(await page.evaluate(()=>{const {grams,kcal,p,f,c}=dayLog(CUR_DAY)[0];return {grams,kcal,p,f,c};}),{grams:110,kcal:550,p:33,f:27.5,c:44});
  console.log('PASS (c): saved meal macros and totals update immediately, grams scale all macros');

  await click('[data-act="tab"][data-v="stock"]');
  await click('[data-act="s-add-open"]');
  await fill('#stock-new-name','测试酸奶');
  await macros('stock-new',{kcal:90,p:8,f:3,c:7.8});
  await click('[data-act="s-add-cat"][data-v="meat"]');
  assert.equal(await page.evaluate(()=>document.getElementById('stock-new-p').value),'8');
  await click('[data-act="s-add-submit"]');
  const itemId = await page.evaluate(()=>DB.items.find(i=>i.name==='测试酸奶').id);
  eq(await page.evaluate(id=>itemById(id).nut,itemId),{kcal:90,p:8,f:3,c:7.8,fb:0});
  await fill('#stock-search','测试酸奶');
  await click(`button.stock-act-btn[data-act="s-edit"][data-id="${itemId}"]`);
  assert.equal(await page.evaluate(id=>document.getElementById('stock-'+id+'-kcal').value,itemId),'90');
  await fill(`.stock-edit-input[data-id="${itemId}"]`,'测试高蛋白酸奶');
  await macros('stock-'+itemId,{kcal:95,p:10,f:2,c:8});
  await click(`[data-act="stock-edit-done"][data-id="${itemId}"]`);
  eq(await page.evaluate(()=>getNut('测试高蛋白酸奶')),{kcal:95,p:10,f:2,c:8,fb:0});
  eq(await page.evaluate(()=>foodMatch('测试高蛋白酸奶').nut),{kcal:95,p:10,f:2,c:8,fb:0});
  console.log('PASS (d): inventory add/edit, category switch preserves drafts, nut persists and matching refreshes');

  // Exercise the spice editor too: same save action and macro fields.
  await fill('#stock-search','');
  await click('[data-act="sf"][data-v="spice"]'); await click('[data-act="spice-manage"]');
  const spiceId = await page.evaluate(()=>DB.items.find(i=>i.kind==='调料').id);
  await click(`.spice-name-btn[data-id="${spiceId}"]`);
  await macros('stock-'+spiceId,{kcal:12,p:1,f:.5,c:2});
  await click(`[data-act="stock-edit-done"][data-id="${spiceId}"]`);
  assert.equal(await page.evaluate(id=>itemById(id).nut.kcal,spiceId),12);

  // Verify no undefined classes in every rendered view too.
  eq(await page.evaluate(()=>{
    const names = new Set();
    function scan(rules){for(const rule of rules){if(rule.selectorText)for(const m of rule.selectorText.matchAll(/\.([a-zA-Z_][\w-]*)/g))names.add(m[1]);if(rule.cssRules)scan(rule.cssRules);}}
    scan(document.styleSheets[0].cssRules);
    return [...new Set([...document.querySelectorAll('[class]')].flatMap(el=>[...el.classList]))].filter(k=>!names.has(k));
  }),[]);
  const sync = await page.evaluate(async () => {
    const doc = JSON.parse(JSON.stringify(syLocalDoc()));
    const token = SY.cfg.token, original = window.fetch;
    const sent = [];
    SY.cfg.token='isolated-test-token';
    window.fetch=async (url,options={})=>{
      if(!String(url).startsWith('https://api.github.com/repos/')) throw new Error('Unexpected test request');
      if(options.method==='PUT') {const body=JSON.parse(options.body);sent.push({doc:JSON.parse(b64d(body.content)),sha:body.sha});return new Response(JSON.stringify({content:{sha:'mock-next-sha'}}),{status:200});}
      return new Response(JSON.stringify({sha:'mock-sha',content:b64e(JSON.stringify(doc))}),{status:200});
    };
    try {
      const pulled=await syGet(),sha=await syPut(pulled.doc,pulled.sha);
      syApply(syMerge(pulled.doc,syLocalDoc()));
      const item=DB.items.find(i=>i.name==='测试高蛋白酸奶');
      const e=dayLog(CUR_DAY)[0];
      const itemRoundtrip=JSON.stringify(sent[0].doc.recs['i:'+item.id].d.nut)===JSON.stringify(item.nut);
      const entryRoundtrip=sent[0].doc.recs['e:'+e.id].d.kcal===e.kcal;
      window.fetch=async()=>new Response(JSON.stringify({content:b64e('[]')}),{status:200});
      let rejected=false;try{await syGet();}catch{rejected=true;}
      window.fetch=async()=>new Response('',{status:409});
      const conflict=await syPut(doc,'conflicting-sha');
      return {sha,previous:sent[0].sha,itemRoundtrip,entryRoundtrip,rejected,conflict};
    } finally {window.fetch=original;if(token)SY.cfg.token=token;else delete SY.cfg.token;}
  });
  eq(sync,{sha:'mock-next-sha',previous:'mock-sha',itemRoundtrip:true,entryRoundtrip:true,rejected:true,conflict:null});
  eq(await page.evaluate(()=>window.__errors),[]);
  console.log('PASS (e): zero runtime errors/undefined classes; syGet/syPut mocked roundtrip, Unicode, validation, conflict handling');

  await click('[data-act="tab"][data-v="today"]');
  const beforeExtras = await totals();
  await click('[data-act="custom-toggle"]');
  await fill('#cf-name','自动热量外卖'); await fill('#cf-g',200);
  await macros('cf',{p:25,f:24,c:34});
  await page.press('#cf-c','Tab');
  assert.equal(await page.evaluate(()=>document.getElementById('cf-kcal').value),'452');
  await fill('#cf-kcal',500); await fill('#cf-p',26); await page.press('#cf-p','Tab');
  assert.equal(await page.evaluate(()=>document.getElementById('cf-kcal').value),'500');
  await fill('#cf-p',25); await click('[data-act="custom-auto"]');
  assert.equal(await page.evaluate(()=>document.getElementById('cf-kcal').value),'452');
  await click('[data-act="custom-submit"]');
  eq(await page.evaluate(()=>getNut('自动热量外卖')),{kcal:226,p:12.5,f:12,c:17,fb:0});
  await click('#toast [data-act="toast"]');
  assert.equal(await page.evaluate(()=>DB.items.some(i=>i.name==='自动热量外卖')),false);
  eq(await totals(),beforeExtras);
  await click('[data-act="custom-toggle"]');
  await fill('#cf-name','仅本餐外卖'); await macros('cf',{kcal:300,p:10,f:10,c:40});
  await click('[data-act="custom-save-db-toggle"]');
  assert.equal(await page.evaluate(()=>document.querySelector('[data-act="custom-save-db-toggle"]').getAttribute('aria-pressed')),'false');
  await click('[data-act="custom-submit"]');
  assert.equal(await page.evaluate(()=>DB.items.some(i=>i.name==='仅本餐外卖')),false);
  assert.equal(await page.evaluate(()=>dayLog(CUR_DAY).at(-1).kcal),300);
  await click('#toast [data-act="toast"]');
  eq(await totals(),beforeExtras);
  console.log('PASS extras: automatic kcal stays linked until manual override; 200g normalization; undo and meal-only mode');

  // Same-name save updates one item; undo restores its previous per100g nutrition.
  await click('[data-act="custom-toggle"]');
  await fill('#cf-name','麦当劳双层吉士汉堡'); await fill('#cf-g',200);
  await macros('cf',{kcal:1000,p:60,f:50,c:80});
  await click('[data-act="custom-save-db-toggle"]');
  await click('[data-act="custom-submit"]');
  eq(await page.evaluate(()=>getNut('麦当劳双层吉士汉堡')),{kcal:500,p:30,f:25,c:40,fb:0});
  assert.equal(await page.evaluate(()=>DB.items.filter(i=>i.name==='麦当劳双层吉士汉堡').length),1);
  await click('#toast [data-act="toast"]');
  eq(await page.evaluate(()=>getNut('麦当劳双层吉士汉堡')),{kcal:450,p:25,f:24,c:34,fb:0});
  eq(await totals(),beforeExtras);
  eq(await page.evaluate(()=>{const it=parseLocal('外卖烤肉饭 350g').items[0];return {grams:it.grams,needs:it.needsNutrition};}),{grams:350,needs:true});
  console.log('PASS duplicate: same-name nut update/undo preserves original; unknown takeaway retains 350g');

  // Responsive layout: verify all new labels/buttons fit at narrow phone and desktop widths.
  await click('[data-act="custom-toggle"]');
  for(const width of [320,375,768,1280]) {
    await page.cdp('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
    const layout=await page.evaluate(()=>({
      overflow:document.documentElement.scrollWidth>innerWidth,
      clipped:[...document.querySelectorAll('#custom-food-box button, .macro-label, .macro-unit, .hero-macro-label')].filter(el=>el.getClientRects().length&&el.scrollWidth>el.clientWidth+1).map(el=>el.textContent)
    }));
    eq(layout,{overflow:false,clipped:[]});
  }
  await page.screenshot({path:'/tmp/fridge-macros-desktop.png'});
  await page.cdp('Emulation.setDeviceMetricsOverride',{width:375,height:1000,deviceScaleFactor:1,mobile:true});
  await page.screenshot({path:'/tmp/fridge-macros-phone.png'});
  await page.cdp('Emulation.clearDeviceMetricsOverride');
  const before=await totals();await page.reload();
  eq(await totals(),before);
  eq(await page.evaluate(()=>getNut('测试高蛋白酸奶')),{kcal:95,p:10,f:2,c:8,fb:0});
  eq(await page.evaluate(()=>window.__errors),[]);
  console.log('PASS responsive: 320/375/768/1280px no overflow; reload retains records and item.nut');
  console.log(await page.snapshot());
}
try {
  const code = `const runTests = ${browserTests.toString()};
await runTests(${JSON.stringify(url)});`;
  const child=spawn('ego-browser',['nodejs'],{stdio:['pipe','inherit','inherit']});
  child.stdin.end(code);
  const exitCode=await new Promise(resolve=>child.on('exit',resolve));
  assert.equal(exitCode,0,'Browser verification failed');
} finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
