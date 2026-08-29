import { App, Menu, Modal, Notice, setIcon } from "obsidian";
import { execFile } from "child_process";
import { BeadIssue } from "./types";
import { BdOptions, bdDepList } from "./bd";

/**
 * "Work the bead" — hand one bead to a CLI coding agent.
 *
 * SECURITY / SAFETY POSTURE. This is the only place in the plugin that can
 * start a process other than `bd`, so it is deliberately the most conservative
 * surface here:
 *
 *  1. We NEVER run the agent command. We build it, show it verbatim in a
 *     preview modal, and copy it to the clipboard. The user pastes it into a
 *     terminal and presses Enter themselves, so nothing executes that they
 *     have not read first. There is no auto-run path and no hidden one.
 *  2. The only thing we can launch is the user's terminal emulator, from an
 *     explicit button click in that preview, via `execFile` with an argument
 *     ARRAY — no shell, exactly like `bd.ts`. The launcher template is split
 *     into argv tokens BEFORE `{dir}` is substituted, so a project path
 *     containing spaces stays one token and cannot inject extra arguments.
 *  3. Bead text (title/description/labels) only ever reaches the clipboard
 *     string, and is POSIX single-quoted there, so a description containing
 *     `; rm -rf ~` pastes as inert text inside one quoted argument.
 */

/** A user-defined CLI coding-agent harness (Claude Code, Codex, anything). */
export interface HarnessProfile {
	id: string;
	/** Display name shown in the "Work the bead" menu. */
	name: string;
	/**
	 * Command-line template. `{prompt}` is replaced with the shell-quoted
	 * generated prompt (appended if the template omits it) and `{model}` with
	 * this profile's model field. Deliberately free-form: the plugin does not
	 * track any vendor's current CLI flag syntax.
	 */
	command: string;
	/** Optional model name substituted for `{model}`. */
	model: string;
}

