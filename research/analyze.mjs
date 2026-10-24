import fs from 'node:fs';
const arr = JSON.parse(fs.readFileSync('research/issues_clean.json','utf8'));
const norm = (s) => (s||'').replace(/\r/g,'');
function parse(b){
  const t = norm(b);
  const name = (t.match(/项目名称[：:]\s*([^\n]*?)(?=项目地址|项目简介|$)/s)||[])[1]||'';
  const url  = (t.match(/(https?:\/\/github\.com\/[^\s)\]]+)/)||[])[1]||'';
  const intro= (t.match(/项目简介[：:]\s*([\s\S]*)$/)||[])[1]||'';
  return { name: name.trim(), url: url.replace(/[.,，。]$/,''), intro: intro.trim() };
}
const CATS = [
  ['省钱比价', /省钱|比价|划算|最省|优惠券|领券|薅|便宜|凑单|满减|性价比/],
  ['套餐推荐', /推荐|搭配|配餐|组合|吃什么|选择困难|纠结|帮我点/],
  ['一键点单', /一键|下单|点餐|自动点|代点|点单|结算/],
  ['营养健康', /热量|卡路里|营养|减脂|健身|蛋白|健康|增肌|减肥/],
  ['多人聚餐', /多人|聚餐|团建|聚会|拼单|分享餐|家庭/],
  ['积分商城', /积分|商城|抽奖|兑换|麦麦省|会员/],
  ['儿童亲子', /儿童|亲子|开心乐园|生日|小朋友|宝宝/],
  ['早餐咖啡', /早餐|咖啡|麦咖啡|下午茶|夜宵/],
  ['语音对话', /语音|对话|聊天|机器人|微信|小程序|公众号|助手|Agent|智能体/],
  ['数据洞察', /分析|报表|统计|趋势|数据|洞察|可视化|看板/],
  ['趣味整活', /游戏|抽卡|盲盒|塔罗|MBTI|星座|梗|整活|情绪|心理/],
];
const rows = arr.map(i => { const p = parse(i.body); return { num: i.num, ...p, user: i.user, state: i.state, comments: i.comments }; })
  .filter(r => r.name || r.url);
console.log('有效报名条目:', rows.length, '| 去重仓库:', new Set(rows.map(r=>r.url)).size);
const hit = Object.fromEntries(CATS.map(([k])=>[k,[]]));
for (const r of rows){
  const txt = (r.name + ' ' + r.intro);
  for (const [k,re] of CATS) if (re.test(txt)) hit[k].push(r);
}
console.log('\n=== 选题分布（一个作品可命中多类）===');
for (const [k] of CATS) console.log(String(hit[k].length).padStart(4), k);
fs.writeFileSync('research/parsed.json', JSON.stringify(rows,null,1));
fs.writeFileSync('research/cats.json', JSON.stringify(hit,null,1));
console.log('\n=== 名字里带"省钱/比价/划算"的作品（前 25）===');
for (const r of hit['省钱比价'].slice(0,25)) console.log(`#${r.num} ${r.name.slice(0,40)}  ${r.url}`);
