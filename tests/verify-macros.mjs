// 运行：node tests/verify-macros.mjs
// 纯 Node.js 内存测试：不启动浏览器，不截图，不读取真实浏览器存储，不发网络请求。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
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
assert.deepEqual(missing, [], '所有 HTML/模板类名必须有 CSS 定义');
console.log(`通过：静态检查， ${used.size} 个类名已定义，所有脚本语法正确`);

// 每个沙箱只使用下面创建的空存储和虚拟输入，不接触任何用户数据。
function sandbox(today = '2026-11-07') {
  const values = new Map(), inputs = new Map(), timers = [], clicks = new Map();
  const clock = {now: new Date(today + 'T12:00:00').getTime()};
  class TestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const state = {saves:0, dirty:0, renders:0, notices:[], fail:false};
  const context = vm.createContext({
    Date:TestDate, URLSearchParams, console,
    setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout() {},
    localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem(key, value) { if (state.fail) throw new Error('模拟存储已满'); values.set(key, String(value)); },
      removeItem: key => values.delete(key)
    },
    location: {search:'', pathname:'/test/', hash:'#today'},
    history: {replaceState(_state, _title, url) { state.cleaned = url; context.location.search = ''; }},
    document: {
      getElementById: id => inputs.get(id) ?? null,
      querySelectorAll: () => [],
      addEventListener(name, fn) { clicks.set(name, fn); }
    },
    fetch() { throw new Error('内存测试禁止网络请求'); },
    btoa: text => Buffer.from(text, 'binary').toString('base64'),
    atob: text => Buffer.from(text, 'base64').toString('binary'),
    state
  });
  context.window = context;
  context.addEventListener = () => {};
  const run = code => vm.runInContext(code, context);
  for (const [,script] of source.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
    run(script.replace(/\bboot\(\);\s*$/, ''));
  }
  run(`renderAll = renderToday = () => { state.renders++; };
    toast = (text, _button, fn) => { state.notices.push(text); state.undo = fn; };
    syDirty = () => { state.dirty++; syStamp(); };
    const realSave = fsave;
    fsave = () => { state.saves++; return realSave(); };`);
  const read = code => JSON.parse(JSON.stringify(run(code)));
  const fill = (id, value) => {
    let text = String(value);
    inputs.set(id, {get value() { return text; }, set value(v) { text = String(v); }, validity:{badInput:false}, focus() {}});
  };
  const macros = (prefix, entries) => {
    for (const k of ['kcal','p','f','c','fb']) fill(prefix + '-' + k, entries[k] ?? '');
  };
  function importURL(search) {
    context.location.search = search;
    const result = run('importHealth()');
    while (timers.length) timers.shift()();
    return result;
  }
  function action(act, data = {}) {
    clicks.get('click')({target:{closest: () => ({dataset:{act,...data}})}});
  }
  return {run, read, fill, macros, importURL, action, state, values, clock};
}

let passed = 0;
function test(name, fn) {
  fn(); passed++;
  console.log('通过：' + name);
}
const eq = assert.deepEqual;

test('自定义餐次、食材复用、营养匹配和每日合计', () => {
  const s = sandbox();
  s.run('bindEvents(); UI.meal = "lunch";');
  s.fill('cf-name','麦当劳双层吉士汉堡'); s.fill('cf-g',100);
  s.macros('cf',{kcal:450,p:25,f:24,c:34});
  s.action('custom-submit');
  eq(s.read('getNut("麦当劳双层吉士汉堡")'),{kcal:450,p:25,f:24,c:34,fb:0});
  eq(s.read('foodMatch("麦当劳双层吉士汉堡").nut'),s.read('getNut("麦当劳双层吉士汉堡")'));
  eq(s.read('dayTotals(CUR_DAY)'),{kcal:450,p:25,f:24,c:34,fb:0});
  assert.equal(s.run('dayLog(CUR_DAY)[0].meal'),'lunch');
  assert.equal(s.run('parseLocal("麦当劳双层吉士汉堡").items[0].kcal'),450);
});

