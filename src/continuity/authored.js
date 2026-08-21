// Presentation-only Markdown parser for authored text.
//
// Governing lane, visual review R2, ruling 2. The problem is narrow: authored
// records contain `**bold**` and backticks, and rendering those delimiters as
// literal characters is visual noise. Removing them is a PRESENTATION change —
// the visible words stay semantically identical; only the syntax disappears.
//
// This module is deliberately a PARSER, not a component. Every safety rule the
// ruling lists is a property of the tree it returns, so each one is unit
// testable without a DOM:
//
//   - no HTML node type exists, so raw HTML can only ever be text;
//   - a link node is only produced for http(s), so no other scheme can reach
//     an href;
//   - there is no image or media node type at all;
//   - a task-list marker stays inside the item's text, so it cannot become an
//     interactive checkbox;
//   - headings carry no level, so authored H1 cannot become page typography.
//
// Refusing by having no representation beats refusing with a filter: there is
// nothing to get subtly wrong later.

const LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/;
const CODE = /`([^`\n]+)`/;
const STRONG = /(\*\*|__)(?=\S)([\s\S]*?\S)\1/;
const EM = /(^|[^*_\w])([*_])(?=\S)([^*_]*?\S)\2/;

const text = (value) => ({ type: "text", value });

/**
 * Inline pass. Code is matched first so `**` inside a code span stays literal
 * content rather than becoming emphasis.
 */
export function parseInline(source) {
  const out = [];
  let rest = String(source ?? "");

  while (rest) {
    const code = rest.match(CODE);
    const link = rest.match(LINK);
    const strong = rest.match(STRONG);
    const em = rest.match(EM);

    const candidates = [
      code && { at: code.index, len: code[0].length, node: { type: "code", value: code[1] } },
      link && { at: link.index, len: link[0].length, node: { type: "link", href: link[2], children: [text(link[1])] } },
      strong && { at: strong.index, len: strong[0].length, node: { type: "strong", children: parseInline(strong[2]) } },
      em && {
        // EM captures a leading boundary character that is not part of the match.
        at: em.index + em[1].length,
        len: em[0].length - em[1].length,
        node: { type: "em", children: parseInline(em[3]) },
      },
    ].filter(Boolean);

    if (!candidates.length) {
      out.push(text(rest));
      break;
    }

    const first = candidates.reduce((a, b) => (a.at <= b.at ? a : b));
    if (first.at > 0) out.push(text(rest.slice(0, first.at)));
    out.push(first.node);
    rest = rest.slice(first.at + first.len);
  }

  return out.filter((n) => n.type !== "text" || n.value !== "");
}

const isFence = (line) => /^\s*```/.test(line);
const isHeading = (line) => /^\s{0,3}#{1,6}\s+/.test(line);
const isQuote = (line) => /^\s{0,3}>\s?/.test(line);
const isUl = (line) => /^\s{0,3}[-*+]\s+/.test(line);
const isOl = (line) => /^\s{0,3}\d{1,3}[.)]\s+/.test(line);

