// Short load: first the read route, then the insert route; each at RATE requests/s for DURATION (default 200 rps, 10 s).
// k6 run --summary-export results/k6-summary.json k6/load.js  (BASE_URL, READ_TENANT, INSERT_TENANT, RATE, DURATION)
import { check } from "k6";
import http from "k6/http";
import { Counter } from "k6/metrics";

const BASE = __ENV.BASE_URL || "http://127.0.0.1:18080";
const RATE = Number(__ENV.RATE || 200);
const SECONDS = Number(__ENV.DURATION_SECONDS || 10);
const host = (tenant) => ({ headers: { Host: `${tenant}.e2e.test`, "content-type": "application/json" } });
const inserted = new Counter("inserted");

const scenario = (exec, startTime) => ({
  executor: "constant-arrival-rate", rate: RATE, timeUnit: "1s", duration: `${SECONDS}s`, preAllocatedVUs: 50, maxVUs: 300, exec, startTime, tags: { route: exec },
});

export const options = {
  scenarios: { read: scenario("read", "0s"), insert: scenario("insert", `${SECONDS + 2}s`) },
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
  // Tagged sub-metrics only appear in the summary if they are named in a threshold; the latency threshold is informational.
  thresholds: {
    "http_req_failed{route:read}": ["rate<0.01"],
    "http_req_failed{route:insert}": ["rate<0.01"],
    "http_req_duration{route:read}": ["p(95)<1000"],
    "http_req_duration{route:insert}": ["p(95)<1000"],
    "iterations{route:read}": ["count>0"],
    "iterations{route:insert}": ["count>0"],
  },
};

export function read() {
  const res = http.get(`${BASE}/users?limit=20`, host(__ENV.READ_TENANT || "kadikoy"));
  check(res, { "read 200": (r) => r.status === 200 });
}

export function insert() {
  // No email is sent: the app derives a unique email from the id.
  const res = http.post(`${BASE}/users`, JSON.stringify({ name: "k6" }), host(__ENV.INSERT_TENANT || "moda"));
  if (check(res, { "insert 201": (r) => r.status === 201 })) inserted.add(1);
}
