import { ItemView, WorkspaceLeaf } from "obsidian";
import { existsSync } from "fs";
import { join } from "path";
import type BeadsPlugin from "./main";
import { VIEW_TYPE_BEADS_GRAPH } from "./types";
import { bdGraphHtml, BdError, BdOptions } from "./bd";
import d3Source from "./vendor/d3.v7.min.txt";

// bd's --html output loads D3 from `https://d3js.org` — Obsidian's CSP blocks
// that script-src inside the sandboxed iframe, which silently kills the
// visualization's JS (no colors, no drag/zoom/click). Swap it for the
// vendored copy inlined at build time so the graph works with no network call.
const D3_SCRIPT_TAG = /<script[^>]*\ssrc=["']https:\/\/d3js\.org\/[^"']*["'][^>]*><\/script>/;

function inlineD3(html: string): string {
	if (!D3_SCRIPT_TAG.test(html)) return html; // bd changed its template — degrade to CDN behavior rather than break
	// Replacer must be a FUNCTION: a string replacement arg gives special
	// meaning to `$&`, `$'`, `` $` ``, `$1`... and D3's minified source
	// contains `$`-sequences that would otherwise get expanded, corrupting
	// the inlined script (this is what caused the earlier blank/broken page).
	return html.replace(D3_SCRIPT_TAG, () => `<script>${d3Source}</script>`);
}

export interface GraphState {
	id?: string;
	all?: boolean;
}

/**
 * Renders bd's own dependency graph (`bd graph --html`, a self-contained D3
 * visualization) inside a sandboxed iframe. bd does the layout and rendering;
 * this view is just a shell with a scope label and a refresh button — no
 * graph-drawing code lives here.
 */
export class BeadsGraphView extends ItemView {
	private state: GraphState = {};
	private loading = false;
	private error?: string;
	private html?: string;
	private loadSeq = 0;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: BeadsPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_BEADS_GRAPH;
	}
	getDisplayText(): string {
		return this.state.all ? "Beads: all issues" : this.state.id ? `Graph: ${this.state.id}` : "Beads graph";
	}
	getIcon(): string {
		return "git-fork";
	}

	async setState(state: unknown, result: Parameters<ItemView["setState"]>[1]): Promise<void> {
		this.state = (state as GraphState) ?? {};
		await super.setState(state, result);
		await this.loadGraph();
	}

	getState(): Record<string, unknown> {
		return { ...this.state };
	}

	async onOpen(): Promise<void> {
		this.render();
		await this.loadGraph();
	}

	private resolveOpts(): BdOptions | null {
		const s = this.plugin.settings;
		if (!s.projectRoot) return null;
		if (!existsSync(join(s.projectRoot, ".beads"))) return null;
		return { bdPath: s.bdPath, cwd: s.projectRoot };
	}

	private async loadGraph(): Promise<void> {
		const opts = this.resolveOpts();
		if (!opts) {
			this.error = "No project root / .beads database configured (Settings → Beads).";
			this.html = undefined;
			this.render();
			return;
		}
		const seq = ++this.loadSeq;
		this.loading = true;
		this.error = undefined;
		this.render();
		try {
			const html = await bdGraphHtml(opts, { id: this.state.id, all: this.state.all });
			if (seq !== this.loadSeq) return;
			this.html = inlineD3(html);
		} catch (e) {
			if (seq !== this.loadSeq) return;
			this.error = e instanceof BdError ? e.message : String(e);
		} finally {
			if (seq === this.loadSeq) {
				this.loading = false;
				this.render();
			}
		}
	}

	private render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("beads-graph-pane");

		const header = root.createDiv({ cls: "beads-graph-header" });
		header.createDiv({
			cls: "beads-graph-title",
			text: this.state.all ? "All issues" : (this.state.id ?? "Beads graph"),
		});
		const refresh = header.createEl("button", {
			text: this.loading ? "Loading…" : "Refresh",
		});
		refresh.disabled = this.loading;
		refresh.onclick = () => void this.loadGraph();

		if (this.error) {
			root.createDiv({ cls: "beads-empty beads-error", text: this.error });
			return;
		}
		if (this.loading && !this.html) {
			root.createDiv({
				cls: "beads-empty",
				text: this.state.all ? "Building graph — this can take a while for the whole repo…" : "Building graph…",
			});
			return;
		}
		if (!this.html) return;

		// Sandboxed with scripts allowed (bd's D3 code needs to run) but no
		// allow-same-origin, so the iframe can never reach the Obsidian app,
		// the vault, or Node — it only ever renders bd's own static HTML
		// (D3 is inlined, see inlineD3 above — no network call needed).
		const iframe = root.createEl("iframe", { cls: "beads-graph-frame" });
		iframe.setAttribute("sandbox", "allow-scripts");
		iframe.srcdoc = this.html;
	}
}