export function newHarnessId(): string {
	return `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Shipped as editable EXAMPLES, not as a maintained list of correct flags.
 * Both pass the prompt as one positional argument, which is the only shape
 * common enough across CLI agents to be a reasonable starting guess.
 */
export function defaultHarnesses(): HarnessProfile[] {
	return [
		{ id: newHarnessId(), name: "Claude Code", command: "claude {prompt}", model: "" },
		{ id: newHarnessId(), name: "Codex CLI", command: "codex {prompt}", model: "" },
	];
}

/**
 * The generated prompt. One configurable string so the user owns the wording;
 * the placeholders are the bead's fields plus its dependency context.
 *
 * bd has no per-issue "dump agent context" flag (checked `bd --help` /
 * `bd show --help`: the closest things are `bd prime`, which emits repo-wide
 * AI workflow context, and `bd show --long`). So the default template carries
 * the bead's own fields and then points the agent at `bd prime` / `bd show`
 * for the live record rather than inventing a competing context format.
 */
export const DEFAULT_PROMPT_TEMPLATE = `Work bead {id} in {project}.

Title: {title}
Type: {type} · Status: {status} · Priority: {priority}
Labels: {labels}
Assignee: {assignee}

Description:
{description}

Blocked by: {blockers}
Blocks: {dependents}

Before you start, run \`bd prime\` for this repo's beads workflow and
\`bd show {id}\` for the live record. Claim the bead, implement it, and only
close it once its acceptance criteria actually hold.`;

/** Per-platform default for opening a terminal at a directory. */
export function defaultTerminalCommand(): string {
	switch (process.platform) {
		case "darwin":
			return "open -a Terminal {dir}";
		case "win32":
			return "cmd /c start cmd /k cd /d {dir}";
		default:
			return "x-terminal-emulator --working-directory={dir}";
	}
}

const PLACEHOLDER = /\{(\w+)\}/g;

/** Replace `{key}` placeholders; unknown keys are left alone (typo stays visible). */
function fill(template: string, values: Record<string, string>): string {
	return template.replace(PLACEHOLDER, (match, key: string) =>
		Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match,
	);
}

/** POSIX single-quoting: the only escape inside '' is the '\'' dance. */
export function shellQuote(value: string): string {
	return `'${value.split("'").join(`'\\''`)}'`;
}

export interface PromptContext {
	issue: BeadIssue;
	projectName: string;
	blockers: BeadIssue[];
	dependents: BeadIssue[];
}

function summarize(issues: BeadIssue[]): string {
	if (issues.length === 0) return "(none)";
	return issues.map((i) => `${i.id} (${i.status}) ${i.title}`).join("; ");
}

export function buildPrompt(template: string, ctx: PromptContext): string {
	const i = ctx.issue;
	return fill(template, {
		id: i.id,
		title: i.title ?? "",
		description: i.description?.trim() || "(no description)",
		status: i.status ?? "",
		priority: `P${String(i.priority ?? 2)}`,
		type: i.issue_type ?? "",
		labels: i.labels?.length ? i.labels.join(", ") : "(none)",
		assignee: i.assignee || i.owner || "(unassigned)",
		project: ctx.projectName,
		blockers: summarize(ctx.blockers),
		dependents: summarize(ctx.dependents),
	});
}

/**
 * The command line the user will paste. The prompt is shell-quoted so it stays
 * a single argument no matter what the bead's description contains.
 */
export function buildCommand(profile: HarnessProfile, prompt: string): string {
	const quoted = shellQuote(prompt);
	const base = fill(profile.command, { model: profile.model, prompt: quoted });
	// A template that forgot {prompt} would otherwise silently drop it.
	return profile.command.includes("{prompt}") ? base : `${base} ${quoted}`;
}

/** Split a launcher template into argv, substituting `{dir}` per-token. */
export function terminalArgv(template: string, dir: string): string[] {
	return template
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.map((token) => token.split("{dir}").join(dir));
}

/**
 * Open the user's terminal emulator at `dir`. Only ever called from an explicit
 * button click in the preview modal — never automatically.
 */
export function openTerminalAt(template: string, dir: string): Promise<void> {
	const argv = terminalArgv(template, dir);
	const [cmd, ...args] = argv;
	if (!cmd) return Promise.reject(new Error("Terminal command is empty."));
	return new Promise((resolve, reject) => {
		execFile(cmd, args, { windowsHide: true, timeout: 10_000 }, (err) => {
			if (err) {
				reject(
					new Error(
						(err as NodeJS.ErrnoException).code === "ENOENT"
							? `Terminal command "${cmd}" not found. Set it in Beads settings.`
							: `Could not open a terminal: ${err.message}`,
					),
				);
				return;
			}
			resolve();
		});
	});
}

export interface WorkTheBeadDeps {
	opts: BdOptions;
	projectName: string;
	promptTemplate: string;
	terminalCommand: string;
	harnesses: HarnessProfile[];
}

/**
 * Step 1: the harness menu, anchored on the clicked button. Picking a harness
 * gathers dependency context and opens the preview modal.
 */
export function showHarnessMenu(
	app: App,
	event: MouseEvent,
	issue: BeadIssue,
	deps: WorkTheBeadDeps,
): void {
	const menu = new Menu();
	if (deps.harnesses.length === 0) {
		menu.addItem((item) =>
			item.setTitle("No harnesses configured — add one in Beads settings").setDisabled(true),
		);
	}
	for (const harness of deps.harnesses) {
		menu.addItem((item) =>
			item
				.setTitle(harness.model ? `${harness.name} · ${harness.model}` : harness.name)
				.setIcon("terminal")
				.onClick(() => void openWorkPreview(app, issue, harness, deps)),
		);
	}
	menu.showAtMouseEvent(event);
}

async function openWorkPreview(
	app: App,
	issue: BeadIssue,
	harness: HarnessProfile,
	deps: WorkTheBeadDeps,
): Promise<void> {
	// Dependency context is best-effort: a bd hiccup must not block the flow.
	let blockers: BeadIssue[] = [];
	let dependents: BeadIssue[] = [];
	try {
		[blockers, dependents] = await Promise.all([
			bdDepList(deps.opts, issue.id, "down"),
			bdDepList(deps.opts, issue.id, "up"),
		]);
	} catch {
		blockers = [];
		dependents = [];
	}
	const prompt = buildPrompt(deps.promptTemplate, {
		issue,
		projectName: deps.projectName,
		blockers,
		dependents,
	});
	new WorkTheBeadModal(app, issue, harness, prompt, deps).open();
}

/**
 * Step 2: show exactly what would run. Nothing here executes the agent — the
 * user copies the command and presses Enter in their own terminal.
 */
class WorkTheBeadModal extends Modal {
	constructor(
		app: App,
		private issue: BeadIssue,
		private harness: HarnessProfile,
		private prompt: string,
		private deps: WorkTheBeadDeps,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("beads-work");
		this.titleEl.setText(`Work ${this.issue.id} with ${this.harness.name}`);

		const command = buildCommand(this.harness, this.prompt);

		contentEl.createDiv({
			cls: "beads-work-note",
			text: "Nothing runs from Obsidian. Copy the command, open a terminal in the project, paste it, and press Enter yourself.",
		});

		contentEl.createDiv({ cls: "beads-work-section", text: "Command" });
		const cmdBox = contentEl.createEl("textarea", { cls: "beads-work-command" });
		cmdBox.value = command;
		cmdBox.readOnly = true;
		cmdBox.rows = 4;

		contentEl.createDiv({ cls: "beads-work-section", text: "Prompt" });
		const promptBox = contentEl.createEl("textarea", { cls: "beads-work-prompt" });
		promptBox.value = this.prompt;
		promptBox.readOnly = true;
		promptBox.rows = 12;

		const actions = contentEl.createDiv({ cls: "beads-work-actions" });
		this.copyButton(actions, "Copy command", command, true);
		this.copyButton(actions, "Copy prompt only", this.prompt, false);

		const termBtn = actions.createEl("button", { cls: "beads-work-term" });
		setIcon(termBtn.createSpan(), "terminal");
		termBtn.createSpan({ text: `Open terminal in ${this.deps.projectName}` });
		termBtn.onclick = () => {
			openTerminalAt(this.deps.terminalCommand, this.deps.opts.cwd).catch(
				(e: Error) => new Notice(`Beads: ${e.message}`),
			);
		};
	}

	private copyButton(
		parent: HTMLElement,
		label: string,
		text: string,
		cta: boolean,
	): void {
		const btn = parent.createEl("button", { text, cls: cta ? "mod-cta" : "" });
		btn.onclick = () => {
			navigator.clipboard.writeText(text).then(
				() => new Notice(`Beads: ${label.toLowerCase()} — copied.`),
				() => new Notice("Beads: could not write to the clipboard."),
			);
		};
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
