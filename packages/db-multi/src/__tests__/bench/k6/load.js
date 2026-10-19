/* global __ENV */
// Ladder rung'ları, spike ve soak için tek k6 betiği. PLAN = JSON [[rps, seconds], ...]: her segment önceki hızdan (ilki için
// START_RATE) 1 s rampa yapar ve sabit kalır; istekler seg:sNNN ile etiketlenir, böylece her segmentin kendi p50/p95/p99,
// hata oranı ve sayısı olur. SLO eşikleri: p95 < 50 ms, hata < %1 (segment başına ve genel; değerlendirmeyi run.ts yapar).
import http from 'k6/http';
import exec from 'k6/execution';

const env = (key, fallback) => __ENV[key] ?? fallback;
const BASE = env('BASE_URL', 'http://127.0.0.1:58080');
const OP = env('OP', 'point');
const PLAN = JSON.parse(env('PLAN', '[[50, 10]]'));
const TENANTS = Number(env('TENANTS', 10000));
const USERS = Number(env('TENANT_USERS', 1000));
const BIG = env('BIG_TENANT', 'big');
const BIG_USERS = Number(env('BIG_USERS', 10000000));
const COOKIES = JSON.parse(env('COOKIES', '[]'));

const ends = [];
PLAN.reduce((t, [, seconds]) => (ends.push(t + seconds), t + seconds), 0);
const segName = (i) => `s${String(i).padStart(3, '0')}`;
const thresholds = { http_req_duration: ['p(95)<50'], http_req_failed: ['rate<0.01'] };
PLAN.forEach((_, i) => {
  thresholds[`http_req_duration{seg:${segName(i)}}`] = ['p(95)<50'];
  thresholds[`http_req_failed{seg:${segName(i)}}`] = ['rate<0.01'];
  thresholds[`http_reqs{seg:${segName(i)}}`] = ['count>=0'];
});

export const options = {
  discardResponseBodies: true,
  summaryTrendStats: ['avg', 'min', 'p(50)', 'p(90)', 'p(95)', 'p(99)', 'max'],
  thresholds,
  scenarios: {
    load: {
      executor: 'ramping-arrival-rate',
      startRate: Number(env('START_RATE', PLAN[0][0])),
      timeUnit: '1s',
      preAllocatedVUs: Number(env('PRE_VUS', 100)),
      maxVUs: Number(env('MAX_VUS', 600)),
      stages: PLAN.flatMap(([rate, seconds]) => [{ target: rate, duration: '1s' }, { target: rate, duration: `${seconds - 1}s` }]),
    },
  },
};

const pick = (n) => 1 + Math.floor(Math.random() * n);
const tenant = () => `t${String(Math.floor(Math.random() * TENANTS)).padStart(5, '0')}.bench.test`; // Host başlığı; tenant id ilk etikettir
const hostOf = (id) => `${id}.bench.test`;
const get = (path, host, tags, headers = {}) => http.get(`${BASE}${path}`, { headers: { Host: host, ...headers }, tags, timeout: '10s' });
const post = (path, host, tags) => http.post(`${BASE}${path}`, null, { headers: { Host: host }, tags, timeout: '10s' });

const ops = {
  point: (seg) => get(`/point?id=${pick(USERS)}`, tenant(), { seg, name: 'point' }),
  insert: (seg) => post('/insert', tenant(), { seg, name: 'insert' }),
  health: (seg) => get('/health', tenant(), { seg, name: 'health' }),
  cachedpoint: (seg) => get(`/cached/point?id=${pick(USERS)}`, tenant(), { seg, name: 'cachedpoint' }),
  rawpoint: (seg) => get(`/raw/point?id=${pick(USERS)}`, tenant(), { seg, name: 'rawpoint' }),
  rawinsert: (seg) => post('/raw/insert', tenant(), { seg, name: 'rawinsert' }),
  mixed: (seg) => (Math.random() < 0.8 ? ops.point(seg) : ops.insert(seg)),
  hotpoint: (seg) => get(`/point?id=${pick(BIG_USERS)}`, hostOf(BIG), { seg, name: 'hotpoint' }),
  range: (seg) => get(`/range?after=${pick(BIG_USERS)}&limit=20`, hostOf(BIG), { seg, name: 'range' }),
  bigInsert: (seg) => post('/insert', hostOf(BIG), { seg, name: 'bigInsert' }),
  auth: (seg) => {
    const { host, cookie } = COOKIES[Math.floor(Math.random() * COOKIES.length)];
    return get('/auth/session', host, { seg, name: 'auth' }, { cookie });
  },
};
if (!ops[OP]) throw new Error(`Unknown OP ${OP}`);
if (OP === 'auth' && !COOKIES.length) throw new Error('OP=auth needs COOKIES');

export default function () {
  const elapsed = (Date.now() - exec.scenario.startTime) / 1000;
  const index = ends.findIndex((end) => elapsed < end);
  ops[OP](segName(index < 0 ? PLAN.length - 1 : index));
}

export function handleSummary(data) {
  return { [env('SUMMARY_PATH', 'summary.json')]: JSON.stringify({ metrics: data.metrics }) };
}
