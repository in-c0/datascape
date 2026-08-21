import test from "node:test";
import assert from "node:assert/strict";
import { parseAuthored, parseInline, visibleText } from "../src/continuity/authored.js";

// Ruling 2 (governing lane, visual review R2): presentation-only Markdown.
//
// Every refusal below is paired with a positive control proving the parser is
// not simply inert — a renderer that drops everything would satisfy "no script
// tag rendered" while being useless.

const types = (nodes) => nodes.map((n) => n.type);
const find = (nodes, type) => {
  const out = [];
  const walk = (list) => list.forEach((n) => {
    if (n.type === type) out.push(n);
    if (n.children) walk(n.children);
    if (n.items) n.items.forEach(walk);
  });
  walk(nodes);
  return out;
};

test("delimiters become structure while the words survive intact", () => {
  const tree = parseAuthored("This is **strong** and *soft* and `code`.");
  assert.equal(find(tree, "strong").length, 1);
  assert.equal(find(tree, "em").length, 1);
  assert.equal(find(tree, "code").length, 1);
  assert.equal(visibleText(tree), "This is strong and soft and code.");
});

test("there is no HTML node type, so raw HTML can only be text", () => {
  const tree = parseAuthored("Before <script>alert(1)</script> after <img src=x onerror=y> end");
  const kinds = new Set();
  const walk = (l) => l.forEach((n) => { kinds.add(n.type); if (n.children) walk(n.children); if (n.items) n.items.forEach(walk); });
  walk(tree);
  assert.ok(!kinds.has("html"), "no html node type exists");
  // POSITIVE CONTROL: the markup is preserved as visible characters, not dropped.
  assert.match(visibleText(tree), /<script>alert\(1\)<\/script>/);
  assert.match(visibleText(tree), /Before/);
  assert.match(visibleText(tree), /end/);
});

test("only http and https reach an href", () => {
  const good = parseAuthored("[docs](https://example.test/page)");
  const links = find(good, "link");
  assert.equal(links.length, 1);
  assert.equal(links[0].href, "https://example.test/page");

  for (const bad of [
    "[x](javascript:alert(1))",
    "[x](data:text/html;base64,PHNjcmlwdD4=)",
    "[x](file:///etc/passwd)",
    "[x](vbscript:msgbox)",
    "[x](//evil.example/proto-relative)",
  ]) {
    const tree = parseAuthored(bad);
    assert.equal(find(tree, "link").length, 0, `${bad} must not become a link`);
    // The authored characters remain visible rather than silently vanishing.
    assert.match(visibleText(tree), /x/);
  }
});

test("there is no image or media node type at all", () => {
  const tree = parseAuthored("![alt](https://example.test/a.png)\n\n<iframe src=https://x></iframe>");
  for (const banned of ["image", "img", "iframe", "video", "audio", "svg"]) {
    assert.equal(find(tree, banned).length, 0, `${banned} must have no representation`);
  }
  // The alt text and the literal iframe markup both stay readable.
  assert.match(visibleText(tree), /alt/);
  assert.match(visibleText(tree), /<iframe/);
});

test("task-list syntax stays inert authored text", () => {
  const tree = parseAuthored("- [ ] not a checkbox\n- [x] also not");
  assert.deepEqual(types(tree), ["ul"]);
  assert.equal(find(tree, "checkbox").length, 0);
  assert.equal(find(tree, "link").length, 0, "[x](...) shapes must not sneak through");
  assert.match(visibleText(tree), /\[ \] not a checkbox/);
  assert.match(visibleText(tree), /\[x\] also not/);
});

test("headings carry no level, so authored H1 cannot become page typography", () => {
  const tree = parseAuthored("# Enormous\n\n###### Small");
  assert.deepEqual(types(tree), ["heading", "heading"]);
  for (const node of tree) {
    assert.ok(!("level" in node), "a heading must not carry a level");
  }
  assert.equal(visibleText(tree), "EnormousSmall");
});

test("lists, quotes and fenced code parse as structure", () => {
  assert.deepEqual(types(parseAuthored("- one\n- two")), ["ul"]);
  assert.equal(parseAuthored("- one\n- two")[0].items.length, 2);
  assert.deepEqual(types(parseAuthored("1. one\n2. two")), ["ol"]);
  assert.deepEqual(types(parseAuthored("> quoted")), ["quote"]);
  const fenced = parseAuthored("```\nnpm test\n```");
  assert.deepEqual(types(fenced), ["code_block"]);
  assert.equal(fenced[0].value, "npm test");
});

