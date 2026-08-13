import { FileCode2, Sparkles, TerminalSquare } from "lucide-react";
import type { ComposerSuggestion } from "./composer-suggestions.js";

export function ComposerSuggestions(props: {
  items: readonly ComposerSuggestion[];
  selectedIndex: number;
  loading: boolean;
  onSelect(item: ComposerSuggestion): void;
  onHover(index: number): void;
}) {
  return (
    <section className="composer-suggestions" role="listbox" aria-label="输入建议">
      {props.loading && <p>正在搜索工作区…</p>}
      {!props.loading && props.items.length === 0 && <p>没有匹配的安全候选</p>}
      {props.items.map((item, index) => (
        <button
          key={item.id}
          type="button"
          role="option"
          aria-selected={index === props.selectedIndex}
          disabled={item.disabled}
          onMouseEnter={() => props.onHover(index)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => props.onSelect(item)}
        >
          {item.kind === "file" ? <FileCode2 /> : item.kind === "skill" ? <Sparkles /> : <TerminalSquare />}
          <span><strong>{item.label}</strong><small>{item.disabledReason ?? item.description}</small></span>
          <kbd>{item.kind === "slash" ? item.value : item.kind === "file" ? "@ 工作区" : "$ Skill"}</kbd>
        </button>
      ))}
    </section>
  );
}
