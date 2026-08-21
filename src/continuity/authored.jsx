import { parseAuthored } from "./authored.js";

// Renderer for the presentation-Markdown tree (governing lane, ruling 2).
//
// The parser owns every safety rule; this file owns nothing but appearance.
// The one property it must preserve is that text becomes a React text node —
// never dangerouslySetInnerHTML — so raw HTML in an authored record can only
// ever be displayed as characters. That makes "no raw HTML rendering"
// structural rather than a filter someone can later get wrong.

function Inline({ nodes, keyPrefix = "i" }) {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`;
    if (node.type === "text") return <span key={key}>{node.value}</span>;
    if (node.type === "code") return <code key={key}>{node.value}</code>;
    if (node.type === "strong") return <strong key={key}><Inline nodes={node.children} keyPrefix={key} /></strong>;
    if (node.type === "em") return <em key={key}><Inline nodes={node.children} keyPrefix={key} /></em>;
    if (node.type === "link") {
      // The parser only emits http(s); never same-tab, never without safe rel.
      return (
        <a key={key} href={node.href} target="_blank" rel="noreferrer noopener">
          <Inline nodes={node.children} keyPrefix={key} />
        </a>
      );
    }
    return null;
  });
}

function Block({ node, index }) {
  const key = `b-${index}`;
  if (node.type === "code_block") return <pre className="bf-md-pre"><code>{node.value}</code></pre>;
  if (node.type === "heading") return <h4 className="bf-md-h"><Inline nodes={node.children} keyPrefix={key} /></h4>;
  if (node.type === "quote") return <blockquote className="bf-md-quote"><Inline nodes={node.children} keyPrefix={key} /></blockquote>;
  if (node.type === "ul" || node.type === "ol") {
    const items = node.items.map((item, i) => (
      <li key={`${key}-${i}`}><Inline nodes={item} keyPrefix={`${key}-${i}`} /></li>
    ));
    return node.type === "ol" ? <ol className="bf-md-list">{items}</ol> : <ul className="bf-md-list">{items}</ul>;
  }
  return <p className="bf-md-p"><Inline nodes={node.children} keyPrefix={key} /></p>;
}

/**
 * Render authored text as presentation Markdown.
 *
 * On any parse failure it falls back to the exact plain text rather than
 * rendering nothing: the content must never disappear (ruling 2, rule 10).
 */
export default function Authored({ text, nodes, className = "bf-verbatim" }) {
  const source = String(text ?? "");
  // `nodes` is a pre-parsed tree — used by the bounded excerpt, which must
  // truncate the TREE rather than the raw Markdown.
  if (!nodes && !source.trim()) return null;

  let blocks = nodes;
  try {
    if (!blocks) blocks = parseAuthored(source);
  } catch {
    return <p className={className} style={{ whiteSpace: "pre-wrap" }}>{source}</p>;
  }
  if (!blocks || !blocks.length) {
    return <p className={className} style={{ whiteSpace: "pre-wrap" }}>{source}</p>;
  }

  return (
    <div className={`${className} bf-md`}>
      {blocks.map((node, index) => <Block key={`b-${index}`} node={node} index={index} />)}
    </div>
  );
}