test("emphasis inside a code span stays literal", () => {
  const nodes = parseInline("`a ** b`");
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].type, "code");
  assert.equal(nodes[0].value, "a ** b");
});

test("a real authored exception body keeps its wording exactly", () => {
  const authored = "Two separate things. **(1) YOURS** — unpin `7u-Hl_K5nqQ` or authorise the path.";
  assert.equal(
    visibleText(parseAuthored(authored)),
    "Two separate things. (1) YOURS — unpin 7u-Hl_K5nqQ or authorise the path.",
  );
});

test("empty and nullish input parse to nothing rather than throwing", () => {
  for (const value of ["", null, undefined, "   "]) {
    assert.deepEqual(parseAuthored(value), []);
  }
});

test("an unterminated fence does not swallow the document silently", () => {
  const tree = parseAuthored("```\nnot closed");
  assert.deepEqual(types(tree), ["code_block"]);
  // Content is preserved even though the author forgot the closing fence.
  assert.match(visibleText(tree), /not closed/);
});

// ---------------------------------------------------------------------------
// Fragment-safe excerpting (visual review R3)
//
// The invariant: truncation may shorten authored content, but it may never
// manufacture malformed Markdown presentation.
// ---------------------------------------------------------------------------

import { excerptAuthored } from "../src/continuity/authored.js";

// The exact fixture the governing lane required.
const R3_FIXTURE =
  "**Evidence shipped.** Its ruling: **accept this compatibility pass**, but do not call it canonical.";

test("R3 fixture: an excerpt never strands a delimiter", () => {
  // Sweep every budget, because the bug only appeared at the cut points that
  // happened to land inside a styled span.
  for (let budget = 5; budget <= R3_FIXTURE.length + 10; budget += 1) {
    const { blocks } = excerptAuthored(R3_FIXTURE, budget);
    const words = visibleText(blocks);
    assert.doesNotMatch(words, /\*\*/, `budget ${budget} stranded a ** in: ${JSON.stringify(words)}`);
    assert.doesNotMatch(words, /^\s*\*|\*\s*$/, `budget ${budget} stranded a * in: ${JSON.stringify(words)}`);
    assert.doesNotMatch(words, /`/, `budget ${budget} stranded a backtick`);
    // Every word shown must be a real prefix of the authored words — nothing
    // invented, nothing reordered.
    assert.ok(
      visibleText(parseAuthored(R3_FIXTURE)).startsWith(words.trimEnd()),
      `budget ${budget} produced text that is not an authored prefix: ${JSON.stringify(words)}`,
    );
  }
});

test("R3 fixture: a styled span is included whole or not at all", () => {
  const full = parseAuthored(R3_FIXTURE);
  const strongs = find(full, "strong").map((n) => visibleText(n.children));
  assert.deepEqual(strongs, ["Evidence shipped.", "accept this compatibility pass"]);

  for (let budget = 5; budget <= R3_FIXTURE.length; budget += 1) {
    const { blocks } = excerptAuthored(R3_FIXTURE, budget);
    for (const node of find(blocks, "strong")) {
      // Any surviving strong must match one of the originals exactly — a
      // partial one is what produced the stranded delimiter.
      assert.ok(strongs.includes(visibleText(node.children)), `budget ${budget} cut a strong span in half`);
    }
  }
});

test("a fenced code block is all-or-nothing", () => {
  const source = "before\n\n```\nnpm run verify:browser\n```";
  // Too small for the block: it must be dropped, never half-opened.
  const tight = excerptAuthored(source, 10);
  assert.equal(find(tight.blocks, "code_block").length, 0);
  assert.equal(tight.truncated, true);
  // Large enough: it appears complete.
  const roomy = excerptAuthored(source, 500);
  assert.equal(find(roomy.blocks, "code_block")[0].value, "npm run verify:browser");
});

test("a link is never half-included", () => {
  const source = "see [the full write-up](https://example.test/a-fairly-long-path) for detail";
  for (let budget = 3; budget <= source.length; budget += 1) {
    const { blocks } = excerptAuthored(source, budget);
    for (const link of find(blocks, "link")) {
      assert.equal(link.href, "https://example.test/a-fairly-long-path");
      assert.equal(visibleText(link.children), "the full write-up");
    }
  }
});

test("an excerpt that fits is not marked truncated", () => {
  const { blocks, truncated } = excerptAuthored("short and complete.", 500);
  assert.equal(truncated, false);
  assert.equal(visibleText(blocks), "short and complete.");
});
