/** @jsxImportSource react */
// Paseo's HistoryMarkdown (client/history-markdown.tsx) on the DOM. Tokens become elements, never HTML.
import { useMemo, type CSSProperties, type ReactNode } from "react";
import { Lexer, type Token, type Tokens } from "../../paseo/client/vendor/marked/marked";

function openLink(href: string) {
  void orca.shell?.openExternal(href).catch(() => undefined);
}

function inline(tokens: Token[]): ReactNode[] {
  return tokens.map((token, i) => {
    const children = (): ReactNode => "tokens" in token && token.tokens ? inline(token.tokens) : "text" in token ? token.text : token.raw;
    switch (token.type) {
      case "strong": return <strong key={i} style={{ fontWeight: 700 }}>{children()}</strong>;
      case "em": return <em key={i}>{children()}</em>;
      case "del": return <del key={i}>{children()}</del>;
      case "codespan": return <code key={i}>{token.text}</code>;
      case "link": {
        const href = String(token.href);
        return /^https?:\/\//i.test(href)
          ? <a key={i} className="link" href={href} onClick={event => { event.preventDefault(); openLink(href); }}>{children()}</a>
          : <span key={i}>{children()}</span>;
      }
      case "br": return "\n";
      case "html": return /^<br\s*\/?\s*>$/i.test(token.raw) ? "\n" : token.raw;
      case "image": return token.text;
      case "checkbox": return token.checked ? "☑ " : "☐ ";
      default: return <span key={i}>{children()}</span>;
    }
  });
}

export function Markdown({ source, preview = false, heading = false, muted = false }: {
  source: string; preview?: boolean; heading?: boolean; muted?: boolean;
}) {
  const tokens = useMemo(() => Lexer.lex(source, { gfm: true, breaks: true }), [source]);
  function paragraph(token: Token, i: number, className = "", style?: CSSProperties, title = false) {
    const isHeading = title || token.type === "heading";
    return <p key={i} role={isHeading ? "heading" : undefined} aria-level={isHeading ? 3 : undefined}
      className={["md-p", title && "md-title", preview && "clamp2", className].filter(Boolean).join(" ")} style={style}>
      {"tokens" in token && token.tokens ? inline(token.tokens) : "text" in token ? token.text : token.raw}
    </p>;
  }
  function blocks(all: Token[], topLevel = false): ReactNode[] {
    const visible = all.filter(token => !["space", "def"].includes(token.type));
    return (preview ? visible.slice(0, 1) : visible).map((token, i) => {
      switch (token.type) {
        case "heading": return paragraph(token, i, token.depth <= 2 ? "md-h1" : "md-h3");
        case "hr": return <hr key={i} />;
        case "code": return paragraph(token, i, "md-code");
        case "blockquote": return <div key={i} className="md-quote">{blocks(token.tokens ?? [])}</div>;
        case "list": {
          const list = token as Tokens.List;
          return <div key={i} className="md-list">{(preview ? list.items.slice(0, 1) : list.items).map((item, n) =>
            <div key={n} className="md-item">
              <span className="md-p">{list.ordered ? String(Number(list.start) + n) + "." : "•"}</span>
              <div className="md" style={{ flex: 1 }}>{blocks(item.tokens)}</div>
            </div>)}</div>;
        }
        case "table": {
          const table = token as Tokens.Table;
          const rows = preview ? [table.header] : [table.header, ...table.rows];
          return <div key={i} className="md-table">{rows.map((cells, r) => <div key={r} className="md-tr">
            {cells.map((cell, c) => <span key={c} className="md-p md-td" style={{ textAlign: cell.align ?? "left", fontWeight: cell.header ? 700 : 400 }}>{inline(cell.tokens)}</span>)}
          </div>)}</div>;
        }
        default: return paragraph(token, i, "", undefined, topLevel && heading && i === 0);
      }
    });
  }
  return <div className={muted ? "md md-muted" : "md"}>{blocks(tokens, true)}</div>;
}
