// 运行：node tests/verify-cook-ratio.mjs
// 熟重÷生重比例（cookRatio）的回归测试：纯 Node 内存测试，不联网、不读真实浏览器数据。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
const self = fileURLToPath(import.meta.url);
const source = fs.readFileSync(path.join(path.dirname(self), '..', 'index.html'), 'utf8');
const css = source.match(/<style>([\s\S]*?)<\/style>/)[1];

function el(id) {
  return {id, innerHTML:'', textContent:'', value:'', placeholder:'', hidden:false, dataset:{}, style:{},
    classList:{_s:new Set(), add(...c){c.forEach(x=>this._s.add(x))}, remove(...c){c.forEach(x=>this._s.delete(x))}, toggle(c,v){(v ?? !this._s.has(c)) ? this._s.add(c) : this._s.delete(c)}, contains(c){return this._s.has(c)}},
    contains(){return false}, querySelector(){return null}, querySelectorAll(){return []}, focus(){}, blur(){}, addEventListener(){}, setAttribute(){}, validity:{badInput:false}};
}
function sandbox(iso) {
  const values = new Map(), els = new Map(), listeners = new Map(), timers = [];
  const clock = {now: new Date(iso).getTime()};
  class TestDate extends Date { constructor(...a){ super(...(a.length ? a : [clock.now])); } static now(){ return clock.now; } }
  const state = {notices:[], undo:null};
  const ctx = vm.createContext({
    Date:TestDate, URLSearchParams, console,
    setTimeout(fn){ timers.push(fn); return timers.length; }, clearTimeout(){},
    localStorage:{getItem:k=>values.get(k) ?? null, setItem(k,v){values.set(k,String(v))}, removeItem:k=>values.delete(k)},
    location:{search:'', pathname:'/t/', hash:'#today'},
    history:{replaceState(){ ctx.location.search=''; }},
    navigator:{userAgent:'iPhone'},
    document:{
      getElementById:id=>{ if(!els.has(id)) els.set(id, el(id)); return els.get(id); },
      querySelectorAll:()=>[], querySelector:()=>null, activeElement:null, visibilityState:'visible',
      body:{style:{}},
      addEventListener(n,fn){ (listeners.get(n) || listeners.set(n, []).get(n)).push(fn); }
    },
    fetch(){ throw new Error('测试禁止联网'); },
    btoa:t=>Buffer.from(t,'binary').toString('base64'), atob:t=>Buffer.from(t,'base64').toString('binary'),
    state
  });
  ctx.window = ctx; ctx.addEventListener = () => {}; ctx.scrollTo = () => {};
  const run = c => vm.runInContext(c, ctx);
  for (const [,s] of source.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) run(s.replace(/\bboot\(\);\s*$/, ''));
  run(`toast = (t,b,fn) => { state.notices.push(t); state.undo = fn; }; syRun = async () => {};`);
  const read = c => JSON.parse(JSON.stringify(run(c)));
  const fill = (id, v) => { els.set(id, Object.assign(el(id), {value:String(v)})); };
  const action = (act, data = {}) => listeners.get('click').forEach(fn => fn({target:{closest:()=>({dataset:{act, ...data}})}}));
  const html = id => els.get(id)?.innerHTML || '';
  return {ctx, run, read, fill, action, html, clock, timers, listeners, state, els};
}
let passed = 0;
function test(name, fn) { return Promise.resolve(fn()).then(() => { passed++; console.log('通过：' + name); }); }
const eq = assert.deepEqual;


const one = (s, q) => s.read(`(({name,grams,mode,kcal,p}) => ({name,grams,mode,kcal,p}))(parseLocal(${JSON.stringify(q)}).items[0])`);

await test('内置默认库每样食物都有熟重÷生重比例和依据', () => {
  const E = JSON.parse(source.match(/^const EMBED = (\{.*\});\s*$/m)[1]);
  assert.equal(E.items.length, 86);
  for (const it of E.items) { assert.ok(it.cookRatio > 0 && it.cookRatio <= 10, it.name); assert.ok(it.cookBasis, it.name); }
  const by = Object.fromEntries(E.items.map(i => [i.id, i.cookRatio]));
  eq([by.i81, by.i51, by.i52, by.i50, by.i35, by.i20, by.i77], [0.7, 2.5, 2.3, 1, 1, 1, 1]);
});