test('未知外卖、营养简写、预览修改和克数缩放', () => {
  const s = sandbox();
  s.run('UI.preview = parseLocal("烧腊双拼饭 1份").items;');
  assert.equal(s.run('UI.preview[0].needsNutrition'),true);
  s.macros('pv-0',{kcal:720,p:32,f:28,c:85});
  s.run('commitPreview()');
  eq(s.read('dayTotals(CUR_DAY)'),{kcal:720,p:32,f:28,c:85,fb:0});
  s.run('UI.preview = parseLocal("外卖烤肉饭 650kcal 35p 22f 75c").items;');
  eq(s.read('(({kcal,p,f,c}) => ({kcal,p,f,c}))(UI.preview[0])'),{kcal:650,p:35,f:22,c:75});
  s.run('pvStep(0,10); commitPreview();');
  eq(s.read('dayTotals(CUR_DAY)'),{kcal:1435,p:70.5,f:52.2,c:167.5,fb:0});
  s.run('scaleEntry(dayLog(CUR_DAY)[1],120)');
  assert.equal(s.run('dayLog(CUR_DAY)[1].kcal'),780);
  eq(s.read('(({grams,needsNutrition}) => ({grams,needsNutrition}))(parseLocal("外卖烤肉饭 350g").items[0])'),{grams:350,needsNutrition:true});
});

test('库存新增、改名、营养编辑、关联记录重算和调料编辑', () => {
  const s = sandbox();
  s.run('const item = addItem("测试酸奶","meat",{kcal:90,p:8,f:3,c:7.8,fb:0});');
  assert.equal(s.run('item.nut.p'),8);
  s.run('logEntries([foodToItem(foodMatch("测试酸奶"),100,false)],"lunch"); renameItem(item.id,"测试高蛋白酸奶"); saveItemNutrition(item,{kcal:95,p:10,f:2,c:8,fb:0});');
  eq(s.read('getNut("测试高蛋白酸奶")'),{kcal:95,p:10,f:2,c:8,fb:0});
  assert.equal(s.run('foodMatch("测试高蛋白酸奶").nut.kcal'),95);
  assert.equal(s.run('dayLog(CUR_DAY)[0].kcal'),95);
  s.run('saveItemNutrition(DB.items.find(i=>i.kind==="调料"),{kcal:12,p:1,f:.5,c:2,fb:0});');
  assert.equal(s.run('DB.items.find(i=>i.kind==="调料").nut.kcal'),12);
});

test('自动计算热量、手动覆盖、200g 折算、同名更新、撤销和仅本餐模式', () => {
  const s = sandbox(); s.run('bindEvents()');
  s.macros('cf',{p:25,f:24,c:34}); s.run('autoKcal("cf")');
  assert.equal(s.run('document.getElementById("cf-kcal").value'),'452');
  s.fill('cf-kcal',500); s.run('UI.autoCalories.cf = false; autoKcal("cf")');
  assert.equal(s.run('document.getElementById("cf-kcal").value'),'500');
  s.run('autoKcal("cf",true)');
  s.fill('cf-name','测试外卖'); s.fill('cf-g',200); s.action('custom-submit');
  eq(s.read('getNut("测试外卖")'),{kcal:226,p:12.5,f:12,c:17,fb:0});
  s.fill('cf-name','测试外卖'); s.fill('cf-g',100); s.macros('cf',{kcal:300,p:10,f:10,c:40});
  s.run('UI.customSaveDb = true'); s.action('custom-submit');
  assert.equal(s.run('DB.items.filter(i=>i.name==="测试外卖").length'),1);
  assert.equal(s.run('getNut("测试外卖").kcal'),300);
  s.state.undo();
  assert.equal(s.run('getNut("测试外卖").kcal'),226);
  s.fill('cf-name','仅本餐外卖'); s.fill('cf-g',100); s.macros('cf',{kcal:300,p:10,f:10,c:40});
  s.run('UI.customSaveDb = false'); s.action('custom-submit');
  assert.equal(s.run('DB.items.some(i=>i.name==="仅本餐外卖")'),false);
  assert.equal(s.run('dayLog(CUR_DAY).at(-1).kcal'),300);
  s.state.undo(); assert.equal(s.run('dayLog(CUR_DAY).length'),1);
});

test('营养同步文档往返、中文内容、较新值覆盖与删除优先', () => {
  const s = sandbox();
  s.run('addItem("测试高蛋白酸奶","meat",{kcal:95,p:10,f:2,c:8,fb:0}); logEntries(parseLocal("测试高蛋白酸奶").items,"lunch"); const doc = syLocalDoc(); syApply(JSON.parse(JSON.stringify(doc)));');
  assert.equal(s.run('getNut("测试高蛋白酸奶").p'),10);
  assert.equal(s.run('dayLog(CUR_DAY)[0].kcal'),95);
  eq(s.read('syMerge({recs:{x:{u:1,d:1}}},{recs:{x:{u:2,d:2}}}).recs.x'),{u:2,d:2});
  eq(s.read('syMerge({recs:{x:{u:2,d:1}}},{recs:{x:{u:2,del:1}}}).recs.x'),{u:2,del:1});
});

