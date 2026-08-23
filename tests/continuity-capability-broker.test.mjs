import test from "node:test";
import assert from "node:assert/strict";
import {
  CAPABILITY_STATE,
  createCapabilityBroker,
  createMemoryCapabilityStore,
  normalizeCapabilityRequest,
} from "../src/continuity/control/capability-broker.js";

const req = (overrides = {}) => ({
  request_id: "cap-1",
  project: "ssmt",
  capability: "relational_store",
  provider: "cloudflare",
  resource: "ssmt-subscribers",
  idempotency_key: "ssmt:subscribers:v1",
  params: { binding: "SUBSCRIBERS_DB" },
  ...overrides,
});

test("capability boundary refuses credential material from an agent", () => {
  assert.throws(
    () => normalizeCapabilityRequest(req({ params: { api_key: "should-never-cross" } })),
    /credential material may not cross/,
  );
});

test("expired short-lived credential is repaired without owner attention", async () => {
  let credentialHealthy = false;
  let repairs = 0;
  const broker = createCapabilityBroker({
    adapters: {
      cloudflare: {
        inspect: async () => credentialHealthy
          ? { kind: "ready", evidence: { principal: "service" } }
          : { kind: "repairable", reason: "access token expired", repair: "refresh" },
        repair: async () => { repairs += 1; credentialHealthy = true; },
      },
    },
  });

  const result = await broker.ensure(req());
  assert.equal(result.state, CAPABILITY_STATE.READY);
  assert.equal(result.repaired, true);
  assert.equal(result.run_disposition, "continue");
  assert.equal(repairs, 1);
  assert.deepEqual(broker.attention(), []);
});

test("missing project resource is provisioned automatically", async () => {
  let exists = false;
  const calls = [];
  const broker = createCapabilityBroker({
    adapters: {
      cloudflare: {
        inspect: async () => exists
          ? { kind: "ready", evidence: { database_id: "db-1", binding: "SUBSCRIBERS_DB" } }
          : { kind: "repairable", reason: "database missing", repair: "provision" },
        repair: async (request) => {
          calls.push([request.project, request.resource, request.params.binding]);
          exists = true;
        },
      },
    },
  });

  const result = await broker.ensure(req());
  assert.equal(result.state, CAPABILITY_STATE.READY);
  assert.deepEqual(calls, [["ssmt", "ssmt-subscribers", "SUBSCRIBERS_DB"]]);
  assert.equal(result.evidence.database_id, "db-1");
});

test("temporary provider failure defers only the privileged action", async () => {
  const broker = createCapabilityBroker({
    adapters: {
      cloudflare: {
        inspect: async () => ({ kind: "deferred", reason: "provider outage", retry_after_ms: 60_000 }),
      },
    },
  });

  const result = await broker.ensure(req());
  assert.equal(result.state, CAPABILITY_STATE.DEFERRED);
  assert.equal(result.run_disposition, "continue", "auth/provider failure must not stop the autonomous run");
  assert.equal(result.retry_after_ms, 60_000);
  assert.deepEqual(broker.attention(), []);
});

test("root authorization revocation creates one coalesced attention item", async () => {
  const broker = createCapabilityBroker({
    adapters: {
      cloudflare: {
        inspect: async () => ({
          kind: "attention",
          reason: "root service authorization revoked",
          attention_key: "cloudflare:reauthorize-root",
          action: "reauthorize Cloudflare operator identity",
        }),
      },
    },
  });

  const a = await broker.ensure(req({ request_id: "cap-a", idempotency_key: "a" }));
  const b = await broker.ensure(req({ request_id: "cap-b", capability: "object_store", resource: "media", idempotency_key: "b" }));

  assert.equal(a.state, CAPABILITY_STATE.ATTENTION_REQUIRED);
  assert.equal(b.state, CAPABILITY_STATE.ATTENTION_REQUIRED);
  assert.equal(a.run_disposition, "continue");
  assert.equal(b.run_disposition, "continue");

  const attention = broker.attention();
  assert.equal(attention.length, 1, "one provider reauthorization must not become repeated owner prompts");
  assert.deepEqual(attention[0].request_ids.sort(), ["cap-a", "cap-b"]);
  assert.equal(attention[0].occurrences, 2);
});

test("an unavailable provider capability does not poison unrelated work", async () => {
  const broker = createCapabilityBroker({
    adapters: {
      cloudflare: { inspect: async () => ({ kind: "deferred", reason: "maintenance" }) },
      github: { inspect: async () => ({ kind: "ready", evidence: { installation: "ok" } }) },
    },
  });

  const deploy = await broker.ensure(req({ request_id: "deploy", idempotency_key: "deploy" }));
  const source = await broker.ensure(req({
    request_id: "source",
    provider: "github",
    capability: "repository_write",
    resource: "in-c0/ssmt",
    idempotency_key: "source",
  }));

  assert.equal(deploy.state, CAPABILITY_STATE.DEFERRED);
  assert.equal(source.state, CAPABILITY_STATE.READY);
});

test("audit records outcomes but not provider credential values", async () => {
  const store = createMemoryCapabilityStore();
  const broker = createCapabilityBroker({
    store,
    adapters: {
      cloudflare: {
        inspect: async () => ({ kind: "ready", evidence: { resource_ref: "db-1" } }),
      },
    },
  });

  await broker.ensure(req());
  const serialized = JSON.stringify(broker.audit());
  assert.match(serialized, /preflight_started/);
  assert.match(serialized, /ready/);
  assert.doesNotMatch(serialized, /api_key|access_token|refresh_token|client_secret|password/i);
});
