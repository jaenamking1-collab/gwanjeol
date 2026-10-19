// 관절기상청 — 무릎 vs 예보. 화면은 public/, 여기는 /api 와 매일 예약 작업.
export const REGIONS = {
  서울: [37.57, 126.98], 부산: [35.18, 129.08], 대구: [35.87, 128.6], 인천: [37.46, 126.71],
  광주: [35.16, 126.85], 대전: [36.35, 127.38], 울산: [35.54, 129.31], 세종: [36.48, 127.29],
  경기북부: [37.74, 127.05], 경기남부: [37.26, 127.03], 강원영서: [37.88, 127.73], 강원영동: [37.75, 128.88], 충북: [36.64, 127.49], 충남: [36.6, 126.66],
  전북: [35.82, 127.15], 전남: [34.81, 126.39], 경북: [36.57, 128.73], 경남: [35.23, 128.68],
  제주: [33.5, 126.53],
};
const NAMES = Object.keys(REGIONS);
const DEADLINE_H = 23; // 밤 11시 마감 = 예보 박제 시각
const RAIN_POP = 50;   // 강수확률 50% 이상이면 '비 예보'
const RAIN_MM = 1;     // 실제 1mm 이상이면 '비 왔다'

const kst = (ms = Date.now()) => new Date(ms + 9 * 3600e3);
const ymd = d => d.toISOString().slice(0, 10);
const addDay = (s, n) => ymd(new Date(Date.parse(s) + n * 864e5));
// 지금 투표하면 어느 날짜에 대한 투표인가
export const targetDay = (ms = Date.now()) => {
  const k = kst(ms);
  return addDay(ymd(k), k.getUTCHours() >= DEADLINE_H ? 2 : 1);
};

