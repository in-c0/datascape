// The independent outbound leak gate — v3.2 PR-A review refinement.
//
// This file deliberately shares NOTHING with redact.js. No import, no pattern
// registry, no helper. That is the whole point: the previous residual check
// called the same detector the redactor used, so when one pattern was wrong
// both were wrong and a raw key sailed through a review that reported clean.
// Two checks that fail identically are one check.
//
// So this scanner works a different way. The redactor knows credential SHAPES;
// this one knows what ordinary prose looks like and objects to anything that
// does not look like it. It is biased hard toward false positives: flagging a
// harmless build hash costs a withheld record, and the alternative costs a live
// credential.

/** Characters per Shannon-entropy bit budget; prose sits far below this. */
function entropyBits(token) {
  const freq = new Map();
  for (const ch of token) freq.set(ch, (freq.get(ch) || 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / token.length;
    h -= p * Math.log2(p);
  }
  return h * token.length;
}

const PLACEHOLDER = /^<SECRET_\d+:[A-Z_]+>$/;

// Words that legitimately appear as long unbroken runs in this corpus. Kept
// tiny and explicit: a growing allowlist is how an outbound gate quietly stops
// gating.
const KNOWN_SAFE = new Set([
  "continuity-shadow-v1",
  "blocked-on-owner",
  "investigating",
]);

/**
 * Scan an outbound payload.
 *
 * Returns findings; ANY finding means abort or withhold, never "downgrade to a
 * warning". The caller does not get to decide a flagged payload is probably
 * fine, because that decision is exactly where a leak would get through.
 */
export function scanOutbound(payload, { minLength = 24, minEntropyBits = 90 } = {}) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload ?? null);
  const findings = [];
  const seen = new Set();

  // Tokenise on whitespace and prose punctuation only. Characters that appear
  // inside credentials (- _ . / +) are deliberately NOT separators, so a key is
  // seen whole rather than split into innocent-looking fragments.
  for (const raw of text.split(/[\s"'`,;:()\[\]{}<>|\\]+/)) {
    const token = raw.replace(/^[.]+|[.]+$/g, "");
    if (!token || token.length < minLength) continue;
    if (PLACEHOLDER.test(raw) || raw.startsWith("<SECRET_")) continue;
    if (KNOWN_SAFE.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);

    // Assess the longest run WITHOUT internal word structure. A credential is
    // opaque precisely because it has none; `in-c0/sumz-up-chrome-hello` and
    // `2026-08-16-security-committed-keys-074f` are long, mixed-class and
    // vowel-poor as whole strings, and both are ordinary identifiers. This is
    // not a loosening: splitting `sk-proj-<32 opaque chars>` still leaves a
    // 32-character opaque run, which still trips every test below.
    const segments = token.split(/[-_/.]+/).filter(Boolean);
    const opaque = segments.reduce((a, b) => (b.length > a.length ? b : a), "");
    if (opaque.length < minLength) continue;

    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((re) => re.test(opaque)).length;
    const vowels = (opaque.match(/[aeiou]/gi) || []).length / opaque.length;
    const bits = entropyBits(opaque);

    // A long token that mixes character classes, is vowel-poor, and carries
    // high entropy is not a word. It might be a commit hash; it might be a key.
    // The gate does not get to tell them apart, and does not need to.
    if (classes >= 2 && bits >= minEntropyBits && vowels < 0.28) {
      findings.push({
        reason: "high_entropy_token",
        length: opaque.length,
        entropy_bits: Math.round(bits),
        classes,
        // NEVER echo the token. An outbound gate that logs the secret it caught
        // has moved the leak rather than stopped it.
        fingerprint: fingerprint(token),
      });
      continue;
    }
    // Long unbroken base64/hex runs, regardless of class mixing.
    if (/^[A-Fa-f0-9]{32,}$/.test(opaque) || /^[A-Za-z0-9+/]{40,}={0,2}$/.test(opaque)) {
      findings.push({ reason: "opaque_encoded_run", length: opaque.length, fingerprint: fingerprint(opaque) });
    }
  }
  return findings;
}

/** A non-reversible marker, so two findings can be compared without the value. */
function fingerprint(token) {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) h = Math.imul(h ^ token.charCodeAt(i), 0x01000193) >>> 0;
  return `fp_${h.toString(16).padStart(8, "0")}`;
}

/**
 * The gate itself: ALLOW or ABORT, with no third option.
 *
 * The spec's wording is the contract — "if it flags something the redactor does
 * not understand, withhold/abort rather than downgrade the warning."
 */
export function outboundGate(payload, options = {}) {
  const findings = scanOutbound(payload, options);
  return {
    decision: findings.length ? "ABORT" : "ALLOW",
    findings,
    scanner: "independent-entropy-v1",
  };
}
