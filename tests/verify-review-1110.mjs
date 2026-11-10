// 运行：node tests/verify-review-1110.mjs
// 2026-11-10 复查修复的回归测试：纯 Node 内存测试，不联网、不读真实浏览器数据。
// 会在多个设备时区（纽约、明斯克、东京、基里巴斯、萨摩亚）下各跑一遍，日期必须都按明斯克算。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const self = fileURLToPath(import.meta.url);
if (!process.env.REVIEW_CHILD) {
  let ok = true;
  for (const tz of ['America/New_York','Europe/Minsk','Asia/Tokyo','Pacific/Kiritimati','Pacific/Pago_Pago']) {
    const r = spawnSync(process.execPath, [self], {env: {...process.env, TZ: tz, REVIEW_CHILD: '1'}, encoding: 'utf8'});
    process.stdout.write(`--- 设备时区 ${tz} ---\n` + r.stdout + r.stderr);
    if (r.status !== 0) ok = false;
  }
  console.log(ok ? '全部时区通过' : '有失败');
  process.exit(ok ? 0 : 1);
}

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

// 修复 1
await test('1 自定义用了库里已有的名字：只记本餐，不改库存营养、不改历史', () => {
  const s = sandbox('2026-11-10T09:00:00Z');
  s.run('bindEvents(); logEntries(parseLocal("100鸡蛋").items, "breakfast", "2026-11-08");');
  const lib = s.read('DB.items.find(i=>i.id==="i36").nut'), hist = s.read('FIT.log["2026-11-08"][0]');
  for (const save of [true, false]) {
    s.run(`UI.customSaveDb = ${save}`);
    s.fill('cf-name','鸡蛋'); s.fill('cf-g','100');
    for (const [k,v] of Object.entries({kcal:400,p:5,f:30,c:20,fb:0})) s.fill('cf-'+k, v);
    s.action('custom-submit');
    eq(s.read('DB.items.find(i=>i.id==="i36").nut'), lib);
    eq(s.read('FIT.log["2026-11-08"][0]'), hist);
    assert.equal(s.run('dayLog(CUR_DAY).at(-1).kcal'), 400);
    assert.equal(s.run('dayLog(CUR_DAY).at(-1).src'), 'custom');
  }
  assert.equal(s.run('DB.items.filter(i=>i.name==="鸡蛋").length'), 1);
});

// 修复 2
await test('2 日期、餐次、活动/体重、记录日期都按明斯克时间', () => {
  // 明斯克 11-10 07:00（UTC 04:00）：纽约还是 11-09 23:00
  const s = sandbox('2026-11-10T04:00:00Z');
  s.run('FIT.act={"2026-11-09":{kcal:520,at:1}}; FIT.wt={"2026-11-09":{kg:72.4,at:1}}; CUR_DAY=dk(); UI.todayKey=CUR_DAY; UI.meal=undefined; UI.mealAuto=undefined;');
  assert.equal(s.run('dk()'), '2026-11-10');
  assert.equal(s.run('curMeal()'), 'breakfast');
  assert.equal(s.run('FIT.act[CUR_DAY]'), undefined);
  s.run('renderToday()');
  assert.equal(s.els.get('act-input').value, '');
  assert.equal(s.els.get('wt-input').value, '');
  s.run('logEntries(parseLocal("100鸡蛋").items, syncMeal())');
  eq(s.read('Object.keys(FIT.log)'), ['2026-11-10']);
  assert.equal(s.run('syLocalDoc().recs[Object.keys(syLocalDoc().recs).find(k=>k.startsWith("e:"))].d.day'), '2026-11-10');
  // 明斯克当天的健康数据不算「未来」
  s.run('location.search="?act_2026-11-10=35"; importHealth()');
  assert.equal(s.run('FIT.act["2026-11-10"].kcal'), 35);
  // 零点边界：明斯克 23:59 / 00:00
  s.clock.now = Date.parse('2026-11-09T20:59:00Z'); assert.equal(s.run('dk()'), '2026-11-09'); assert.equal(s.run('curMeal()'), 'dinner');
  s.clock.now = Date.parse('2026-11-09T21:00:00Z'); assert.equal(s.run('dk()'), '2026-11-10');
  // 跨月、闰日、欧美夏令时切换日的加减天
  eq(s.read('[addDays("2026-03-31",1), addDays("2028-03-01",-1), addDays("2026-03-29",1), addDays("2026-11-01",-1), addDays("2026-02-30",0)]'),
     ['2026-04-01','2028-02-29','2026-03-30','2026-10-31','2026-03-02']);
  assert.equal(s.run('_shiftDayStr("2026-11-01",-1)'), '2026-10-31');
});

