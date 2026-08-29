import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import { basename } from "path";
import type BeadsPlugin from "./main";
import { bdVersion, BdOptions } from "./bd";
import {
	HarnessProfile,
	DEFAULT_PROMPT_TEMPLATE,
	defaultHarnesses,
	defaultTerminalCommand,
	newHarnessId,
} from "./harness";

/** One bd-tracked project: a display name plus the directory holding `.beads/`. */
export interface BeadsProject {
	/** Stable identity, so reordering/renaming doesn't move the active pointer. */
	id: string;
	name: string;
	/** Absolute path to the project root (the directory containing `.beads/`). */
	path: string;
}

export interface BeadsSettings {
	/** All known projects. The pane works against exactly one at a time. */
	projects: BeadsProject[];
	/** `id` of the project every call site resolves against. */
	activeProjectId: string;
	/** Path to the bd binary, or just "bd" to resolve via PATH. Global. */
	bdPath: string;
	/** Auto-refresh interval in seconds (0 = disabled). */
	refreshIntervalSec: number;
	/** CLI coding-agent harnesses offered by "Work the bead". User-owned. */
	harnesses: HarnessProfile[];
	/** Template for the generated agent prompt (see harness.ts placeholders). */
	promptTemplate: string;
	/** argv template for opening a terminal at `{dir}`. No shell is used. */
	terminalCommand: string;
}

/** Shape of persisted data from before multi-project support. */
interface LegacySettings {
	projectRoot?: string;
}

export const DEFAULT_SETTINGS: BeadsSettings = {
	projects: [],
	activeProjectId: "",
	bdPath: "bd",
	refreshIntervalSec: 30,
	harnesses: [],
	promptTemplate: DEFAULT_PROMPT_TEMPLATE,
	terminalCommand: "",
};

