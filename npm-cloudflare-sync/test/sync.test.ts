// Run: npx tsx test/sync.test.ts
import assert from "node:assert/strict";
import { NPMHost, DNSRecord } from "../src/types.js";

Object.assign(process.env, {
  NODE_ENV: "production", LOG_LEVEL: "error", CF_API_TOKEN: "test-token",
  CF_EMAIL: "test@example.nl", NPM_API_URL: "http://unused.invalid",
  NPM_EMAIL: "test@example.nl", NPM_PASSWORD: "test-password",
});
const { CloudflareAPI } = await import("../src/cloudflare.js");
const { handleNPMChanges } = await import("../src/index.js");
const host = (id: number, domains: string | string[]): NPMHost => ({
  id, domain_names: domains, forward_host: "x", forward_port: 80,
  created_on: "2026-01-01", modified_on: "2026-01-01",
});
const record: DNSRecord = {
  id: "record-www", name: "www.example.nl", type: "CNAME",
  content: "example.nl", proxied: true,
};
const calls: string[] = [];
const original = {
  initZones: CloudflareAPI.prototype.initZones,
  getDNSRecords: CloudflareAPI.prototype.getDNSRecords,
  deleteDNSRecord: CloudflareAPI.prototype.deleteDNSRecord,
};
CloudflareAPI.prototype.initZones = async () => { calls.push("init"); };
CloudflareAPI.prototype.getDNSRecords = async (domain) => {
  calls.push(`read:${domain}`);
  return [record];
};
CloudflareAPI.prototype.deleteDNSRecord = async (domain, id) => {
  calls.push(`delete:${domain}:${id}`);
  return true;
};

try {
  // Deleting and recreating a host with another ID must preserve its DNS record.
  await handleNPMChanges([host(2, " WWW.EXAMPLE.NL. , other.example.nl")], [], [host(1, ["www.example.nl"])]);
  assert.deepEqual(calls, ["init"]);
  calls.length = 0;
  await handleNPMChanges([host(2, ["www.example.nl"])], [], [host(1, " WWW.EXAMPLE.NL. ")]);
  assert.deepEqual(calls, ["init"]);
  calls.length = 0;

  // A genuinely removed domain is still deleted after monitor confirmation.
  await handleNPMChanges([host(2, ["other.example.nl"])], [], [host(1, ["www.example.nl"])]);
  assert.deepEqual(calls, ["init", "read:www.example.nl", "delete:www.example.nl:record-www"]);
  calls.length = 0;

  // Reject an empty source before initZones, which can itself update DNS.
  await assert.rejects(
    () => handleNPMChanges([], [], [host(1, ["www.example.nl"])]),
    /Refusing DNS deletions/
  );
  assert.deepEqual(calls, []);
} finally {
  Object.assign(CloudflareAPI.prototype, original);
}
console.log("sync safety tests passed");