// 修复 3
await test('3 健康导入不写 0；已开同步时先拉云端再导入', async () => {
  const s = sandbox('2026-11-10T09:00:00Z');
  s.run('location.search="?hk=1&act_2026-11-09=0&act_2026-11-08=0&wt_2026-11-09=0"; importHealth()');
  eq(s.read('FIT.act'), {}); eq(s.read('FIT.wt'), {});
  s.run('location.search="?hk=1&date=2026-11-09&active=0.3"; importHealth()');
  eq(s.read('FIT.act'), {});
  // 模拟已开同步：云端 11-09=520（别的设备记的），本机为空，快捷指令发 0 和 11-10=80
  const order = [];
  s.ctx.order = order;
  s.run(`SY.cfg.token = "test-not-a-secret";
    syRun = async () => { order.push('sync'); FIT.act["2026-11-09"] = {kcal:520, at:1}; };
    const _imp = importHealth; importHealth = function(){ order.push('import'); return _imp(); };
    location.search = "?hk=1&act_2026-11-09=0&act_2026-11-10=80";`);
  await s.run('boot()');
  eq(order, ['sync','import']);
  eq(s.read('FIT.act["2026-11-09"]'), {kcal:520, at:1});
  assert.equal(s.run('FIT.act["2026-11-10"].kcal'), 80);
});

// 修复 4
await test('4 今天页不能改营养（已记条目、识别预览）；库里没有的新食物仍可填', () => {
  for (const bad of ['entry-save-macros','保存营养','改营养','data-act="pv-macros"','function saveEntryMacros']) assert.equal(source.includes(bad), false, bad);
  const s = sandbox('2026-11-10T09:00:00Z');
  s.run('bindEvents(); logEntries(parseLocal("150鸡腿肉").items, "lunch"); UI.editEntry = dayLog(CUR_DAY)[0].id; UI.preview = parseLocal("100鸡蛋").items; renderToday();');
  assert.equal(s.html('meal-list').includes('macro-input'), false);
  assert.match(s.html('meal-list'), /data-act="e-step"/);
  assert.match(s.html('meal-list'), /data-act="e-mode"/);
  assert.match(s.html('meal-list'), /data-act="e-del"/);
  assert.equal(s.html('parse-preview').includes('macro-input'), false);
  s.run('UI.preview = parseLocal("100神秘外卖").items; renderToday();');
  assert.match(s.html('parse-preview'), /macro-input/);
  // 改克数仍然可用（之前依赖营养输入框）
  const id = s.run('dayLog(CUR_DAY)[0].id');
  s.action('e-step', {id, v:'10'});
  assert.equal(s.run('dayLog(CUR_DAY)[0].grams'), 160);
});

