// Run: npm test
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { mock } from "node:test";
import { NPMMonitor } from "../src/npm-monitor.js";
import { NPMHost } from "../src/types.js";
import { logger } from "../src/logger.js";

logger.silent = true;

const host = (id: number): NPMHost => ({
  id, domain_names: [`h${id}.example.nl`], forward_host: "x", forward_port: 80,
  created_on: "2026-01-01", modified_on: "2026-01-01",
});

function monitorWith(responses: Array<NPMHost[] | Error>) {
  const m = new NPMMonitor("http://npm", "e", "p", 1000) as any;
  m.getProxyHosts = async () => {
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return r!;
  };
  return m;
}

// 1. Failed fetch propagates as error, never as an empty list
{
  const m = monitorWith([[host(1), host(2)], new Error("Token has expired")]);
  await m.getChangesSinceLastCheck();
  await assert.rejects(() => m.getChangesSinceLastCheck(), /Token has expired/);
  assert.equal(m.lastKnownHosts.length, 2, "known hosts untouched after failure");
}

// 2. Sudden empty list is refused
{
  const m = monitorWith([[host(1)], []]);
  await m.getChangesSinceLastCheck();
  await assert.rejects(() => m.getChangesSinceLastCheck(), /refusing to sync/);
}

// 3. Deletion only after 3 consecutive successful checks without the host
{
  const m = monitorWith([[host(1), host(2)], [host(1)], [host(1)], [host(1)]]);
  await m.getChangesSinceLastCheck();
  assert.equal((await m.getChangesSinceLastCheck()).deletedHosts.length, 0);
  assert.equal((await m.getChangesSinceLastCheck()).deletedHosts.length, 0);
  const r = await m.getChangesSinceLastCheck();
  assert.deepEqual(r.deletedHosts.map((h: NPMHost) => h.id), [2]);
  assert.equal(m.lastKnownHosts.length, 1);
}

// 4. Host that reappears resets the counter
{
  const m = monitorWith([[host(1), host(2)], [host(1)], [host(1), host(2)], [host(1)], [host(1)]]);
  for (let i = 0; i < 5; i++) {
    const r = await m.getChangesSinceLastCheck();
    assert.equal(r.deletedHosts.length, 0, `check ${i}`);
  }
  assert.equal(m.missingCounts.get(2), 2);
}

// Errors and rejected empty snapshots break the run of deletion confirmations.
for (const failure of [new Error("NPM unavailable"), []]) {
  const m = monitorWith([
    [host(1), host(2)], [host(1)], [host(1)], failure,
    [host(1)], [host(1)], [host(1)],
  ]);
  for (let i = 0; i < 3; i++) await m.getChangesSinceLastCheck();
  await assert.rejects(() => m.getChangesSinceLastCheck());
  assert.equal(m.missingCounts.size, 0);
  assert.equal((await m.getChangesSinceLastCheck()).deletedHosts.length, 0);
  assert.equal((await m.getChangesSinceLastCheck()).deletedHosts.length, 0);
  assert.deepEqual((await m.getChangesSinceLastCheck()).deletedHosts.map((h: NPMHost) => h.id), [2]);
}

// Exercise real HTTP/auth/retry parsing; no Cloudflare requests are made.
const api = {
  loginStatus: 200,
  tokenBody: { token: "fresh-token" } as unknown,
  hostStatus: 200,
  hostBody: [host(1), host(2)] as unknown,
  rejectedTokenStatus: 400,
  stallPath: "",
  logins: 0,
  hostRequests: 0,
  authorization: [] as Array<string | undefined>,
};
const server = createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === api.stallPath) {
    res.writeHead(200);
    res.flushHeaders(); // A stalled body must still hit the request timeout.
    return;
  }
  if (req.url === "/api/tokens") {
    api.logins++;
    res.statusCode = api.loginStatus;
    res.end(JSON.stringify(api.tokenBody));
  } else if (req.url === "/api/nginx/proxy-hosts") {
    api.hostRequests++;
    api.authorization.push(req.headers.authorization);
    const expired = req.headers.authorization === "Bearer expired-token";
    res.statusCode = expired ? api.rejectedTokenStatus : api.hostStatus;
    res.end(JSON.stringify(expired ? { error: { message: "Token has expired" } } : api.hostBody));
  } else {
    res.writeHead(404).end();
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address !== "string");
function httpMonitor() {
  const m = new NPMMonitor(`http://127.0.0.1:${(address as { port: number }).port}`, "e", "p", 1000) as any;
  m.retryDelay = 0;
  m.requestTimeout = 1000;
  return m;
}

