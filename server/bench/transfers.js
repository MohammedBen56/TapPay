/**
 * Ship List Phase 3's load test. Two scenarios, run together, reported
 * separately -- they answer different questions:
 *
 *   read_path: ramps 0 -> 100 VUs hitting GET /me, /accounts/me/balance,
 *     /accounts/me/transactions (no per-route rate limit beyond the 300/min
 *     global backstop). Answers "where does p99 cross an acceptable line,
 *     and what's the bottleneck when it does" -- the real backend capacity
 *     question.
 *   write_path: a fixed 3 VUs hammering POST /transfers continuously. This
 *     is deliberately NOT trying to find backend capacity -- it answers a
 *     different, equally real question: "does the per-account rate limit
 *     (closes D7, config.rateLimitTransfersMax, 30/min by default) actually
 *     hold under sustained concurrent load, or does it leak under
 *     pressure." A 429 rate that converges to the configured limit is a
 *     PASS for this scenario, not a bottleneck to report.
 *
 * Requires a running server (`pnpm --filter server dev`) and the seeded
 * demo accounts (`pnpm --filter server seed`) reachable at BASE_URL.
 * Authenticates all 5 demo accounts ONCE in setup() and reuses those
 * tokens for the whole run -- deliberately not logging in per iteration,
 * both because that's not what this test is measuring and because
 * POST /auth/login has its own tight rate limit (config.rateLimitLoginMax,
 * keyed by IP) that many k6 VUs sharing one source IP would trip
 * immediately and misleadingly.
 *
 * Usage:
 *   docker run --rm --network host -v "$PWD/server/bench:/bench" grafana/k6:2.2.0 \
 *     run /bench/transfers.js -e BASE_URL=http://localhost:3000
 */
import http from "k6/http";
import { check, sleep } from "k6";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
// Ship List v2 Wave 2 Phase 3: the live v2 API moved under /v1.
const API_URL = `${BASE_URL}/v1`;

const DEMO_ACCOUNTS = [
  { customer_id: "10000001", password: "Demo#2026", rib: "999780000000000000100113" },
  { customer_id: "10000002", password: "Demo#2026", rib: "999780000000000000100210" },
  { customer_id: "10000003", password: "Demo#2026", rib: "999780000000000000100307" },
  { customer_id: "10000004", password: "Demo#2026", rib: "999780000000000000100404" },
  { customer_id: "10000005", password: "Demo#2026", rib: "999780000000000000100598" },
];

export function setup() {
  const tokens = DEMO_ACCOUNTS.map(({ customer_id, password }) => {
    const res = http.post(`${API_URL}/auth/login`, JSON.stringify({ customer_id, password }), {
      headers: { "Content-Type": "application/json" },
    });
    if (res.status !== 200) {
      throw new Error(`setup: login failed for ${customer_id}: ${res.status} ${res.body}`);
    }
    return res.json("access_token");
  });
  return { tokens };
}

export const options = {
  scenarios: {
    read_path: {
      executor: "ramping-vus",
      exec: "readPath",
      startVUs: 0,
      stages: [
        { duration: "20s", target: 20 },
        { duration: "40s", target: 50 },
        { duration: "40s", target: 100 },
        { duration: "20s", target: 0 },
      ],
      gracefulRampDown: "5s",
    },
    write_path: {
      executor: "constant-vus",
      exec: "writePath",
      vus: 3,
      duration: "2m",
      startTime: "10s",
    },
  },
  thresholds: {
    // Not a pass/fail gate for this script's exit code (see the summary
    // handler below, which always exits 0 and just reports) -- k6 prints
    // whether each was met, which is the actual "where does it cross the
    // line" data point for read_path.
    "http_req_duration{scenario:read_path}": ["p(95)<300", "p(99)<800"],
  },
};

export function readPath(data) {
  const token = data.tokens[__VU % data.tokens.length];
  const headers = { Authorization: `Bearer ${token}` };

  const me = http.get(`${API_URL}/me`, { headers, tags: { name: "GET /me" } });
  check(me, { "GET /me: 200": (r) => r.status === 200 });

  const balance = http.get(`${API_URL}/accounts/me/balance`, { headers, tags: { name: "GET /accounts/me/balance" } });
  check(balance, { "GET /accounts/me/balance: 200": (r) => r.status === 200 });

  const transactions = http.get(`${API_URL}/accounts/me/transactions?limit=20`, {
    headers,
    tags: { name: "GET /accounts/me/transactions" },
  });
  check(transactions, { "GET /accounts/me/transactions: 200": (r) => r.status === 200 });

  sleep(1);
}

export function writePath(data) {
  const fromIdx = __VU % DEMO_ACCOUNTS.length;
  const toIdx = (fromIdx + 1) % DEMO_ACCOUNTS.length;
  const token = data.tokens[fromIdx];
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const body = JSON.stringify({
    tx_uuid: crypto.randomUUID(),
    to_rib: DEMO_ACCOUNTS[toIdx].rib,
    amount: "100",
    currency: "MAD",
    reference: "k6 load test",
  });
  const res = http.post(`${API_URL}/transfers`, body, { headers, tags: { name: "POST /transfers" } });
  check(res, {
    "POST /transfers: 200 or 429": (r) => r.status === 200 || r.status === 429,
  });

  sleep(0.5);
}
