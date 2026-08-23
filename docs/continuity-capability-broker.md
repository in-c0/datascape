# Continuity capability broker — zero-attention infrastructure contract

Issue: #41

## Owner requirement

Manual authentication, secret copying, provider dashboard setup and permission repair may not sit on the critical path of unattended work.

The system is allowed to discover that a privileged provider action cannot execute immediately. It is not allowed to turn that into whole-run paralysis.

## Existing Continuity primitives to reuse

This is not a second operator product. It extends the existing Continuity control plane:

- dependency wakeups and waiting semantics
- operation idempotency / reconciliation
- owner exception queue
- deployed-byte authority boundary
- bounded owner-presence verification
- deterministic scheduling

The owner-presence path remains break-glass / irreducibly-human only. Normal provider operations use durable non-human service identities.

## Capability boundary

Agents request an outcome:

```json
{
  "request_id": "ssmt-subscriber-db-v1",
  "project": "ssmt",
  "capability": "relational_store",
  "provider": "cloudflare",
  "resource": "ssmt-subscribers",
  "idempotency_key": "ssmt:subscriber-db:v1",
  "params": { "binding": "SUBSCRIBERS_DB" }
}
```

They do **not** supply API keys, refresh tokens, passwords, private keys or other credential material. Provider adapters retrieve and use credentials behind the privileged boundary.

## State model

Every requested privileged capability is in exactly one of four operational states:

- `READY` — execute the dependent operation.
- `REPAIRING` — the broker can refresh credentials, provision resources or repair bindings automatically. Repair and retry without owner attention.
- `DEFERRED` — a provider or dependency is temporarily unavailable. Persist the operation, apply retry/backoff, and continue unrelated work.
- `ATTENTION_REQUIRED` — the provider requires something irreducibly human, such as root MFA/identity reauthorization, legal acceptance, material spend approval or an irreversible action. Coalesce related requests into one attention item and continue unrelated work.

All four states have run disposition `continue`. A capability problem can block its dependent operation; it does not automatically block the autonomous run.

## Provider adapter contract

A provider adapter supplies:

```js
await adapter.inspect(request)
await adapter.repair(request, finding)
```

`inspect()` returns one of:

```js
{ kind: "ready", evidence }
{ kind: "repairable", reason, repair }
{ kind: "deferred", reason, retry_after_ms }
{ kind: "attention", reason, attention_key, action }
```

Examples of `repairable`:

- expired short-lived access token -> refresh/mint replacement
- missing D1/R2/KV resource -> create it
- missing binding -> bind it
- unapplied migration -> apply it
- missing generated project secret -> generate + install it

Examples of `attention`:

- root provider service identity revoked and provider mandates human MFA
- legal terms require a human to accept
- operation crosses an owner-defined spend threshold
- destructive/irreversible action requires explicit owner ruling

## Attention coalescing

One underlying root problem must create one owner item.

If Cloudflare root authorization is revoked while 17 projects are waiting on 43 operations, the owner should see one item such as:

> Reauthorize Cloudflare operator identity — 43 deferred operations across 17 projects will resume automatically.

Not 43 prompts.

After the owner completes that one action, the dependency system wakes the queued operations and the broker retries them.

## Credential health

Scheduled/autonomous work should preflight provider capabilities before expensive work reaches a privileged edge.

The long-term provider adapter should maintain a health record for each service identity:

- last successful provider call
- token/lease expiry if knowable
- required scopes / permissions
- refresh capability
- last repair
- last failure class

Repair should happen ahead of expiry where possible.

## SSMT first production acceptance test

Input requirement only:

> `SSMT needs real newsletter subscribers.`

The complete machine path should be:

1. resolve `relational_store` to the standard Cloudflare stack;
2. inspect Cloudflare service identity;
3. refresh it automatically if required;
4. inspect whether `ssmt-subscribers` exists;
5. create it if absent;
6. apply the subscriber migration;
7. bind it to the existing SSMT Pages/Functions runtime as `SUBSCRIBERS_DB`;
8. deploy SSMT subscriber capture;
9. submit a production signup;
10. verify the row through the provider API;
11. remove/mark the synthetic verification row;
12. emit audit evidence;
13. require zero Cloudflare dashboard interaction.

If root Cloudflare authorization is genuinely absent, steps 4–12 become deferred while unrelated SSMT work continues. Exactly one attention item is created. Once authorization is restored, the queued path resumes automatically.

## V0 scope

The first PR establishes and tests the provider-independent state machine only. It deliberately does **not** pretend credentials or Cloudflare provisioning exist yet.

Next implementation slice:

1. persistent file-backed queue/store on the live host;
2. Cloudflare adapter using the persistent machine credential already present on the trusted host where possible;
3. capability health preflight;
4. dependency wakeup integration;
5. SSMT production acceptance test.

## Definition of success

The owner leaves autonomous work running overnight and does not return to find that useful work stopped hours earlier because a secret, token, binding, API permission or provider setup screen needed attention.