await test('按比例换算：熟重→生重营养，比例 1 的食物生熟一样', () => {
  const s = sandbox('2026-11-10T09:00:00Z');
  eq(one(s, '200鸡腿肉'), {name:'鸡腿肉', grams:200, mode:'raw', kcal:260, p:40});
  eq(one(s, '熟150鸡腿肉'), {name:'熟鸡腿肉', grams:150, mode:'cooked', kcal:279, p:42.9}); // 150/0.70=214g 生
  eq(one(s, '熟200米饭'), {name:'熟大米', grams:200, mode:'cooked', kcal:277, p:5.9});     // 200/2.5=80g 生米
  eq(one(s, '熟100意大利面'), {name:'熟意大利面', grams:100, mode:'cooked', kcal:152, p:5.2}); // 100/2.3
  eq(one(s, '熟80菠菜'), {name:'熟菠菜', grams:80, mode:'cooked', kcal:23, p:2.9});          // 80/0.8=100g 生
  assert.equal(one(s, '熟300土豆').kcal, one(s, '300土豆').kcal);
  // 比例 1 的食物也能切换生/熟，数值不变
  s.run('UI.preview = parseLocal("200牛奶").items;');
  const k = s.run('UI.preview[0].kcal');
  assert.ok(s.run('!!modeFood(UI.preview[0])'));
  assert.equal(s.run('setItemMode(UI.preview[0], "cooked")'), true);
  assert.equal(s.run('UI.preview[0].kcal'), k);
});

await test('库存里的比例优先；缺字段时用内置默认，再缺才按名称估算', () => {
  const s = sandbox('2026-11-10T09:00:00Z');
  s.run('DB.items.find(i=>i.id==="i51").cookRatio = 2; FOODS = null;');
  assert.equal(one(s, '熟200米饭').kcal, 346);
  s.run('delete DB.items.find(i=>i.id==="i81").cookRatio; FOODS = null;');
  assert.equal(s.run('itemRatio(DB.items.find(i=>i.id==="i81"))'), 0.7);
  s.run('DB.items.push({id:"uTest1", name:"测试羊排", kind:"食材", group:"肉禽", qty:1, nut:{kcal:200,p:18,f:14,c:0,fb:0}}); FOODS = null;');
  assert.equal(s.run('itemRatio(DB.items.find(i=>i.id==="uTest1"))'), null);
  assert.equal(s.run('weightYield(foods().find(f=>f.id==="uTest1")).y'), 0.65); // 名称规则：羊 0.65
});

await test('营养按熟重记的库存（熟米饭）：记熟重不换算，记生重按比例放大', () => {
  const s = sandbox('2026-11-10T09:00:00Z');
  s.run('DB.items.push({id:"umv6wg3m7", name:"熟长粒白米饭", kind:"食材", group:"主食", qty:1, cooked:true, cookRatio:2.5, nut:{kcal:130,p:2.7,f:0.3,c:28,fb:0.4}}); FOODS = null;');
  assert.equal(s.run('foodToItem(foods().find(f=>f.id==="umv6wg3m7"), 200, true).kcal'), 260);
  assert.equal(s.run('foodToItem(foods().find(f=>f.id==="umv6wg3m7"), 80, false).kcal'), 260);
});

await test('改比例会重算该食物的熟重记录，生重记录不变', () => {
  const s = sandbox('2026-11-10T09:00:00Z');
  s.run('logEntries(parseLocal("熟150鸡腿肉").items, "lunch"); logEntries(parseLocal("200鸡腿肉").items, "dinner");');
  eq(s.read('dayLog(CUR_DAY).map(e=>e.kcal)'), [279, 260]);
  const rec = s.run('setItemRatio(DB.items.find(i=>i.id==="i81"), 0.75).length');
  assert.equal(rec, 2);
  eq(s.read('dayLog(CUR_DAY).map(e=>e.kcal)'), [260, 260]);
  assert.equal(s.run('DB.items.find(i=>i.id==="i81").cookBasis'), '手动设定');
  assert.equal(s.run('setItemRatio(DB.items.find(i=>i.id==="i81"), 0)'), null);
  assert.equal(s.run('DB.items.find(i=>i.id==="i81").cookRatio'), 0.75);
});