async function weather() {
  const lat = NAMES.map(n => REGIONS[n][0]).join(','), lon = NAMES.map(n => REGIONS[n][1]).join(',');
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&daily=precipitation_sum,precipitation_probability_max,temperature_2m_max,temperature_2m_min,weather_code` +
    `&current=surface_pressure,relative_humidity_2m&timezone=Asia%2FSeoul&past_days=2&forecast_days=4`;
  const r = await fetch(u, { cf: { cacheTtl: 600 } });
  if (!r.ok) throw new Error('open-meteo ' + r.status);
  const arr = await r.json();
  const out = {};
  NAMES.forEach((n, i) => {
    const d = arr[i].daily, days = {};
    d.time.forEach((t, j) => days[t] = {
      pop: d.precipitation_probability_max[j], mm: d.precipitation_sum[j],
      tmax: d.temperature_2m_max[j], tmin: d.temperature_2m_min[j], code: d.weather_code[j],
    });
    out[n] = { days, pressure: arr[i].current.surface_pressure, humidity: arr[i].current.relative_humidity_2m };
  });
  return out;
}

// 밤 11시: 내일 예보를 박제한다 (무릎과 같은 시점의 예보로 겨룬다)
export async function snapshot(env, ms = Date.now()) {
  const day = ymd(new Date(Date.parse(ymd(kst(ms))) + 864e5)), wx = await weather();
  await env.DB.batch(NAMES.map(n => {
    const f = wx[n].days[day];
    return env.DB.prepare(`INSERT INTO results (day,region,fc_pop,fc_mm,fc_rain,pressure,humidity) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(day,region) DO UPDATE SET fc_pop=excluded.fc_pop,fc_mm=excluded.fc_mm,fc_rain=excluded.fc_rain,pressure=excluded.pressure,humidity=excluded.humidity`)
      .bind(day, n, f.pop, f.mm, f.pop >= RAIN_POP ? 1 : 0, wx[n].pressure, wx[n].humidity);
  }));
  await setMeta(env, 'snapshot', new Date(ms).toISOString());
  return day;
}

// 새벽 3시: 어제 실제 강수로 채점
export async function score(env, ms = Date.now()) {
  const day = addDay(ymd(kst(ms)), -1), wx = await weather();
  const stmts = [];
  for (const n of NAMES) {
    const res = await env.DB.prepare('SELECT fc_rain FROM results WHERE day=? AND region=?').bind(day, n).first();
    if (!res) continue; // 박제 안 된 날은 판정하지 않는다
    const mm = wx[n].days[day]?.mm;
    if (mm == null) continue;
    const act = mm >= RAIN_MM ? 1 : 0;
    const v = await env.DB.prepare('SELECT COUNT(*) c, SUM(pick=2) r FROM votes WHERE day=? AND region=?').bind(day, n).first();
    const knee = v.c ? (v.r * 2 >= v.c ? 1 : 0) : null;
    const fcOk = res.fc_rain === act, kneeOk = knee === act;
    const winner = knee == null ? null : kneeOk && !fcOk ? 'knee' : fcOk && !kneeOk ? 'fc' : 'draw';
    stmts.push(env.DB.prepare('UPDATE results SET act_mm=?,act_rain=?,knee_rain=?,votes=?,winner=? WHERE day=? AND region=?')
      .bind(mm, act, knee, v.c, winner, day, n));
    // 맞히면 1점, 예보와 다르게 찍어서 맞히면 3점
    stmts.push(env.DB.prepare(`UPDATE votes SET correct=((pick=2)=?),
      points=CASE WHEN (pick=2)<>? THEN 0 WHEN (pick=2)<>? THEN 3 ELSE 1 END WHERE day=? AND region=?`)
      .bind(act, act, res.fc_rain, day, n));
  }
  if (stmts.length) await env.DB.batch(stmts);
  await setMeta(env, 'score', new Date(ms).toISOString());
  return { day, regions: stmts.length / 2 };
}

const setMeta = (env, k, v) => env.DB.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').bind(k, v).run();
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json; charset=utf-8' } });
const sha = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');

async function api(req, env, url) {
  const token = req.headers.get('x-token') || '';
  const p = url.pathname;

  if (p === '/api/today') {
    const region = REGIONS[url.searchParams.get('region')] ? url.searchParams.get('region') : '서울';
    const day = targetDay(), yday = addDay(ymd(kst()), -1), wx = await weather();
    const [counts, mine, last, total, user, meta] = await Promise.all([
      env.DB.prepare('SELECT pick, COUNT(*) c FROM votes WHERE day=? AND region=? GROUP BY pick').bind(day, region).all(),
      env.DB.prepare('SELECT pick, region FROM votes WHERE day=? AND token=?').bind(day, token).first(),
      env.DB.prepare('SELECT * FROM results WHERE day=? AND region=?').bind(yday, region).first(),
      env.DB.prepare("SELECT SUM(winner='knee') knee, SUM(winner='fc') fc, SUM(winner='draw') draw FROM results").first(),
      env.DB.prepare('SELECT nick FROM users WHERE token=?').bind(token).first(),
      env.DB.prepare('SELECT k, v FROM meta').all(),
    ]);
    const f = wx[region].days[day];
    return json({
      region, day, yday, forecast: { ...f, rain: f.pop >= RAIN_POP }, pressure: wx[region].pressure, humidity: wx[region].humidity,
      counts: [0, 1, 2].map(i => counts.results.find(r => r.pick === i)?.c || 0),
      mine, last, total, nick: user?.nick || null, meta: Object.fromEntries(meta.results.map(r => [r.k, r.v])),
    });
  }

  if (p === '/api/vote' && req.method === 'POST') {
    const b = await req.json().catch(() => ({}));
    const pick = b.pick, region = b.region, nick = String(b.nick || '').trim();
    if (!/^[0-9a-f-]{36}$/.test(token)) return json({ error: '잘못된 요청입니다' }, 400);
    if (![0, 1, 2].includes(pick) || !REGIONS[region]) return json({ error: '잘못된 요청입니다' }, 400);
    const day = targetDay(), ip = await sha((req.headers.get('cf-connecting-ip') || '') + day);
    let user = await env.DB.prepare('SELECT nick FROM users WHERE token=?').bind(token).first();
    if (!user) {
      if (!/^[가-힣a-zA-Z0-9_]{2,10}$/.test(nick)) return json({ error: '닉네임은 한글·영문·숫자 2~10자입니다' }, 400);
      // 대소문자만 다른 닉네임(Knee/knee)도 같은 것으로 본다
      if (await env.DB.prepare('SELECT 1 FROM users WHERE lower(nick)=lower(?)').bind(nick).first()) return json({ error: '이미 있는 닉네임입니다. 다른 이름을 써 주세요' }, 409);
    }
    if (await env.DB.prepare('SELECT 1 FROM votes WHERE day=? AND token=?').bind(day, token).first())
      return json({ error: '이미 투표하셨습니다. 내일 또 와주세요' }, 409);
    // 창·브라우저를 바꿔도 같은 인터넷(IP)이면 하루 1표. 표가 들어갈 때만 닉네임을 만든다
    if (await env.DB.prepare('SELECT 1 FROM votes WHERE day=? AND iphash=?').bind(day, ip).first())
      return json({ error: '이 인터넷(IP)에서는 오늘 이미 투표했습니다. 내일 또 와주세요' }, 409);
    const now = new Date().toISOString(), stmts = [];
    if (!user) stmts.push(env.DB.prepare('INSERT INTO users VALUES (?,?,?)').bind(token, nick, now));
    stmts.push(env.DB.prepare('INSERT INTO votes (day,region,token,pick,iphash,created) VALUES (?,?,?,?,?,?)').bind(day, region, token, pick, ip, now));
    try { await env.DB.batch(stmts); } // 동시에 눌러도 DB 고유 제약이 한 표만 남긴다
    catch (e) { return json({ error: '이미 투표했거나 같은 닉네임이 있습니다' }, 409); }
    return json({ ok: true, day });
  }

  if (p === '/api/board') {
    // 프로기상관: 채점 10회 이상 + 같은 날 예보보다 적중률이 높은 사람
    const rows = await env.DB.prepare(`SELECT u.nick, COUNT(*) n, SUM(v.correct) ok, SUM(v.points) pts,
        SUM(r.fc_rain=r.act_rain) fcok
      FROM votes v JOIN users u ON u.token=v.token JOIN results r ON r.day=v.day AND r.region=v.region
      WHERE v.correct IS NOT NULL GROUP BY v.token ORDER BY pts DESC, ok DESC LIMIT 30`).all();
    const me = token ? await env.DB.prepare(`SELECT COUNT(*) n, SUM(correct) ok, SUM(points) pts FROM votes WHERE token=? AND correct IS NOT NULL`).bind(token).first() : null;
    return json({ rows: rows.results.map(r => ({ ...r, pro: r.n >= 10 && r.ok > r.fcok })), me });
  }

  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    // 수동 재실행: /api/run?job=snapshot|score  (헤더 x-admin = ADMIN_KEY 비밀값)
    if (url.pathname === '/api/run' && env.ADMIN_KEY && req.headers.get('x-admin') === env.ADMIN_KEY)
      return json(await (url.searchParams.get('job') === 'snapshot' ? snapshot(env) : score(env)));
    try { return await api(req, env, url); }
    catch (e) { return json({ error: '잠시 후 다시 시도해 주세요', detail: String(e.message || e) }, 500); }
  },
  async scheduled(ev, env) {
    if (ev.cron === '0 14 * * *') await snapshot(env);
    else await score(env);
  },
};
