import { Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { ActionCategory } from "../../shortcuts/action-types.js";
import type { CommandPaletteItem } from "./command-palette.js";
import {
  filterCommandPaletteItems,
  formatDesktopBinding,
  movePaletteSelection,
} from "./command-palette.js";

const CATEGORY_LABELS: Record<ActionCategory, string> = {
  chat: "会话",
  composer: "输入",
  session: "设置",
  turn: "运行",
  skill: "能力",
  output: "输出",
  settings: "个性化",
  app: "应用",
};

export function CommandPalette(props: {
  items: readonly CommandPaletteItem[];
  onClose: () => void;
  onRun: (actionId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const filtered = useMemo(
    () => filterCommandPaletteItems(props.items, query),
    [props.items, query],
  );

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => setSelectedIndex(filtered.length === 0 ? -1 : 0), [query, filtered.length]);

  function runSelected() {
    const selected = filtered[selectedIndex];
    if (selected?.enabled) props.onRun(selected.action.id);
  }

  return (
    <div className="command-palette-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) props.onClose();
    }}>
      <section className="command-palette" role="dialog" aria-modal="true" aria-label="命令面板">
        <header>
          <Search />
          <input
            ref={inputRef}
            value={query}
            aria-label="搜索命令、快捷键或 Skill"
            placeholder="搜索命令、快捷键或 Skill"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                props.onClose();
              } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setSelectedIndex((current) => movePaletteSelection(
                  current,
                  event.key === "ArrowDown" ? 1 : -1,
                  filtered.length,
                ));
              } else if (event.key === "Enter") {
                event.preventDefault();
                runSelected();
              }
            }}
          />
          <kbd>Esc</kbd>
          <button type="button" aria-label="关闭命令面板" onClick={props.onClose}><X /></button>
        </header>
        <div className="command-palette-results" role="listbox" aria-label="可用命令">
          {filtered.map((item, index) => (
            <button
              key={item.action.id}
              type="button"
              role="option"
              aria-selected={index === selectedIndex}
              disabled={!item.enabled}
              onMouseEnter={() => setSelectedIndex(index)}
              onClick={() => props.onRun(item.action.id)}
            >
              <span>
                <small>{CATEGORY_LABELS[item.action.category]}</small>
                <strong>{item.action.label}</strong>
                <em>{item.enabled ? item.action.description : item.disabledReason}</em>
              </span>
              <span className="command-palette-shortcuts">
                {item.action.defaultBindings?.map((binding) => <kbd key={binding}>{formatDesktopBinding(binding)}</kbd>)}
                {item.action.slashCommand !== undefined && <kbd>{item.action.slashCommand}</kbd>}
              </span>
            </button>
          ))}
          {filtered.length === 0 && <p>没有匹配的命令</p>}
        </div>
      </section>
    </div>
  );
}