await test('库存编辑页显示并能改比例；填错会拦住；调料不显示', () => {
  const s = sandbox('2026-11-10T09:00:00Z');
  s.run('bindEvents(); UI.editItem = "i81"; UI.stockFilter = "meat"; renderStock();');
  const h = s.html('stock-list');
  assert.match(h, /id="ratio-i81"[^>]*value="0.7"/);
  assert.match(h, /生100g ≈ 熟70g/);
  s.fill('ratio-i81', '0'); s.action('stock-edit-done', {id:'i81'});
  assert.equal(s.run('DB.items.find(i=>i.id==="i81").cookRatio'), 0.7);
  assert.match(s.state.notices.at(-1), /0\.1–10/);
  s.fill('ratio-i81', '0,8'); s.action('stock-edit-done', {id:'i81'});
  assert.equal(s.run('DB.items.find(i=>i.id==="i81").cookRatio'), 0.8);
  s.run('UI.editItem = "i20"; UI.stockFilter = "meat"; UI.stockQuery = "生抽"; renderStock();');
  assert.equal(/ratio-input/.test(s.html('stock-list')), false);
});

await test('新增食物表单有比例框（默认 1）；快速添加按名称估算', () => {
  const s = sandbox('2026-11-10T09:00:00Z');
  s.run('bindEvents(); UI.addOpen = true; UI.addCat = "veg"; renderStock();');
  assert.match(s.html('stock-add-panel'), /id="ratio-new"[^>]*value="1"/);
  s.fill('stock-new-name', '测试荞麦面'); s.fill('ratio-new', '2.2');
  for (const k of ['kcal','p','f','c','fb']) s.fill('stock-new-' + k, '');
  s.run('submitNewStock()');
  eq(s.read('(({cookRatio,cookBasis}) => ({cookRatio,cookBasis}))(DB.items.find(i=>i.name==="测试荞麦面"))'), {cookRatio:2.2, cookBasis:'手动设定'});
  s.run('addItem("测试牛腱子", "meat")');
  assert.equal(s.run('DB.items.find(i=>i.name==="测试牛腱子").cookRatio'), 0.65);
  s.run('addItem("测试苹果", "veg")');
  assert.equal(s.run('DB.items.find(i=>i.name==="测试苹果").cookRatio'), 1);
});

await test('预览和已记条目显示另一种重量（熟200g ≈ 生80g）', () => {
  const s = sandbox('2026-11-10T09:00:00Z');
  s.run('UI.preview = parseLocal("熟200米饭").items; renderToday();');
  assert.match(s.html('parse-preview'), /≈生80g/);
  s.run('UI.preview = []; logEntries(parseLocal("200鸡腿肉").items, "lunch"); UI.editEntry = dayLog(CUR_DAY)[0].id; renderToday();');
  assert.match(s.html('meal-list'), /≈熟140g/);
  s.run('UI.preview = parseLocal("200牛奶").items; renderToday();');
  assert.equal(/≈/.test(s.html('parse-preview')), false);
});

await test('同步往返保留比例字段', () => {
  const s = sandbox('2026-11-10T09:00:00Z');
  s.run('setItemRatio(DB.items.find(i=>i.id==="i81"), 0.72); const doc = JSON.parse(JSON.stringify(syLocalDoc())); DB.items.find(i=>i.id==="i81").cookRatio = 9; syApply(doc);');
  assert.equal(s.run('DB.items.find(i=>i.id==="i81").cookRatio'), 0.72);
});


await test('连写里的「熟/生」归后面那样食物，也认写在名字后面的；花生不被拆', () => {
  const s = sandbox('2026-11-10T09:00:00Z');
  const all = q => s.read(`parseLocal(${JSON.stringify(q)}).items.map(i => i.name + '|' + i.grams + '|' + i.mode)`);
  eq(all('熟200米饭150鸡腿肉'), ['熟大米|200|cooked', '鸡腿肉|150|raw']);
  eq(all('150鸡腿肉熟200米饭'), ['鸡腿肉|150|raw', '熟大米|200|cooked']);
  eq(all('100鸡蛋熟150鸡腿肉'), ['鸡蛋|100|raw', '熟鸡腿肉|150|cooked']);
  eq(all('100鸡蛋生200米饭'), ['鸡蛋|100|raw', '大米|200|raw']);
  eq(all('鸡腿肉熟150'), ['熟鸡腿肉|150|cooked']);
  eq(all('100花生50鸡蛋').map(x => x.split('|')[0]), ['花生', '鸡蛋']);
  eq(all('生菜100'), ['生菜|100|raw']);
});

console.log(`全部通过：${passed} 组（熟重÷生重比例）`);
