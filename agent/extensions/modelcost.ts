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

import { DynamicBorder, keyHint, getAgentDir, type ExtensionAPI, type Theme } from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";
import { Container, Input, Text, Spacer, fuzzyFilter, getKeybindings, matchesKey, Key, type Component, type TUI } from "@mariozechner/pi-tui";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

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
  scopedKeys?: Set<string>;
  initialSearch?: string;
  onSelect: (m: Model<any>) => void;
  onAddToScope?: (m: Model<any>) => boolean | null;
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
  private selectedProviderIndex = -1;  // -1=All, -2=Free, 0..n=provider
  private providers: string[] = [];
  private providerText: Text;
  private onAddToScopeCb?: (m: Model<any>) => boolean | null;
  private scopedKeys: Set<string>;

  constructor(opts: ModelCostSelectorOptions) {
    super();
    this.tui = opts.tui;
    this.theme = opts.theme;
    this.allModels = opts.models;
    this.currentModel = opts.currentModel;
    this.onSelectCb = opts.onSelect;
    this.onCancelCb = opts.onCancel;
    this.onAddToScopeCb = opts.onAddToScope;
    this.scopedKeys = opts.scopedKeys ?? new Set();

    this.providers = [...new Set(this.allModels.map((m) => m.provider))].sort();

    this.addChild(new DynamicBorder((s) => opts.theme.fg("border", s)));
    this.addChild(
      new Text(opts.theme.fg("accent", opts.theme.bold("Select Model by Cost")), 1, 0),
    );
    this.addChild(new Spacer(1));
    this.providerText = new Text("", 1, 0);
    this.addChild(this.providerText);
    this.addChild(new Spacer(1));
    this.updateProviderBar();
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
      opts.theme.fg("muted", "←→") +
      " " +
      opts.theme.fg("muted", "provider") +
      " " +
      opts.theme.fg("muted", "·") +
      " " +
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
      keyHint("tui.select.cancel", "cancel") +
      " " +
      opts.theme.fg("muted", "·") +
      " " +
      opts.theme.fg("muted", "ctrl+s") +
      " " +
      opts.theme.fg("muted", "scope");
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
    let models = this.allModels;
    if (this.selectedProviderIndex === -2) {
      models = models.filter((m) => m.cost.input === 0 && m.cost.output === 0);
    } else if (this.selectedProviderIndex >= 0 && this.selectedProviderIndex < this.providers.length) {
      const provider = this.providers[this.selectedProviderIndex];
      models = models.filter((m) => m.provider === provider);
    }
    this.filteredModels = query
      ? fuzzyFilter(models, query, (m) => `${m.id} ${m.name} ${m.provider}`)
      : models;
    this.filteredModels = [
      ...this.filteredModels.filter((m) => this.scopedKeys.has(`${m.provider}/${m.id}`)),
      ...this.filteredModels.filter((m) => !this.scopedKeys.has(`${m.provider}/${m.id}`)),
    ];
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
      const scoped = this.scopedKeys.has(`${m.provider}/${m.id}`);
      const scopeIcon = this.onAddToScopeCb
        ? scoped
          ? this.theme.fg("accent", " ✖")
          : this.theme.fg("muted", " ✚")
        : "";
      const line = `${arrow}${name} ${provider}   ${inputPrice}  ${outputPrice}  ${ctx}${scopeIcon}${checkmark}`;
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

  private updateProviderBar(): void {
    const parts: string[] = [];
    const allSelected = this.selectedProviderIndex === -1;
    const freeSelected = this.selectedProviderIndex === -2;
    parts.push(
      allSelected
        ? this.theme.fg("accent", this.theme.bold("[ All ]"))
        : this.theme.fg("muted", "[ All ]"),
    );
    parts.push(
      freeSelected
        ? this.theme.fg("accent", this.theme.bold("[ Free ]"))
        : this.theme.fg("muted", "[ Free ]"),
    );
    for (let i = 0; i < this.providers.length; i++) {
      const selected = i === this.selectedProviderIndex;
      parts.push(
        selected
          ? this.theme.fg("accent", this.theme.bold(`[ ${this.providers[i]} ]`))
          : this.theme.fg("muted", `[ ${this.providers[i]} ]`),
      );
    }
    this.providerText.setText(parts.join(" "));
    this.tui.requestRender();
  }

  handleInput(keyData: string): void {
    const kb = getKeybindings();
    if (matchesKey(keyData, Key.right)) {
      if (this.selectedProviderIndex >= this.providers.length - 1) {
        this.selectedProviderIndex = -1;
      } else if (this.selectedProviderIndex === -1) {
        this.selectedProviderIndex = -2;
      } else if (this.selectedProviderIndex === -2) {
        this.selectedProviderIndex = 0;
      } else {
        this.selectedProviderIndex++;
      }
      this.updateProviderBar();
      this.filterModels(this.searchInput.getValue());
      return;
    }
    if (matchesKey(keyData, Key.left)) {
      if (this.selectedProviderIndex === -1) {
        this.selectedProviderIndex = this.providers.length - 1;
      } else if (this.selectedProviderIndex === -2) {
        this.selectedProviderIndex = -1;
      } else if (this.selectedProviderIndex === 0) {
        this.selectedProviderIndex = -2;
      } else {
        this.selectedProviderIndex--;
      }
      this.updateProviderBar();
      this.filterModels(this.searchInput.getValue());
      return;
    }
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
    if (matchesKey(keyData, Key.ctrl("s")) && this.onAddToScopeCb) {
      const selected = this.filteredModels[this.selectedIndex];
      if (selected) {
        const result = this.onAddToScopeCb(selected);
        if (result === null) return;
        const key = `${selected.provider}/${selected.id}`;
        if (result) {
          this.scopedKeys.add(key);
        } else {
          this.scopedKeys.delete(key);
        }
        this.updateList();
      }
      return;
    }
    this.searchInput.handleInput(keyData);
    this.filterModels(this.searchInput.getValue());
  }
}