// 修复 5
await test('5 早/午/晚/加餐每组一张卡片，标题更清楚，无动画', () => {
  const s = sandbox('2026-11-10T09:00:00Z');
  s.run('["breakfast","lunch","dinner","snack"].forEach(m => logEntries(parseLocal("100鸡蛋").items, m)); renderToday();');
  const h = s.html('meal-list');
  assert.equal((h.match(/class="meal-group /g) || []).length, 4);
  for (const k of ['breakfast','lunch','dinner','snack']) assert.match(h, new RegExp('meal-group meal-' + k));
  for (const n of ['早餐','午餐','晚餐','加餐']) assert.match(h, new RegExp(n));
  assert.match(source, /<div id="meal-list" class="meal-list"><\/div>/);
  const rule = css.match(/\.meal-list > \.meal-group \{([^}]*)\}/)[1];
  assert.match(rule, /background: var\(--card\)/); assert.match(rule, /border-radius: var\(--r-card\)/);
  assert.match(css, /\.meal-list \{[^}]*gap: 14px/);
  const block = css.slice(css.indexOf('餐次分组：每餐一张卡片'));
  assert.equal(/animation|transition/.test(block), false);
});

// 修复 6
await test('6 名字带「饭」默认按熟重，写「生」才按生重', () => {
  const s = sandbox('2026-11-10T09:00:00Z');
  const one = q => s.read(`(({name,grams,mode,kcal}) => ({name,grams,mode,kcal}))(parseLocal(${JSON.stringify(q)}).items[0])`);
  eq(one('200米饭'), {name:'熟大米', grams:200, mode:'cooked', kcal:315});
  eq(one('米饭200'), {name:'熟大米', grams:200, mode:'cooked', kcal:315});
  eq(one('熟200米饭'), {name:'熟大米', grams:200, mode:'cooked', kcal:315});
  assert.equal(one('生200米饭').mode, 'raw'); assert.equal(one('生200米饭').kcal, 692);
  assert.equal(one('200大米').mode, 'raw');
  const fried = one('300蛋炒饭');
  assert.equal(fried.mode, 'cooked'); assert.equal(fried.name.startsWith('熟'), false);
  // 连写里其它食物不受影响
  eq(s.read('parseLocal("200米饭150鸡腿肉").items.map(i=>i.mode)'), ['cooked','raw']);
});

// 修复 7
await test('7 记录时按当时时间重算餐次；回到页面也重算；手动选的保留 1 小时', () => {
  const s = sandbox('2026-11-10T09:00:00Z'); // 明斯克 12:00 → 午
  s.run('bindEvents(); UI.meal = curMeal(); UI.mealAuto = UI.meal;');
  assert.equal(s.run('UI.meal'), 'lunch');
  s.clock.now = Date.parse('2026-11-10T16:30:00Z'); // 明斯克 19:30 → 晚
  s.run('UI.preview = parseLocal("100鸡蛋").items; commitPreview();');
  assert.equal(s.run('dayLog(CUR_DAY).at(-1).meal'), 'dinner');
  s.action('meal', {v:'snack'});
  s.clock.now += 20 * 60e3;
  s.run('UI.preview = parseLocal("100鸡蛋").items; commitPreview();');
  assert.equal(s.run('dayLog(CUR_DAY).at(-1).meal'), 'snack');
  s.clock.now += 2 * 36e5;
  s.listeners.get('visibilitychange').forEach(fn => fn());
  assert.equal(s.run('UI.meal'), 'dinner');
  // 自定义外卖默认不进库存
  s.fill('cf-name','双层吉士堡'); s.fill('cf-g','200');
  for (const [k,v] of Object.entries({kcal:450,p:25,f:22,c:35,fb:2})) s.fill('cf-'+k, v);
  s.action('custom-submit');
  assert.equal(s.run('DB.items.some(i=>i.name==="双层吉士堡")'), false);
  assert.equal(s.run('dayLog(CUR_DAY).at(-1).name'), '双层吉士堡');
});

await test('附加：同步失败的小点是红色、不闪；±10g 来回不漂移', () => {
  const s = sandbox('2026-11-10T09:00:00Z');
  s.run('SY.cfg.token = "test-not-a-secret"; SY.state = "off"; SY.msg = "GET 500"; updateSyncUI();');
  assert.equal(s.els.get('sync-dot').classList.contains('is-err'), true);
  assert.equal(s.els.get('sync-dot').classList.contains('is-busy'), false);
  s.run('SY.state = "busy"; updateSyncUI();');
  assert.equal(s.els.get('sync-dot').classList.contains('is-busy'), true);
  assert.match(css, /\.sync-dot\.is-err \{[^}]*background: var\(--red\);[^}]*animation: none;/);
  const r = s.read(`(() => { const e = {name:'鸡蛋', grams:100, kcal:146, p:12.7, f:11.5, c:0.7, fb:0};
    for (let g = 90; g >= 10; g -= 10) scaleEntry(e, g); for (let g = 20; g <= 100; g += 10) scaleEntry(e, g); return e; })()`);
  eq([r.grams, r.kcal, r.p, r.f, r.c, r.fb], [100, 146, 12.7, 11.5, 0.7, 0]);
  // 切换生/熟后重新以新值为基准
  s.run('logEntries(parseLocal("150鸡腿肉").items, "lunch"); const e = dayLog(CUR_DAY)[0]; scaleEntry(e, 160); setItemMode(e, "cooked");');
  assert.equal(s.run('dayLog(CUR_DAY)[0].base'), undefined);
});

console.log(`全部通过：${passed} 组（复查修复）`);
