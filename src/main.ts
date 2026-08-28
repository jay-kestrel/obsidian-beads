import { FileSystemAdapter, Plugin, WorkspaceLeaf } from "obsidian";
import { FSWatcher, watch, existsSync } from "fs";
import { join } from "path";
import {
	BeadsSettings,
	BeadsSettingTab,
	activeProject,
	activeOptions,
	makeProject,
	migrateSettings,
} from "./settings";
import { BeadsView } from "./view";
import { BeadEditorView } from "./editor";
import { BeadsGraphView, GraphState } from "./graph";
import { VIEW_TYPE_BEADS, VIEW_TYPE_BEADS_EDITOR, VIEW_TYPE_BEADS_GRAPH } from "./types";
import { bdReadyCount, invalidateReadCache } from "./bd";
import { registerBeadsCodeBlock } from "./codeblock";

export default class BeadsPlugin extends Plugin {
	settings!: BeadsSettings;

	private refreshTimer: number | null = null;
	private watcher: FSWatcher | null = null;
	private watchedRoot: string | null = null;
	private watchDebounce: number | null = null;
	private statusBarEl: HTMLElement | null = null;
	private statusSeq = 0;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.detectRoot();

		this.registerView(
			VIEW_TYPE_BEADS,
			(leaf) => new BeadsView(leaf, this),
		);

		this.registerView(
			VIEW_TYPE_BEADS_EDITOR,
			(leaf) => new BeadEditorView(leaf, this),
		);

		this.registerView(
			VIEW_TYPE_BEADS_GRAPH,
			(leaf) => new BeadsGraphView(leaf, this),
		);

		this.addRibbonIcon("list-checks", "Open Beads pane", () => {
			void this.activateView();
		});

		this.addCommand({
			id: "open-pane",
			name: "Open pane",
			callback: () => void this.activateView(),
		});

		this.addCommand({
			id: "new-bead",
			name: "New bead",
			callback: () => void this.newBead(),
		});

		this.addCommand({
			id: "refresh",
			name: "Refresh pane",
			callback: () => this.refreshViews(),
		});

		this.addCommand({
			id: "open-graph-all",
			name: "Open dependency graph (all issues)",
			callback: () => void this.openGraph({ all: true }),
		});

		this.addSettingTab(new BeadsSettingTab(this.app, this));

		registerBeadsCodeBlock(this);

		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addClass("beads-statusbar");