function globToRegex(pattern: string): RegExp {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // ** — match everything including /
        re += ".*";
        i++;
      } else {
        // * — match anything except /
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if (ch === "[") {
      const end = pattern.indexOf("]", i);
      if (end === -1) {
        re += "\\[";
      } else {
        re += pattern.substring(i, end + 1);
        i = end;
      }
    } else if (ch === "." || ch === "(" || ch === ")" || ch === "+" || ch === "^" || ch === "$" || ch === "|" || ch === "\\" || ch === "{" || ch === "}") {
      re += "\\" + ch;
    } else {
      re += ch;
    }
    i++;
  }
  return new RegExp("^" + re + "$", "i");
}

function resolveScopeSync(
  patterns: string[],
  models: Model<any>[],
): { model: Model<any>; thinkingLevel?: string }[] {
  const scoped: { model: Model<any>; thinkingLevel?: string }[] = [];
  const validLevels = ["low", "medium", "high", "minimal", "xhigh"];

  for (const pattern of patterns) {
    let globPattern = pattern;
    let thinkingLevel: string | undefined;
    const colonIdx = pattern.lastIndexOf(":");
    if (colonIdx > 0) {
      const suffix = pattern.substring(colonIdx + 1);
      if (validLevels.includes(suffix)) {
        thinkingLevel = suffix;
        globPattern = pattern.substring(0, colonIdx);
      }
    }

    // Exact match: provider/id or bare id
    const slashIdx = globPattern.indexOf("/");
    let exactMatch: Model<any> | undefined;
    if (slashIdx > 0) {
      const provider = globPattern.substring(0, slashIdx);
      const id = globPattern.substring(slashIdx + 1);
      exactMatch = models.find(
        (m) => m.provider === provider && m.id === id,
      );
    }
    if (!exactMatch) {
      const lower = globPattern.toLowerCase();
      exactMatch = models.find((m) => m.id.toLowerCase() === lower);
    }

    if (exactMatch) {
      if (
        !scoped.find(
          (s) =>
            s.model.provider === exactMatch!.provider &&
            s.model.id === exactMatch!.id,
        )
      ) {
        scoped.push({ model: exactMatch, thinkingLevel });
      }
      continue;
    }

    // Glob matching
    const hasGlob =
      globPattern.includes("*") ||
      globPattern.includes("?") ||
      globPattern.includes("[");
    if (hasGlob) {
      const regex = globToRegex(globPattern);
      for (const m of models) {
        const fullId = `${m.provider}/${m.id}`;
        if (regex.test(fullId) || regex.test(m.id)) {
          if (
            !scoped.find(
              (s) =>
                s.model.provider === m.provider && s.model.id === m.id,
            )
          ) {
            scoped.push({ model: m, thinkingLevel });
          }
        }
      }
    }
  }
  return scoped;
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

      const addToScope = (model: Model<any>): boolean | null => {
        const key = `${model.provider}/${model.id}`;
        const settingsPath = join(getAgentDir(), "settings.json");
        let settings: any = {};
        if (existsSync(settingsPath)) {
          try {
            settings = JSON.parse(readFileSync(settingsPath, "utf8"));
          } catch { /* ignore */ }
        }
        const enabledModels: string[] = settings.enabledModels ?? [];
        const idx = enabledModels.indexOf(key);
        let added: boolean;
        if (idx >= 0) {
          enabledModels.splice(idx, 1);
          added = false;
        } else {
          enabledModels.push(key);
          added = true;
        }
        settings.enabledModels = enabledModels;
        try {
          writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
        } catch {
          return null;
        }
        syncScope();
        return added;
      };
      const buildScopedSet = (): Set<string> => {
        const settingsPath = join(getAgentDir(), "settings.json");
        if (!existsSync(settingsPath)) return new Set();
        try {
          const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
          return new Set<string>(settings.enabledModels ?? []);
        } catch {
          return new Set();
        }
      };

      const syncScope = (): void => {
        const live =
          ctx.scopedModels as unknown as {
            model: Model<any>;
            thinkingLevel?: string;
          }[];
        const settingsPath = join(getAgentDir(), "settings.json");
        let patterns: string[] = [];
        if (existsSync(settingsPath)) {
          try {
            const settings = JSON.parse(
              readFileSync(settingsPath, "utf8"),
            );
            patterns = settings.enabledModels ?? [];
          } catch {
            /* ignore */
          }
        }
        const resolved = resolveScopeSync(patterns, allModels);
        live.splice(0, live.length, ...resolved);
      };

      // Apply scope from settings immediately (in case changed externally
      // or not yet applied for this session)
      syncScope();

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
              scopedKeys: buildScopedSet(),
              initialSearch: searchTerm || undefined,
              onSelect: (m) => finish(m),
              onAddToScope: (m) => addToScope(m),
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
      });      if (selected) {
        const ok = await pi.setModel(selected);
        if (ok) ctx.ui.notify(`Model: ${selected.id}`, "info");
      }
    },
  });
}

