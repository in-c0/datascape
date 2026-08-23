// Persistent capability-broker contract for Continuity.
//
// The broker is the boundary between ordinary agents and privileged provider
// operations. Agents ask for capabilities; they do not receive or submit
// provider credentials. Provider adapters own credential retrieval/refresh and
// resource provisioning behind this interface.

export const CAPABILITY_STATE = Object.freeze({
  READY: "READY",
  REPAIRING: "REPAIRING",
  DEFERRED: "DEFERRED",
  ATTENTION_REQUIRED: "ATTENTION_REQUIRED",
});

const FORBIDDEN_CREDENTIAL_KEYS = new Set([
  "token", "access_token", "refresh_token", "api_key", "apikey", "secret",
  "client_secret", "password", "credential", "credentials", "private_key",
]);

function credentialKeyPath(value, path = "request") {
  if (!value || typeof value !== "object") return null;
  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[- ]/g, "_");
    if (FORBIDDEN_CREDENTIAL_KEYS.has(normalized)) return `${path}.${key}`;
    const child = credentialKeyPath(nested, `${path}.${key}`);
    if (child) return child;
  }
  return null;
}

export function normalizeCapabilityRequest(input = {}) {
  const request = {
    request_id: input.request_id,
    project: input.project,
    capability: input.capability,
    provider: input.provider ?? "default",
    resource: input.resource ?? null,
    operation: input.operation ?? "ensure",
    idempotency_key: input.idempotency_key ?? input.request_id,
    params: input.params ?? {},
  };

  for (const field of ["request_id", "project", "capability", "provider", "idempotency_key"]) {
    if (typeof request[field] !== "string" || !request[field].trim()) {
      throw new TypeError(`capability request requires non-empty ${field}`);
    }
  }

  const credentialPath = credentialKeyPath(request);
  if (credentialPath) {
    throw new TypeError(`credential material may not cross the capability boundary (${credentialPath})`);
  }

  return Object.freeze(request);
}

export function createMemoryCapabilityStore() {
  const requests = new Map();
  const attention = new Map();
  const audit = [];

  return {
    putRequest(record) { requests.set(record.request.request_id, structuredClone(record)); },
    getRequest(id) { const r = requests.get(id); return r ? structuredClone(r) : null; },
    listRequests() { return [...requests.values()].map((value) => structuredClone(value)); },
    putAttention(item) { attention.set(item.key, structuredClone(item)); },
    getAttention(key) { const i = attention.get(key); return i ? structuredClone(i) : null; },
    listAttention() { return [...attention.values()].map((value) => structuredClone(value)); },
    appendAudit(event) { audit.push(structuredClone(event)); },
    listAudit() { return audit.map((value) => structuredClone(value)); },
  };
}

