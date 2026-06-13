/**
 * Model Cost Selector Extension
 *
 * An independent pi extension that registers a `/modelcost` slash command.
 * Opens a TUI selector that lists every model currently registered in the
 * model registry, alongside its input/output price (per million tokens) and
 * context window, with a fuzzy search filter.
 *
 * Usage:
 *   pi -e ./modelcost.ts
 *   # or install into ~/.pi/agent/extensions/ or .pi/extensions/
 *
 * Works with any provider registered in the model registry — has no
 * dependency on the tokenrouter provider.
 */

import { DynamicBorder, keyHint, type ExtensionAPI, type Theme } from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";
import { Container, Input, Text, Spacer, fuzzyFilter, getKeybindings, type Component, type TUI } from "@mariozechner/pi-tui";

function formatPrice(perMillion: number): string {
  if (perMillion === 0) return "free";
  if (perMillion < 0.01) return `$${perMillion.toFixed(4)}`;
  if (perMillion < 1) return `$${perMillion.toFixed(3)}`;
  if (perMillion < 100) return `$${perMillion.toFixed(2)}`;
  return `$${perMillion.toFixed(0)}`;
}

function formatContextWindow(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return `${n}`;
}

interface ModelCostSelectorOptions {
  tui: TUI;
  theme: Theme;
  models: Model<any>[];
  currentModel: Model<any> | undefined;
  initialSearch?: string;
  onSelect: (m: Model<any>) => void;
  onCancel: () => void;
}

class ModelCostSelector extends Container {
  readonly searchInput: Input;
  private listContainer: Container;
  private allModels: Model<any>[];
  private filteredModels: Model<any>[];
  private selectedIndex = 0;
  private currentModel: Model<any> | undefined;
  private theme: Theme;
  private tui: TUI;
  private onSelectCb: (m: Model<any>) => void;
  private onCancelCb: () => void;