try {
  // NPM's actual 400 expiry response, plus 401/403, must refresh the token.
  for (const status of [400, 401, 403]) {
    const m = httpMonitor();
    await m.getChangesSinceLastCheck();
    m.token = "expired-token";
    api.rejectedTokenStatus = status;
    const logins = api.logins;
    const result = await m.getChangesSinceLastCheck();
    assert.equal(api.logins, logins + 1);
    assert.deepEqual(api.authorization.slice(-2), ["Bearer expired-token", "Bearer fresh-token"]);
    assert.equal(result.currentHosts.length, 2);
    assert.equal(result.deletedHosts.length, 0);
  }

  // Failed refresh and server errors preserve the last successful snapshot.
  for (const status of [400, 401, 403, 500]) {
    const m = httpMonitor();
    await m.getChangesSinceLastCheck();
    api.hostStatus = status;
    await assert.rejects(() => m.getChangesSinceLastCheck(), /fetch proxy hosts failed/);
    assert.deepEqual(m.lastKnownHosts, [host(1), host(2)]);
    api.hostStatus = 200;
  }
  {
    const m = httpMonitor();
    await m.getChangesSinceLastCheck();
    m.token = "expired-token";
    api.loginStatus = 401;
    await assert.rejects(() => m.getChangesSinceLastCheck());
    assert.deepEqual(m.lastKnownHosts, [host(1), host(2)]);
    api.loginStatus = 200;
  }

  // HTTP 200 is insufficient: never admit malformed/duplicate/empty snapshots.
  for (const body of [
    null, {}, { error: "Token has expired" }, "<html>Login</html>",
    [null], [host(1), { ...host(2), id: "2" }], [host(1), host(1)],
    [host(1), { ...host(2), domain_names: [] }],
    [host(1), { ...host(2), domain_names: [null] }],
    [host(1), { ...host(2), domain_names: " " }], [],
  ]) {
    const m = httpMonitor();
    await m.getChangesSinceLastCheck();
    api.hostBody = body;
    await assert.rejects(() => m.getChangesSinceLastCheck());
    assert.deepEqual(m.lastKnownHosts, [host(1), host(2)]);
    api.hostBody = [host(1), host(2)];
  }
  for (const body of [null, {}, { token: " " }, { token: 42 }]) {
    const m = httpMonitor();
    api.tokenBody = body;
    const requests = api.hostRequests;
    await assert.rejects(() => m.getProxyHosts());
    assert.equal(api.hostRequests, requests, "invalid login must not fetch hosts");
  }
  api.tokenBody = { token: "fresh-token" };

  // Successful re-logins must not erase consecutive failed host checks.
  {
    const m = httpMonitor();
    await m.getChangesSinceLastCheck();
    api.hostStatus = 400;
    for (let failures = 1; failures <= 5; failures++) {
      await assert.rejects(() => m.getChangesSinceLastCheck());
      assert.equal(m.consecutiveFailures, failures);
    }
    api.hostStatus = 200;
  }
  for (const path of ["/api/tokens", "/api/nginx/proxy-hosts"]) {
    const m = httpMonitor();
    m.maxRetries = 1;
    m.requestTimeout = 50;
    api.stallPath = path;
    await assert.rejects(() => m.getProxyHosts());
    api.stallPath = "";
  }
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

// Tick the interval manually while a fetch, then the DNS callback, is pending.
{
  let tick!: () => void;
  const intervalMock = mock.method(globalThis, "setInterval", (fn: () => void) => {
    tick = fn;
    return 0 as any;
  });
  const m = monitorWith([[host(1)]]);
  let releaseFetch!: (hosts: NPMHost[]) => void;
  let releaseCallback!: () => void;
  let fetches = 0;
  let callbacks = 0;
  try {
    await m.startMonitoring(async () => {
      callbacks++;
      if (callbacks === 2) await new Promise<void>((resolve) => { releaseCallback = resolve; });
    });
    m.getProxyHosts = async () => {
      fetches++;
      return new Promise<NPMHost[]>((resolve) => { releaseFetch = resolve; });
    };
    tick();
    tick();
    await nextTurn();
    assert.equal(fetches, 1, "only one fetch may be active");
    releaseFetch([host(1), host(2)]);
    await nextTurn();
    assert.equal(callbacks, 2);
    tick();
    await nextTurn();
    assert.equal(fetches, 1, "DNS callback also holds the in-flight guard");
    releaseCallback();
    await nextTurn();
    tick();
    assert.equal(fetches, 2, "monitoring resumes after callback completion");
    releaseFetch([host(1), host(2)]);
    await nextTurn();
    m.getProxyHosts = async () => { throw new Error("offline"); };
    tick();
    await nextTurn();
    assert.equal(m.isChecking, false, "failure releases the in-flight guard");
  } finally {
    m.stopMonitoring();
    intervalMock.mock.restore();
  }
}

console.log("npm-monitor tests passed (HTTP auth, failed/invalid snapshots, confirmation reset, timeouts, overlap)");