const threeDays = '?hk=1&act_2026-11-07=150&act_2026-11-06=410&act_2026-11-05=320&wt_2026-11-07=72.4';
test('三天活动和带日期的体重一起导入，只保存和标记同步一次', () => {
  const s = sandbox();
  s.run('FIT.act["2026-11-06"] = {kcal:6,at:1}; CUR_DAY = "2026-11-05";');
  assert.equal(s.importURL(threeDays),true);
  eq(s.read('Object.fromEntries(Object.entries(FIT.act).map(([d,r])=>[d,r.kcal]))'),{'2026-11-05':320,'2026-11-06':410,'2026-11-07':150});
  assert.equal(s.run('FIT.wt["2026-11-07"].kg'),72.4);
  assert.equal(s.state.saves,1); assert.equal(s.state.dirty,1);
  assert.equal(s.run('CUR_DAY'),'2026-11-07'); assert.equal(s.run('UI.trendOpen'),true);
  assert.equal(s.state.cleaned,'/test/#today');
  assert.equal(s.run('importHealth()'),false, '清理参数后刷新不会再次导入');
  eq(s.read('Object.keys(FIT.extra)'),[]);
  assert.equal(s.state.notices.at(-1),'✅ 已从健康导入：11-05 活动 320 kcal、11-06 活动 410 kcal（已更新）、11-07 活动 150 kcal、11-07 体重 72.4 kg');
  assert.equal(s.run('syLocalDoc().recs["a:2026-11-06"].d.kcal'),410);
});

test('同一网址再次打开不累加、不改时间戳、不保存、不产生第二次同步', () => {
  const s = sandbox(); s.importURL(threeDays);
  const fit = s.read('FIT'), doc = s.read('syLocalDoc().recs');
  s.clock.now += 60000; s.importURL(threeDays);
  eq(s.read('FIT'),fit); eq(s.read('syLocalDoc().recs'),doc);
  assert.equal(s.state.saves,1); assert.equal(s.state.dirty,1);
  assert.match(s.state.notices.at(-1),/没有变化/);
});

test('0 和四舍五入后的 0 不覆盖已有非 0 活动；空日期可记 0', () => {
  const s = sandbox();
  s.run('FIT.act["2026-11-06"] = {kcal:410,at:1}; FIT.wt["2026-11-06"] = {kg:72.4,at:1};');
  s.importURL('?act_2026-11-06=0&wt_2026-11-06=0');
  eq(s.read('FIT.act["2026-11-06"]'),{kcal:410,at:1});
  eq(s.read('FIT.wt["2026-11-06"]'),{kg:72.4,at:1});
  assert.equal(s.state.saves,0);
  s.importURL('?act_2026-11-06=0.4&act_2026-11-07=0');
  eq(s.read('FIT.act["2026-11-06"]'),{kcal:410,at:1});
  assert.equal(s.run('FIT.act["2026-11-07"].kcal'),0);
});

test('未来、8 天前、虚构日期和超出范围的数被拒，7 天前和范围端点可用', () => {
  const s = sandbox();
  s.importURL('?act_2026-11-08=100&wt_2026-11-08=72&act_2026-10-30=100&wt_2026-10-30=72&act_2026-02-30=100&act_2026-11-05=5001&wt_2026-11-05=29.9&act_2026-11-06=-1&wt_2026-11-06=250.1');
  eq(s.read('FIT.act'),{}); eq(s.read('FIT.wt'),{}); assert.equal(s.state.saves,0);
  assert.equal(s.state.cleaned,'/test/#today');
  s.importURL('?act_2026-10-31=5000&wt_2026-10-31=30&act_2026-11-07=0&wt_2026-11-07=250');
  eq(s.read('Object.keys(FIT.act).sort()'),['2026-10-31','2026-11-07']);
  assert.equal(s.run('FIT.wt["2026-10-31"].kg'),30);
  assert.equal(s.run('FIT.wt["2026-11-07"].kg'),250);
  assert.equal(s.state.saves,1);
});