function safeReason(value, fallback) {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function recordFor(request, state, now, extra = {}) {
  return {
    request,
    state,
    updated_at: new Date(now()).toISOString(),
    run_disposition: "continue",
    ...extra,
  };
}

function audit(store, now, request, event, extra = {}) {
  // Deliberately record identifiers and outcomes only. Provider adapters may
  // have used credentials internally, but those values never enter this log.
  store.appendAudit({
    at: new Date(now()).toISOString(),
    request_id: request.request_id,
    project: request.project,
    capability: request.capability,
    provider: request.provider,
    event,
    ...extra,
  });
}

function classifyThrown(error) {
  if (error?.human_required === true) {
    return {
      kind: "attention",
      reason: safeReason(error.message, "provider requires human reauthorization"),
      attention_key: error.attention_key,
      action: error.action ?? null,
    };
  }
  return {
    kind: "deferred",
    reason: safeReason(error?.message, "provider operation failed temporarily"),
    retry_after_ms: Number.isFinite(error?.retry_after_ms) ? error.retry_after_ms : null,
  };
}

export function createCapabilityBroker({ adapters = {}, store = createMemoryCapabilityStore(), now = () => Date.now() } = {}) {
  const adapterFor = (request) => adapters[request.provider] ?? adapters.default ?? null;

  function defer(request, reason, retryAfterMs = null) {
    const record = recordFor(request, CAPABILITY_STATE.DEFERRED, now, {
      reason,
      retry_after_ms: retryAfterMs,
    });
    store.putRequest(record);
    audit(store, now, request, "deferred", { reason });
    return record;
  }

  function requireAttention(request, finding = {}) {
    const key = finding.attention_key
      ?? `${request.provider}:${safeReason(finding.reason, "authorization_required")}`;
    const previous = store.getAttention(key);
    const item = previous
      ? {
          ...previous,
          request_ids: [...new Set([...previous.request_ids, request.request_id])],
          occurrences: previous.occurrences + 1,
          last_seen_at: new Date(now()).toISOString(),
        }
      : {
          key,
          provider: request.provider,
          reason: safeReason(finding.reason, "human authorization required"),
          action: finding.action ?? null,
          request_ids: [request.request_id],
          occurrences: 1,
          first_seen_at: new Date(now()).toISOString(),
          last_seen_at: new Date(now()).toISOString(),
        };
    store.putAttention(item);

    const record = recordFor(request, CAPABILITY_STATE.ATTENTION_REQUIRED, now, {
      reason: item.reason,
      attention_key: key,
    });
    store.putRequest(record);
    audit(store, now, request, "attention_required", { attention_key: key, reason: item.reason });
    return record;
  }

  async function inspect(request, adapter) {
    try {
      return await adapter.inspect(request);
    } catch (error) {
      return classifyThrown(error);
    }
  }

  async function ensure(input) {
    const request = normalizeCapabilityRequest(input);
    const adapter = adapterFor(request);
    if (!adapter || typeof adapter.inspect !== "function") {
      return defer(request, `no provider adapter for ${request.provider}`);
    }

    audit(store, now, request, "preflight_started");
    let finding = await inspect(request, adapter);

    if (finding?.kind === "ready") {
      const record = recordFor(request, CAPABILITY_STATE.READY, now, { evidence: finding.evidence ?? null });
      store.putRequest(record);
      audit(store, now, request, "ready");
      return record;
    }

    if (finding?.kind === "attention") return requireAttention(request, finding);
    if (finding?.kind === "deferred") {
      return defer(request, safeReason(finding.reason, "provider temporarily unavailable"), finding.retry_after_ms ?? null);
    }

    if (finding?.kind !== "repairable" || typeof adapter.repair !== "function") {
      return defer(request, safeReason(finding?.reason, "capability is unavailable and not automatically repairable"));
    }

    const repairing = recordFor(request, CAPABILITY_STATE.REPAIRING, now, {
      reason: safeReason(finding.reason, "automatic repair required"),
    });
    store.putRequest(repairing);
    audit(store, now, request, "repair_started", { reason: repairing.reason });

    try {
      await adapter.repair(request, finding);
    } catch (error) {
      const failure = classifyThrown(error);
      if (failure.kind === "attention") return requireAttention(request, failure);
      return defer(request, failure.reason, failure.retry_after_ms);
    }

    finding = await inspect(request, adapter);
    if (finding?.kind === "ready") {
      const record = recordFor(request, CAPABILITY_STATE.READY, now, { evidence: finding.evidence ?? null, repaired: true });
      store.putRequest(record);
      audit(store, now, request, "repair_succeeded");
      return record;
    }
    if (finding?.kind === "attention") return requireAttention(request, finding);
    if (finding?.kind === "deferred") {
      return defer(request, safeReason(finding.reason, "repair completed but provider is unavailable"), finding.retry_after_ms ?? null);
    }
    return defer(request, safeReason(finding?.reason, "automatic repair did not make capability ready"));
  }

  async function retry(requestId) {
    const prior = store.getRequest(requestId);
    if (!prior) throw new Error(`unknown capability request ${requestId}`);
    return ensure(prior.request);
  }

  return {
    ensure,
    retry,
    get: (id) => store.getRequest(id),
    requests: () => store.listRequests(),
    attention: () => store.listAttention(),
    audit: () => store.listAudit(),
    store,
  };
}
