// Run: npx tsx test/npm-monitor.test.ts
import assert from "node:assert/strict";
import { NPMMonitor } from "../src/npm-monitor.js";
import { NPMHost } from "../src/types.js";

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

console.log("npm-monitor tests passed");