		this.restartRefreshTimer();
		this.restartWatch();
		this.updateStatusBar();
	}

	onunload(): void {
		this.stopWatch();
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Parameters<
			typeof migrateSettings
		>[0];
		this.settings = migrateSettings(data);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		// Re-point the filesystem watcher if the active project changed.
		this.restartWatch();
	}

	/** Open (or reveal) the Beads pane in the right sidebar. */
	async activateView(): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(VIEW_TYPE_BEADS);
		let leaf: WorkspaceLeaf | null;
		if (existing.length > 0) {
			leaf = existing[0];
		} else {
			leaf = workspace.getRightLeaf(false);
			await leaf?.setViewState({
				type: VIEW_TYPE_BEADS,
				active: true,
			});
		}
		if (leaf) await workspace.revealLeaf(leaf);
	}

	/**
	 * Open a bead in the embedded editor as a main-area tab (like opening a
	 * note). If an editor for the same bead is already open, reveal it instead
	 * of stacking another tab.
	 */
	async openBead(id: string): Promise<void> {
		const { workspace } = this.app;
		for (const leaf of workspace.getLeavesOfType(VIEW_TYPE_BEADS_EDITOR)) {
			const state = leaf.getViewState().state as { id?: string } | undefined;
			if (state?.id === id) {
				await workspace.revealLeaf(leaf);
				return;
			}
		}
		const leaf = workspace.getLeaf("tab");
		await leaf.setViewState({
			type: VIEW_TYPE_BEADS_EDITOR,
			active: true,
			state: { id },
		});
		await workspace.revealLeaf(leaf);
	}

	/**
	 * Open (or reveal) a dependency-graph tab for one epic/issue, or the whole
	 * repo (`{ all: true }`). One tab per distinct scope, same as `openBead`.
	 */
	async openGraph(state: GraphState): Promise<void> {
		const { workspace } = this.app;
		for (const leaf of workspace.getLeavesOfType(VIEW_TYPE_BEADS_GRAPH)) {
			const s = leaf.getViewState().state as GraphState | undefined;
			if (!!s?.all === !!state.all && s?.id === state.id) {
				await workspace.revealLeaf(leaf);
				return;
			}
		}
		const leaf = workspace.getLeaf("tab");
		await leaf.setViewState({
			type: VIEW_TYPE_BEADS_GRAPH,
			active: true,
			state: state as Record<string, unknown>,
		});
		await workspace.revealLeaf(leaf);
	}

	/** Open a blank editor tab to create a new bead (same surface as editing). */
	async newBead(): Promise<void> {
		const { workspace } = this.app;
		const leaf = workspace.getLeaf("tab");
		await leaf.setViewState({
			type: VIEW_TYPE_BEADS_EDITOR,
			active: true,
			state: { create: true },
		});
		await workspace.revealLeaf(leaf);
	}

	/** Refresh every open Beads pane, and the status-bar ready count. */
	refreshViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(
			VIEW_TYPE_BEADS,
		)) {
			const view = leaf.view;
			if (view instanceof BeadsView) void view.refresh();
		}
		this.updateStatusBar();
	}

	/**
	 * Auto-fill the first project on first load: if no projects are configured
	 * and the vault folder itself contains a `.beads/`, seed one from it. Never
	 * touches a project list the user has already set up.
	 */
	private detectRoot(): void {
		if (this.settings.projects.length > 0) return;
		const adapter = this.app.vault.adapter;
		if (adapter instanceof FileSystemAdapter) {
			const base = adapter.getBasePath();
			if (existsSync(join(base, ".beads"))) {
				const project = makeProject(base);
				this.settings.projects = [project];
				this.settings.activeProjectId = project.id;
				void this.saveSettings();
			}
		}
	}

	/**
	 * Switch which project every surface reads from. Only one project is live at
	 * a time — the pane, watcher and status bar all follow this pointer.
	 */
	async setActiveProject(id: string): Promise<void> {
		if (this.settings.activeProjectId === id) return;
		if (!this.settings.projects.some((p) => p.id === id)) return;
		this.settings.activeProjectId = id;
		await this.saveSettings();
		invalidateReadCache();
		this.refreshViews();
	}

	/**
	 * Ambient "● N ready" in the status bar (works even with the pane closed).
	 * Reports the ACTIVE project only — an aggregate across projects would be
	 * both ambiguous (which repo is the number about?) and N subprocess spawns
	 * per refresh tick.
	 */
	updateStatusBar(): void {
		if (!this.statusBarEl) return;
		const opts = activeOptions(this.settings);
		if (!opts) {
			this.statusBarEl.setText("");
			return;
		}
		// Drop stale results: only the latest request may write the count.
		const my = ++this.statusSeq;
		void bdReadyCount(opts)
			.then((n) => {
				if (my === this.statusSeq) this.statusBarEl?.setText(`● ${n} ready`);
			})
			.catch(() => {
				if (my === this.statusSeq) this.statusBarEl?.setText("");
			});
	}

	restartRefreshTimer(): void {
		if (this.refreshTimer !== null) {
			window.clearInterval(this.refreshTimer);
			this.refreshTimer = null;
		}
		const secs = this.settings.refreshIntervalSec;
		if (secs > 0) {
			this.refreshTimer = window.setInterval(
				() => this.refreshViews(),
				secs * 1000,
			);
			this.registerInterval(this.refreshTimer);
		}
	}

	/**
	 * Watch the `.beads` directory so external `bd` writes refresh the pane.
	 * Only the ACTIVE project is watched: the pane can only show one project at
	 * a time, so a change in an inactive one has nothing on screen to refresh.
	 */
	restartWatch(): void {
		const root = activeProject(this.settings)?.path ?? "";
		if (root === this.watchedRoot && this.watcher) return;
		this.stopWatch();
		this.watchedRoot = root;
		if (!root) return;
		const beadsDir = join(root, ".beads");
		try {
			this.watcher = watch(
				beadsDir,
				{ persistent: false, recursive: false },
				() => this.onBeadsChanged(),
			);
			this.watcher.on("error", () => this.stopWatch());
		} catch {
			// .beads may not exist yet; a later refresh/settings change retries.
			this.watcher = null;
		}
	}

	private onBeadsChanged(): void {
		if (this.watchDebounce !== null) {
			window.clearTimeout(this.watchDebounce);
		}
		this.watchDebounce = window.setTimeout(() => {
			this.watchDebounce = null;
			// An external bd write changed the DB — drop cached embed reads so
			// code blocks re-render fresh, not from the stale TTL cache.
			invalidateReadCache();
			this.refreshViews();
		}, 400);
	}

	private stopWatch(): void {
		if (this.watcher) {
			this.watcher.close();
			this.watcher = null;
		}
		if (this.watchDebounce !== null) {
			window.clearTimeout(this.watchDebounce);
			this.watchDebounce = null;
		}
	}
}
