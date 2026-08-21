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
