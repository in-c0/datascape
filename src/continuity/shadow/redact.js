// The secret boundary — spec v3.2 §2.
//
// The Security branch is the one corpus most likely to contain live
// credentials, and it is the first corpus we would send to an external model.
// So redaction is not a filter applied to output; it is a wall the raw text
// never crosses. Everything downstream of `redactCorpus` is already redacted,
// and the detector runs a second time over every artifact before it is written.
//
// The same secret gets the same placeholder within one snapshot, so a model can
// still reason that "the key in record A is the key in record B" without ever
// seeing either.

/**
 * Credential shapes, most specific first.
 *
 * Deliberately conservative in one direction only: a false positive costs a
 * redacted string, a false negative costs a leaked key. Where a pattern is
 * broad, it is still preferred over letting the value through.
 */
const PATTERNS = [
  { type: "OPENAI_API_KEY", re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { type: "ANTHROPIC_API_KEY", re: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  // Length is a range, not a constant: a detector matching only the exact
  // canonical length silently passes anything slightly off, and a missed key
  // costs incomparably more than an over-redacted string.
  { type: "GOOGLE_API_KEY", re: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { type: "GITHUB_TOKEN", re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g },
  { type: "AWS_ACCESS_KEY_ID", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { type: "SLACK_TOKEN", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { type: "PRIVATE_KEY_BLOCK", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { type: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { type: "BEARER_TOKEN", re: /\b[Bb]earer\s+[A-Za-z0-9._-]{20,}/g },
  // A long opaque hex/base64ish run assigned to something key-shaped.
  {
    type: "UNKNOWN_TOKEN",
    re: /\b(?:api[_-]?key|secret|token|password|passwd|credential)\b["'\s:=]+([A-Za-z0-9/+_-]{20,})/gi,
    group: 1,
  },
  // Last resort, by SHAPE rather than by prefix. The named patterns above
  // failed open once during development: a Google key two characters off the
  // canonical length passed both the redactor AND the residual detector,
  // because they share the same pattern list. A shape-based backstop is what
  // makes "belt and braces" more than one belt worn twice. English prose does
  // not produce 28-character mixed-case-and-digit runs.
  {
    type: "HIGH_ENTROPY_TOKEN",
    re: /\b(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{28,}\b/g,
  },
];

/** A stable placeholder table for one snapshot. */
export function createRedactor() {
  const assigned = new Map();   // raw value -> placeholder
  const order = [];

  const placeholderFor = (value, type) => {
    if (assigned.has(value)) return assigned.get(value);
    const n = String(order.length + 1).padStart(2, "0");
    const token = `<SECRET_${n}:${type}>`;
    assigned.set(value, token);
    order.push({ token, type, length: value.length });
    return token;
  };

  return {
    /** Replace every detected credential, keeping the surrounding statement. */
    redact(text) {
      if (typeof text !== "string" || !text) return { text: text ?? "", hits: [] };
      let out = text;
      const hits = [];
      for (const { type, re, group } of PATTERNS) {
        out = out.replace(new RegExp(re.source, re.flags), (match, captured) => {
          const value = group ? captured : match;
          if (!value) return match;
          const token = placeholderFor(value, type);
          hits.push({ type, token });
          // Keep the assignment's left-hand side so "api_key: <SECRET_01:…>"
          // still reads as a statement about a key.
          return group ? match.replace(value, token) : token;
        });
      }
      return { text: out, hits };
    },
    /** Anything still matching after redaction is a leak, not a warning. */
    detect(text) {
      if (typeof text !== "string" || !text) return [];
      const found = [];
      for (const { type, re, group } of PATTERNS) {
        const rx = new RegExp(re.source, re.flags);
        let m;
        while ((m = rx.exec(text)) !== null) {
          const value = group ? m[group] : m[0];
          if (value && !/^<SECRET_\d+:/.test(value)) found.push({ type, value });
        }
      }
      return found;
    },
    table() {
      return order.map(({ token, type, length }) => ({ token, type, length }));
    },
  };
}

/**
 * Redact a whole corpus.
 *
 * A record the detector cannot confidently protect is WITHHELD from the
 * external payload rather than sent with a best effort. Its id stays
 * structurally visible so the topology is still honest about what exists.
 */
export function redactCorpus(records, { redactor = createRedactor() } = {}) {
  const redacted = [];
  const withheld = [];
  for (const record of records) {
    const { text, hits } = redactor.redact(record.text || "");
    const residual = redactor.detect(text);
    if (residual.length) {
      withheld.push({ id: record.id, reason: "withheld_sensitive_source", residual: residual.map((r) => r.type) });
      continue;
    }
    redacted.push({ ...record, text, label: text, redactions: hits.map((h) => h.token) });
  }
  return { redacted, withheld, secretTable: redactor.table() };
}

/**
 * The gate every generated artifact passes before it is written to disk.
 * Returns the offending findings; an empty array is the only acceptable result.
 */
export function scanArtifact(value, { redactor = createRedactor() } = {}) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return redactor.detect(text);
}