  constructor(opts: ModelCostSelectorOptions) {
    super();
    this.tui = opts.tui;
    this.theme = opts.theme;
    this.allModels = opts.models;
    this.currentModel = opts.currentModel;
    this.onSelectCb = opts.onSelect;
    this.onCancelCb = opts.onCancel;

    this.addChild(new DynamicBorder((s) => opts.theme.fg("border", s)));
    this.addChild(
      new Text(opts.theme.fg("accent", opts.theme.bold("Select Model by Cost")), 1, 0),
    );
    this.addChild(new Spacer(1));
    this.addChild(new Text(opts.theme.fg("muted", "Filter:"), 1, 0));
    this.searchInput = new Input();
    if (opts.initialSearch) {
      this.searchInput.setValue(opts.initialSearch);
    }
    this.searchInput.onSubmit = () => {
      if (this.filteredModels[this.selectedIndex]) {
        this.onSelectCb(this.filteredModels[this.selectedIndex]);
      }
    };
    this.searchInput.onEscape = () => this.onCancelCb();
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));

    this.listContainer = new Container();
    this.addChild(this.listContainer);
    this.addChild(new Spacer(1));

    const hintLine =
      keyHint("tui.select.up", "up") +
      " " +
      opts.theme.fg("muted", "·") +
      " " +
      keyHint("tui.select.down", "down") +
      " " +
      opts.theme.fg("muted", "·") +
      " " +
      keyHint("tui.select.confirm", "select") +
      " " +
      opts.theme.fg("muted", "·") +
      " " +
      keyHint("tui.select.cancel", "cancel");
    this.addChild(new Text(hintLine, 0, 0));
    this.addChild(new Spacer(1));

    this.addChild(new DynamicBorder((s) => opts.theme.fg("border", s)));

    this.filteredModels = this.allModels;
    this.filterModels(this.searchInput.getValue());
    this.tui.requestRender();
  }

  private isCurrent(m: Model<any>): boolean {
    return (
      this.currentModel !== undefined &&
      this.currentModel.provider === m.provider &&
      this.currentModel.id === m.id
    );
  }

  private filterModels(query: string): void {
    this.filteredModels = query
      ? fuzzyFilter(this.allModels, query, (m) => `${m.id} ${m.name} ${m.provider}`)
      : this.allModels;
    this.selectedIndex = 0;
    this.updateList();
  }

  private updateList(): void {
    this.listContainer.clear();
    const maxVisible = 10;
    const total = this.filteredModels.length;
    const startIndex = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(maxVisible / 2),
        total - maxVisible,
      ),
    );
    const endIndex = Math.min(startIndex + maxVisible, total);

    for (let i = startIndex; i < endIndex; i++) {
      const m = this.filteredModels[i];
      if (!m) continue;
      const isSelected = i === this.selectedIndex;
      const isCurrent = this.isCurrent(m);
      const arrow = isSelected ? this.theme.fg("accent", "→ ") : "  ";
      const name = isSelected
        ? this.theme.fg("accent", m.name)
        : m.name;
      const provider = this.theme.fg("muted", `[${m.provider}]`);
      const inputPrice = this.theme.fg(
        "text",
        `${formatPrice(m.cost.input)} in`,
      );
      const outputPrice = this.theme.fg(
        "text",
        `${formatPrice(m.cost.output)} out`,
      );
      const ctx = this.theme.fg(
        "dim",
        `${formatContextWindow(m.contextWindow)} ctx`,
      );
      const checkmark = isCurrent ? this.theme.fg("success", " ✓") : "";
      const line = `${arrow}${name} ${provider}   ${inputPrice}  ${outputPrice}  ${ctx}${checkmark}`;
      this.listContainer.addChild(new Text(line, 0, 0));
    }

    if (total > 0 && (startIndex > 0 || endIndex < total)) {
      this.listContainer.addChild(
        new Text(
          this.theme.fg("muted", `  (${this.selectedIndex + 1}/${total})`),
          0,
          0,
        ),
      );
    }

    if (total === 0) {
      this.listContainer.addChild(
        new Text(this.theme.fg("muted", "  No matching models"), 0, 0),
      );
    } else {
      const selected = this.filteredModels[this.selectedIndex];
      if (selected) {
        this.listContainer.addChild(new Spacer(1));
        const cacheParts: string[] = [];
        if (selected.cost.cacheRead) {
          cacheParts.push(
            `cache read ${formatPrice(selected.cost.cacheRead)}`,
          );
        }
        if (selected.cost.cacheWrite) {
          cacheParts.push(
            `cache write ${formatPrice(selected.cost.cacheWrite)}`,
          );
        }
        const detail = `${selected.name} (${selected.provider})${
          cacheParts.length > 0 ? ` — ${cacheParts.join(", ")}` : ""
        }`;
        this.listContainer.addChild(
          new Text(this.theme.fg("muted", `  ${detail}`), 0, 0),
        );
      }
    }
    this.tui.requestRender();
  }

  handleInput(keyData: string): void {
    const kb = getKeybindings();
    if (kb.matches(keyData, "tui.select.up")) {
      if (this.filteredModels.length === 0) return;
      this.selectedIndex =
        this.selectedIndex === 0
          ? this.filteredModels.length - 1
          : this.selectedIndex - 1;
      this.updateList();
      return;
    }
    if (kb.matches(keyData, "tui.select.down")) {
      if (this.filteredModels.length === 0) return;
      this.selectedIndex =
        this.selectedIndex === this.filteredModels.length - 1
          ? 0
          : this.selectedIndex + 1;
      this.updateList();
      return;
    }
    if (kb.matches(keyData, "tui.select.confirm")) {
      const selected = this.filteredModels[this.selectedIndex];
      if (selected) this.onSelectCb(selected);
      return;
    }
    if (kb.matches(keyData, "tui.select.cancel")) {
      this.onCancelCb();
      return;
    }
    this.searchInput.handleInput(keyData);
    this.filterModels(this.searchInput.getValue());
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("modelcost", {
    description: "Select model with input/output token cost ($/M)",
    handler: async (args, ctx) => {
      const allModels = ctx.modelRegistry.getAvailable();
      if (allModels.length === 0) {
        ctx.ui.notify("No models available", "warning");
        return;
      }
      const searchTerm = args.trim();
      // Direct match: try provider/id or unique bare id
      let directMatch: Model<any> | undefined;
      const slashIdx = searchTerm.indexOf("/");
      if (slashIdx > 0) {
        const provider = searchTerm.substring(0, slashIdx);
        const id = searchTerm.substring(slashIdx + 1);
        directMatch = ctx.modelRegistry.find(provider, id);
      }
      if (!directMatch && searchTerm) {
        const lower = searchTerm.toLowerCase();
        const idMatches = allModels.filter(
          (m) => m.id.toLowerCase() === lower,
        );
        directMatch = idMatches.length === 1 ? idMatches[0] : undefined;
      }
      if (directMatch) {
        const ok = await pi.setModel(directMatch);
        if (ok) ctx.ui.notify(`Model: ${directMatch.id}`, "info");
        return;
      }
      // We use setWidget + onTerminalInput (rather than ctx.ui.custom) so the
      // selector renders in the "belowEditor" slot — between the input box and
      // the footer — instead of as a centered overlay modal.
      const WIDGET_KEY = "modelcost-selector";
      const selected = await new Promise<Model<any> | null>((resolve) => {
        let selector: ModelCostSelector | undefined;
        let unsubscribe: (() => void) | undefined;
        let resolved = false;

        const finish = (result: Model<any> | null) => {
          if (resolved) return;
          resolved = true;
          if (selector) selector.searchInput.focused = false;
          if (unsubscribe) unsubscribe();
          ctx.ui.setWidget(WIDGET_KEY, undefined);
          resolve(result);
        };

        ctx.ui.setWidget(
          WIDGET_KEY,
          (tui, theme): Component => {
            selector = new ModelCostSelector({
              tui,
              theme,
              models: allModels,
              currentModel: ctx.model,
              initialSearch: searchTerm || undefined,
              onSelect: (m) => finish(m),
              onCancel: () => finish(null),
            });
            // TUI focus isn't routed to below-editor widgets, so set the
            // search-input focus flag directly to make the cursor visible.
            selector.searchInput.focused = true;
            return selector;
          },
          { placement: "belowEditor" },
        );

        // Forward all terminal input to the selector and consume it so the
        // editor doesn't receive keystrokes while the selector is open.
        unsubscribe = ctx.ui.onTerminalInput((data) => {
          if (selector) selector.handleInput(data);
          return { consume: true };
        });
      });
      if (selected) {
        const ok = await pi.setModel(selected);
        if (ok) ctx.ui.notify(`Model: ${selected.id}`, "info");
      }
    },
  });
}