export function newProjectId(): string {
	return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function makeProject(path: string, name?: string): BeadsProject {
	const trimmed = path.trim();
	return {
		id: newProjectId(),
		name: name?.trim() || basename(trimmed) || trimmed,
		path: trimmed,
	};
}

/**
 * Fold persisted data into a full settings object, migrating the pre-multi-project
 * single `projectRoot` into the first entry of `projects` so an existing user's
 * configured root survives the upgrade instead of being silently dropped.
 */
export function migrateSettings(
	data: (Partial<BeadsSettings> & LegacySettings) | null,
): BeadsSettings {
	const s: BeadsSettings = { ...DEFAULT_SETTINGS, ...(data ?? {}) };
	s.projects = Array.isArray(s.projects) ? s.projects : [];

	// Seed the example harnesses only on first sight of the field, so a user
	// who deliberately deleted them doesn't get them back on every reload.
	s.harnesses = Array.isArray(data?.harnesses) ? s.harnesses : defaultHarnesses();
	if (!s.promptTemplate?.trim()) s.promptTemplate = DEFAULT_PROMPT_TEMPLATE;
	if (!s.terminalCommand?.trim()) s.terminalCommand = defaultTerminalCommand();

	const legacyRoot = data?.projectRoot?.trim();
	if (legacyRoot && s.projects.length === 0) {
		s.projects = [makeProject(legacyRoot)];
	}

	// The active pointer must always name a project that exists.
	if (!s.projects.some((p) => p.id === s.activeProjectId)) {
		s.activeProjectId = s.projects[0]?.id ?? "";
	}
	return s;
}

/** The project the pane, watcher and status bar currently act on. */
export function activeProject(s: BeadsSettings): BeadsProject | null {
	return s.projects.find((p) => p.id === s.activeProjectId) ?? null;
}

/** `BdOptions` for the active project, or null when none is configured. */
export function activeOptions(s: BeadsSettings): BdOptions | null {
	const p = activeProject(s);
	if (!p?.path) return null;
	return { bdPath: s.bdPath, cwd: p.path };
}

export class BeadsSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: BeadsPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;

		new Setting(containerEl).setName("Projects").setHeading();

		if (s.projects.length === 0) {
			containerEl.createDiv({
				cls: "beads-settings-empty",
				text: "No projects yet. Add one pointing at a directory that contains .beads/.",
			});
		}

		for (const project of s.projects) {
			const setting = new Setting(containerEl)
				.addText((text) =>
					text
						.setPlaceholder("Name")
						.setValue(project.name)
						.onChange(async (value) => {
							project.name = value.trim();
							await this.plugin.saveSettings();
							this.plugin.refreshViews();
						}),
				)
				.addText((text) =>
					text
						.setPlaceholder("/home/you/my-project")
						.setValue(project.path)
						.onChange(async (value) => {
							project.path = value.trim();
							await this.plugin.saveSettings();
							this.plugin.refreshViews();
						}),
				)
				.addExtraButton((btn) =>
					btn
						.setIcon("trash")
						.setTooltip("Remove project")
						.onClick(async () => {
							s.projects = s.projects.filter((p) => p.id !== project.id);
							if (s.activeProjectId === project.id) {
								s.activeProjectId = s.projects[0]?.id ?? "";
							}
							await this.plugin.saveSettings();
							this.plugin.refreshViews();
							this.display();
						}),
				);
			setting.settingEl.addClass("beads-settings-project");
			setting.settingEl.toggleClass(
				"is-active",
				project.id === s.activeProjectId,
			);
		}

		new Setting(containerEl).addButton((btn) =>
			btn
				.setButtonText("Add project")
				.setCta()
				.onClick(async () => {
					const project = makeProject("");
					project.name = `Project ${String(s.projects.length + 1)}`;
					s.projects.push(project);
					if (!s.activeProjectId) s.activeProjectId = project.id;
					await this.plugin.saveSettings();
					this.display();
				}),
		);

		new Setting(containerEl).setName("bd CLI").setHeading();

		new Setting(containerEl)
			.setName("bd binary path")
			.setDesc(
				'Path to the bd executable. If "Test connection" fails with "not found", run `which bd` in a terminal and paste the full path here — apps launched from the GUI often don\'t inherit your shell PATH.',
			)
			.addText((text) =>
				text
					.setPlaceholder("bd")
					.setValue(s.bdPath)
					.onChange(async (value) => {
						s.bdPath = value.trim() || "bd";
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Auto-refresh interval")
			.setDesc("Seconds between automatic refreshes (0 to disable).")
			.addText((text) =>
				text
					.setPlaceholder("30")
					.setValue(String(s.refreshIntervalSec))
					.onChange(async (value) => {
						const n = Number.parseInt(value, 10);
						s.refreshIntervalSec = Number.isFinite(n) && n >= 0 ? n : 0;
						await this.plugin.saveSettings();
						this.plugin.restartRefreshTimer();
					}),
			);

		new Setting(containerEl).setName("Work the bead").setHeading();

		containerEl.createDiv({
			cls: "beads-settings-empty",
			text: 'Harnesses are yours to define — the plugin never runs them. Picking one shows the command it would run; you copy it and press Enter in your own terminal. Use {prompt} where the generated prompt goes and {model} for the model field.',
		});

		for (const harness of s.harnesses) {
			const setting = new Setting(containerEl)
				.addText((text) =>
					text
						.setPlaceholder("Name")
						.setValue(harness.name)
						.onChange(async (value) => {
							harness.name = value.trim();
							await this.plugin.saveSettings();
						}),
				)
				.addText((text) =>
					text
						.setPlaceholder("mytool --model {model} {prompt}")
						.setValue(harness.command)
						.onChange(async (value) => {
							harness.command = value.trim();
							await this.plugin.saveSettings();
						}),
				)
				.addText((text) =>
					text
						.setPlaceholder("model (optional)")
						.setValue(harness.model)
						.onChange(async (value) => {
							harness.model = value.trim();
							await this.plugin.saveSettings();
						}),
				)
				.addExtraButton((btn) =>
					btn
						.setIcon("trash")
						.setTooltip("Remove harness")
						.onClick(async () => {
							s.harnesses = s.harnesses.filter((h) => h.id !== harness.id);
							await this.plugin.saveSettings();
							this.display();
						}),
				);
			setting.settingEl.addClass("beads-settings-harness");
		}

		new Setting(containerEl).addButton((btn) =>
			btn.setButtonText("Add harness").onClick(async () => {
				s.harnesses.push({
					id: newHarnessId(),
					name: `Harness ${String(s.harnesses.length + 1)}`,
					command: "{prompt}",
					model: "",
				});
				await this.plugin.saveSettings();
				this.display();
			}),
		);

		new Setting(containerEl)
			.setName("Prompt template")
			.setDesc(
				"Placeholders: {id} {title} {description} {status} {priority} {type} {labels} {assignee} {project} {blockers} {dependents}. Clear the box to restore the default.",
			)
			.addTextArea((text) => {
				text.inputEl.rows = 12;
				text.inputEl.addClass("beads-settings-template");
				text
					.setValue(s.promptTemplate)
					.onChange(async (value) => {
						s.promptTemplate = value || DEFAULT_PROMPT_TEMPLATE;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Terminal launch command")
			.setDesc(
				"Run when you click “Open terminal” in the Work-the-bead preview. Split on spaces and run without a shell; {dir} is replaced with the project path (quoting is not supported — the substitution is already one argument).",
			)
			.addText((text) =>
				text
					.setPlaceholder(defaultTerminalCommand())
					.setValue(s.terminalCommand)
					.onChange(async (value) => {
						s.terminalCommand = value.trim() || defaultTerminalCommand();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName("Diagnostics").setHeading();

		new Setting(containerEl)
			.setName("Test connection")
			.setDesc("Run `bd --version` in the active project to verify settings.")
			.addButton((btn) =>
				btn.setButtonText("Test").onClick(async () => {
					const opts = activeOptions(this.plugin.settings);
					if (!opts) {
						new Notice("Beads: add a project and select it first.");
						return;
					}
					try {
						const v = await bdVersion(opts);
						new Notice(`Beads: OK — ${v}`);
					} catch (e) {
						new Notice(`Beads: ${(e as Error).message}`);
					}
				}),
			);
	}
}