test('逗号小数、千位空格、单位、活动与体重取整；按天覆盖且保存一次', () => {
  const s = sandbox();
  s.run('FIT.act["2026-11-05"] = {kcal:900,at:1};');
  s.importURL('?wt_2026-11-06=72%2C46kg&act_2026-11-05=320%2C5&act_2026-11-06=1%E2%80%AF234.5kcal');
  assert.equal(s.run('FIT.act["2026-11-05"].kcal'),321);
  assert.equal(s.run('FIT.act["2026-11-06"].kcal'),1235);
  assert.equal(s.run('FIT.wt["2026-11-06"].kg'),72.5);
  assert.equal(s.run('FIT.wt["2026-11-07"]'),undefined);
  assert.equal(s.state.saves,1);
});

test('仅体重参数也能识别；非法数值被跳过；多天路径优先', () => {
  const s = sandbox();
  s.importURL('?wt_2026-11-06=72.4&active=999&date=2026-11-07');
  eq(s.read('FIT.act'),{}); assert.equal(s.run('FIT.wt["2026-11-06"].kg'),72.4);
  s.importURL('?act_2026-11-07=NaN&act_2026-11-05=&wt_2026-11-05=Infinity');
  eq(s.read('FIT.act'),{}); assert.equal(s.state.saves,1);
  assert.equal(s.importURL('?unrelated=1'),false);
});

test('部分数值变化时只更新变化的字段，体重也按日期覆盖', () => {
  const s = sandbox(); s.importURL(threeDays);
  const at = s.run('FIT.act["2026-11-07"].at');
  s.clock.now += 60000;
  s.importURL('?act_2026-11-07=150.1&wt_2026-11-07=73.2');
  assert.equal(s.run('FIT.act["2026-11-07"].at'),at);
  assert.equal(s.run('FIT.wt["2026-11-07"].kg'),73.2);
  assert.equal(s.run('FIT.wt["2026-11-07"].at'),s.clock.now);
  assert.equal(s.state.saves,2); assert.equal(s.state.dirty,2);
  assert.equal(s.state.notices.at(-1),'✅ 已从健康导入：11-07 体重 73.2 kg（已更新）');
});

test('存储失败回滚三天记录，渲染后返回，不标记同步成功', () => {
  const s = sandbox(); const before = s.read('FIT'); s.state.fail = true;
  assert.equal(s.importURL(threeDays),true);
  eq(s.read('FIT'),before); assert.equal(s.state.saves,1);
  assert.equal(s.state.dirty,0); assert.equal(s.state.renders,1);
  assert.match(s.state.notices.at(-1),/保存失败/);
});

test('旧单日日期链接及重复保护照常工作，保留原有缺日期提示', () => {
  const s = sandbox();
  const old = '?hk=1&date=2026-11-06&active=410&weight=72.4';
  s.importURL(old);
  assert.equal(s.run('FIT.act["2026-11-06"].kcal'),410);
  assert.equal(s.run('FIT.wt["2026-11-06"].kg'),72.4);
  assert.equal(s.run('CUR_DAY'),'2026-11-06');
  assert.equal(s.run('Object.keys(FIT.extra).filter(k=>k.startsWith("hk:")).length'),1);
  const before = s.read('FIT'); s.clock.now += 60000; s.importURL(old);
  eq(s.read('FIT'),before); assert.equal(s.state.saves,1);
  s.importURL('?hk=1&active=100'); assert.match(s.state.notices.at(-1),/缺少数据所属日期/);
  eq(s.read('FIT'),before);
  s.importURL('?d=2026/11/5&act=320%2C5&wt=72.46');
  assert.equal(s.run('FIT.act["2026-11-05"].kcal'),321);
  assert.equal(s.run('FIT.wt["2026-11-05"].kg'),72.5);
});

test('跨月、闰日和夏令时切换均按当地自然日校验七天范围', () => {
  for (const [today, accepted, rejected] of [
    ['2026-11-02','2026-10-26','2026-10-25'],
    ['2026-03-10','2026-03-03','2026-03-02'],
    ['2028-03-01','2028-02-29','2028-02-30']
  ]) {
    const s = sandbox(today);
    s.importURL(`?act_${accepted}=100&act_${rejected}=200`);
    eq(s.read('Object.keys(FIT.act)'),[accepted]);
  }
});

console.log(`全部通过：静态检查及 ${passed} 组内存回归测试；无浏览器、截图或网络请求。`);
