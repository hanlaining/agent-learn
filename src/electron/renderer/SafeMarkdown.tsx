import type { ReactNode } from "react";

import {
  parseSafeInline,
  parseSafeMarkdown,
} from "./runtime-ui.js";

export function SafeMarkdown({ markdown }: { markdown: string }) {
  const blocks = parseSafeMarkdown(markdown);
  return (
    <div className="safe-markdown">
      {blocks.map((block, index) => {
        const key = `${block.kind}-${index}`;
        if (block.kind === "heading") {
          const content = renderInline(block.text);
          if (block.level === 1) return <h1 key={key}>{content}</h1>;
          if (block.level === 2) return <h2 key={key}>{content}</h2>;
          return <h3 key={key}>{content}</h3>;
        }
        if (block.kind === "blockquote") {
          return <blockquote key={key}>{renderInline(block.text)}</blockquote>;
        }
        if (block.kind === "unordered_list" || block.kind === "ordered_list") {
          const Tag = block.kind === "unordered_list" ? "ul" : "ol";
          return (
            <Tag key={key}>
              {block.items.map((item, itemIndex) => (
                <li key={`${key}-${itemIndex}`}>{renderInline(item)}</li>
              ))}
            </Tag>
          );
        }
        if (block.kind === "code") {
          return (
            <pre key={key} data-language={block.language}>
              <code>{block.text}</code>
            </pre>
          );
        }
        if (block.kind === "divider") return <hr key={key} />;
        return <p key={key}>{renderInline(block.text)}</p>;
      })}
    </div>
  );
}

function renderInline(text: string): ReactNode[] {
  return parseSafeInline(text).map((token, index) => {
    const key = `${token.kind}-${index}`;
    if (token.kind === "strong") return <strong key={key}>{token.text}</strong>;
    if (token.kind === "emphasis") return <em key={key}>{token.text}</em>;
    if (token.kind === "code") return <code key={key}>{token.text}</code>;
    if (token.kind === "link") {
      return token.href === undefined
        ? <span key={key}>{token.text}</span>
        : (
            <a key={key} href={token.href} target="_blank" rel="noreferrer">
              {token.text}
            </a>
          );
    }
    return <span key={key}>{renderLineBreaks(token.text, key)}</span>;
  });
}

function renderLineBreaks(text: string, key: string): ReactNode[] {
  const lines = text.split("\n");
  return lines.flatMap((line, index) => index === 0
    ? [line]
    : [<br key={`${key}-br-${index}`} />, line]);
}