/** Block pass. Deliberately small — this is a reader, not a CMS. */
export function parseAuthored(source) {
  const lines = String(source ?? "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i += 1; continue; }

    if (isFence(line)) {
      const body = [];
      i += 1;
      while (i < lines.length && !isFence(lines[i])) { body.push(lines[i]); i += 1; }
      i += 1;
      out.push({ type: "code_block", value: body.join("\n") });
      continue;
    }

    if (isHeading(line)) {
      // No level is carried: every authored heading renders as one restrained
      // in-card heading, so an authored `#` cannot produce page typography.
      out.push({ type: "heading", children: parseInline(line.replace(/^\s{0,3}#{1,6}\s+/, "")) });
      i += 1;
      continue;
    }

    if (isQuote(line)) {
      const body = [];
      while (i < lines.length && isQuote(lines[i])) { body.push(lines[i].replace(/^\s{0,3}>\s?/, "")); i += 1; }
      out.push({ type: "quote", children: parseInline(body.join(" ")) });
      continue;
    }

    if (isUl(line) || isOl(line)) {
      const ordered = isOl(line);
      const items = [];
      while (i < lines.length && (ordered ? isOl(lines[i]) : isUl(lines[i]))) {
        // A task-list marker stays inside the item text: inert authored content,
        // never a checkbox and never readable as an execution plan.
        const body = lines[i].replace(ordered ? /^\s{0,3}\d{1,3}[.)]\s+/ : /^\s{0,3}[-*+]\s+/, "");
        items.push(parseInline(body));
        i += 1;
      }
      out.push({ type: ordered ? "ol" : "ul", items });
      continue;
    }

    const para = [];
    while (
      i < lines.length && lines[i].trim() &&
      !isFence(lines[i]) && !isHeading(lines[i]) && !isQuote(lines[i]) && !isUl(lines[i]) && !isOl(lines[i])
    ) {
      para.push(lines[i]);
      i += 1;
    }
    out.push({ type: "p", children: parseInline(para.join("\n")) });
  }

  return out;
}

/** The words a reader will see — used by tests to assert authored fidelity. */
export function visibleText(nodes) {
  const walk = (list) => list.map((n) => {
    if (n.type === "text") return n.value;
    if (n.type === "code" || n.type === "code_block") return n.value;
    if (n.type === "ul" || n.type === "ol") return n.items.map(walk).join(" ");
    return n.children ? walk(n.children) : "";
  }).join("");
  return walk(nodes);
}

// ---------------------------------------------------------------------------
// Fragment-safe excerpting (governing lane, visual review R3)
//
// The first implementation sliced the RAW Markdown and parsed the slice, which
// could cut through an inline span and leave a stranded `**` in the rendered
// prose — manufacturing exactly the delimiter noise the presentation pass
// existed to remove.
//
// The invariant:
//
//   Semantic truncation may shorten authored content, but it may never
//   manufacture malformed Markdown presentation.
//
// So the order is parse → truncate the TREE → render, never slice → parse.
//
// Cutting inside a `text` node is safe: text carries no delimiters. Every other
// inline node (strong, em, code, link) is all-or-nothing — include it whole or
// stop before it. That is what guarantees balanced presentation without ever
// regex-stripping a delimiter, which would corrupt valid authored syntax.
// ---------------------------------------------------------------------------

const visibleLength = (nodes) => nodes.reduce((sum, n) => {
  if (n.type === "text" || n.type === "code") return sum + String(n.value).length;
  if (n.children) return sum + visibleLength(n.children);
  return sum;
}, 0);

/** Cut a run of inline nodes at a word boundary, never inside a styled span. */
function truncateInline(nodes, budget) {
  const out = [];
  let used = 0;
  let truncated = false;

  for (const node of nodes) {
    const remaining = budget - used;
    if (remaining <= 0) { truncated = true; break; }

    if (node.type === "text") {
      if (node.value.length <= remaining) {
        out.push(node);
        used += node.value.length;
        continue;
      }
      // Text is safe to cut. Prefer a sentence, then a word boundary, so the
      // excerpt reads as prose rather than as a truncation artefact.
      const window_ = node.value.slice(0, remaining);
      const sentence = window_.lastIndexOf(". ");
      const word = window_.lastIndexOf(" ");
      const cut = sentence > remaining * 0.5 ? sentence + 1 : (word > 0 ? word : remaining);
      const value = node.value.slice(0, cut).trimEnd();
      if (value) out.push({ type: "text", value });
      truncated = true;
      break;
    }

    // Styled spans are indivisible: taking half of one is what produced the
    // stranded delimiter.
    const len = visibleLength([node]);
    if (len <= remaining) {
      out.push(node);
      used += len;
    } else {
      truncated = true;
      break;
    }
  }

  return { nodes: out, truncated };
}

/**
 * A bounded excerpt of an authored record, as a parsed tree.
 *
 * Returns whole blocks until the budget is reached; the last block may be
 * shortened at a safe boundary. Never returns a partial styled span.
 */
export function excerptAuthored(source, budget = 320) {
  const blocks = parseAuthored(source);
  const out = [];
  let used = 0;
  let truncated = false;

  for (const block of blocks) {
    const remaining = budget - used;
    if (remaining <= 0) { truncated = true; break; }

    if (block.type === "code_block") {
      // A fenced block is all-or-nothing: a half-open fence is malformed.
      const len = block.value.length;
      if (len <= remaining) { out.push(block); used += len; continue; }
      truncated = true;
      break;
    }

    if (block.type === "ul" || block.type === "ol") {
      const items = [];
      for (const item of block.items) {
        const left = budget - used;
        if (left <= 0) { truncated = true; break; }
        const len = visibleLength(item);
        if (len <= left) { items.push(item); used += len; }
        else { truncated = true; break; }
      }
      if (items.length) out.push({ ...block, items });
      if (truncated) break;
      continue;
    }

    const children = block.children || [];
    const len = visibleLength(children);
    if (len <= remaining) {
      out.push(block);
      used += len;
      continue;
    }
    const cut = truncateInline(children, remaining);
    if (cut.nodes.length) out.push({ ...block, children: cut.nodes });
    truncated = true;
    break;
  }

  return { blocks: out, truncated: truncated || out.length < blocks.length };
}
