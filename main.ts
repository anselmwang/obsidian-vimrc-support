import * as keyFromAccelerator from 'keyboardevent-from-electron-accelerator';
import { Editor, EditorSelection, Notice, App, MarkdownView, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';

declare const CodeMirror: any;

interface Settings {
	vimrcFileName: string,
	displayChord: boolean,
	displayVimMode: boolean,
	fixedNormalModeLayout: boolean,
	capturedKeyboardMap: Record<string, string>
}

const DEFAULT_SETTINGS: Settings = {
	vimrcFileName: ".obsidian.vimrc",
	displayChord: false,
	displayVimMode: false,
	fixedNormalModeLayout: false,
	capturedKeyboardMap: {}
}

const enum vimStatus {
	normal = "🟢",
	insert = "🟠",
	replace = "🔴",
	visual = "🟡"
}

// NOTE: to future maintainers, please make sure all mapping commands are included in this array.
const mappingCommands: String[] = [
	"map",
	"nmap",
	"noremap",
]

function sleep(ms: number) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

export default class VimrcPlugin extends Plugin {
	settings: Settings;

	private codeMirrorVimObject: any = null;
	private editorMode: 'cm5' | 'cm6' = null;
	private initialized = false;

	private lastYankBuffer = new Array<string>(0);
	private lastSystemClipboard = "";
	private yankToSystemClipboard: boolean = false;
	private currentKeyChord: any = [];
	private vimChordStatusBar: HTMLElement = null;
	private vimStatusBar: HTMLElement = null;
	private currentVimStatus: vimStatus = vimStatus.normal;
	private customVimKeybinds: { [name: string]: boolean } = {};
	private currentSelection: [EditorSelection] = null;
	private isInsertMode: boolean = false;

	private complex_char_2_simple_char_mapping: ComplexChar2SimpleCharMapping = null;

	async captureKeyboardLayout() {
		// This is experimental API and it might break at some point:
		// https://developer.mozilla.org/en-US/docs/Web/API/KeyboardLayoutMap
		let keyMap: Record<string, string> = {};
		let layout = await (navigator as any).keyboard.getLayoutMap();
		let doneIterating = new Promise((resolve, reject) => {
			let counted = 0;
			layout.forEach((value: any, index: any) => {
				keyMap[index] = value;
				counted += 1;
				if (counted === layout.size)
					resolve();
			});
		});
		await doneIterating;
		new Notice('Keyboard layout captured');
		return keyMap;
	}

	async initialize() {
		if (this.initialized)
			return;

		// Determine if we have the legacy Obsidian editor (CM5) or the new one (CM6).
		// This is only available after Obsidian is fully loaded, so we do it as part of the `file-open` event.
		if ('editor:toggle-source' in (this.app as any).commands.editorCommands) {
			this.codeMirrorVimObject = (window as any).CodeMirrorAdapter?.Vim;
			this.editorMode = 'cm6';
			console.log('Vimrc plugin: using CodeMirror 6 mode');
		} else {
			this.codeMirrorVimObject = CodeMirror.Vim;
			this.editorMode = 'cm5';
			console.log('Vimrc plugin: using CodeMirror 5 mode');
		}

		this.registerDomEvent(document, 'click', () => {
			this.captureYankBuffer();
		});
		this.registerDomEvent(document, 'keyup', () => {
			this.captureYankBuffer();
		});
		this.registerDomEvent(document, 'focusin', () => {
			this.captureYankBuffer();
		})

		this.initialized = true;
	}

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new SettingsTab(this.app, this))

		this.app.workspace.on('file-open', async (file: TFile) => {
			if (!this.initialized)
				await this.initialize();
			const VIMRC_FILE_NAME = this.settings.vimrcFileName;
			this.app.vault.adapter.read(VIMRC_FILE_NAME).
				then((lines) => this.readVimInit(lines)).
				catch(error => { console.log('Error loading vimrc file', VIMRC_FILE_NAME, 'from the vault root', error) });
		});


		let dict_content = await this.app.vault.adapter.read(".obsidian/plugins/obsidian-vimrc-support/shuangpin_search.dict.txt")
		this.complex_char_2_simple_char_mapping = new ComplexChar2SimpleCharMapping(dict_content);

		this.addCommand({
			id: 'enrich-current-vim-search-pattern',
			name: 'Enrich Current VIM Search Pattern',
			editorCallback: (editor) => {
				let vim_global_state = this.codeMirrorVimObject.getVimGlobalState_();
				let vim_search_pattern = vim_global_state.query;
				if(vim_search_pattern == null)
				{
					return;
				}
				let enriched_pattern = this.complex_char_2_simple_char_mapping.gen_enriched_pattern(
					vim_search_pattern.source,
					editor.getValue()
				);
				vim_global_state.query = enriched_pattern;
			}

		})

	}

	async loadSettings() {
		const data = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	logVimModeChange(modeObj: any) {
		this.isInsertMode = modeObj.mode === 'insert';
		switch (modeObj.mode) {
			case "insert":
				this.currentVimStatus = vimStatus.insert;
				break;
			case "normal":
				this.currentVimStatus = vimStatus.normal;
				break;
			case "visual":
				this.currentVimStatus = vimStatus.visual;
				break;
			case "replace":
				this.currentVimStatus = vimStatus.replace;
				break;
			default:
				break;
		}
		if (this.settings.displayVimMode)
			this.vimStatusBar.setText(this.currentVimStatus);
	}

	onunload() {
		console.log('unloading Vimrc plugin (but Vim commands that were already loaded will still work)');
	}

	private getActiveView(): MarkdownView {
		return this.app.workspace.getActiveViewOfType(MarkdownView);
	}

	private getCodeMirror(view: MarkdownView): CodeMirror.Editor {
		// For CM6 this actually returns an instance of the object named CodeMirror from cm_adapter of codemirror_vim
		if (this.editorMode == 'cm6')
			return (view as any).sourceMode?.cmEditor?.cm?.cm;
		else
			return (view as any).sourceMode?.cmEditor;
	}

	readVimInit(vimCommands: string) {
		let view = this.getActiveView();
		if (view) {
			var cmEditor = this.getCodeMirror(view);
			if (cmEditor && !this.codeMirrorVimObject.loadedVimrc) {
				this.defineBasicCommands(this.codeMirrorVimObject);
				this.defineSendKeys(this.codeMirrorVimObject);
				this.defineObCommand(this.codeMirrorVimObject);
				this.defineCmCommand(this.codeMirrorVimObject);
				this.defineSurround(this.codeMirrorVimObject);

				// Record the position of selections
				CodeMirror.on(cmEditor, "cursorActivity", async (cm: any) => {
					this.currentSelection = cm.listSelections()
				});

				vimCommands.split("\n").forEach(
					function (line: string, index: number, arr: [string]) {
						if (line.trim().length > 0 && line.trim()[0] != '"') {
							let split = line.split(" ")
							if (mappingCommands.includes(split[0])) {
								// Have to do this because "vim-command-done" event doesn't actually work properly, or something.
								this.customVimKeybinds[split[1]] = true
							}
							this.codeMirrorVimObject.handleEx(cmEditor, line);
						}
					}.bind(this) // Faster than an arrow function. https://stackoverflow.com/questions/50375440/binding-vs-arrow-function-for-react-onclick-event
				)

				this.prepareChordDisplay();
				this.prepareVimModeDisplay();

				// Make sure that we load it just once per CodeMirror instance.
				// This is supposed to work because the Vim state is kept at the keymap level, hopefully
				// there will not be bugs caused by operations that are kept at the object level instead
				this.codeMirrorVimObject.loadedVimrc = true;
			}

			if (cmEditor) {
				cmEditor.on('vim-mode-change', (modeObj: any) => {
					if (modeObj)
						this.logVimModeChange(modeObj);
				});
				this.defineFixedLayout(cmEditor);
			}
		}
	}

	defineBasicCommands(vimObject: any) {
		vimObject.defineOption('clipboard', '', 'string', ['clip'], (value: string, cm: any) => {
			if (value) {
				if (value.trim() == 'unnamed' || value.trim() == 'unnamedplus') {
					if (!this.yankToSystemClipboard) {
						this.yankToSystemClipboard = true;
						console.log("Vim is now set to yank to system clipboard.");
					}
				} else {
					throw new Error("Unrecognized clipboard option, supported are 'unnamed' and 'unnamedplus' (and they do the same)")
				}
			}
		});

		vimObject.defineOption('tabstop', 4, 'number', [], (value: number, cm: any) => {
			if (value && cm) {
				cm.setOption('tabSize', value);
			}
		});

		vimObject.defineEx('iunmap', '', (cm: any, params: any) => {
			if (params.argString.trim()) {
				this.codeMirrorVimObject.unmap(params.argString.trim(), 'insert');
			}
		});

		vimObject.defineEx('noremap', '', (cm: any, params: any) => {
			if (!params?.args?.length) {
				throw new Error('Invalid mapping: noremap');
			}

			if (params.argString.trim()) {
				this.codeMirrorVimObject.noremap.apply(this.codeMirrorVimObject, params.args);
			}
		});

		// Allow the user to register an Ex command
		vimObject.defineEx('exmap', '', (cm: any, params: any) => {
			if (params?.args?.length && params.args.length < 2) {
				throw new Error(`exmap requires at least 2 parameters: [name] [actions...]`);
			}
			let commandName = params.args[0];
			params.args.shift();
			let commandContent = params.args.join(' ');
			// The content of the user's Ex command is just the remaining parameters of the exmap command
			this.codeMirrorVimObject.defineEx(commandName, '', (cm: any, params: any) => {
				this.codeMirrorVimObject.handleEx(cm, commandContent);
			});
		});
	}

	defineSendKeys(vimObject: any) {
		vimObject.defineEx('sendkeys', '', async (cm: any, params: any) => {
			if (!params?.args?.length) {
				console.log(params);
				throw new Error(`The sendkeys command requires a list of keys, e.g. sendKeys Ctrl+p a b Enter`);
			}

			let allGood = true;
			let events: KeyboardEvent[] = [];
			for (const key of params.args) {
				if (key.startsWith('wait')) {
					const delay = key.slice(4);
					await sleep(delay * 1000);
				}
				else {
					let keyEvent: KeyboardEvent = null;
					try {
						keyEvent = new KeyboardEvent('keydown', keyFromAccelerator.toKeyEvent(key));
						events.push(keyEvent);
					}
					catch (e) {
						allGood = false;
						throw new Error(`Key '${key}' couldn't be read as an Electron Accelerator`);
					}
					if (allGood) {
						for (keyEvent of events)
							window.postMessage(JSON.parse(JSON.stringify(keyEvent)), '*');
						// view.containerEl.dispatchEvent(keyEvent);
					}
				}
			}
		});
	}

	defineObCommand(vimObject: any) {
		vimObject.defineEx('obcommand', '', async (cm: any, params: any) => {
			const availableCommands = (this.app as any).commands.commands;
			if (!params?.args?.length || params.args.length != 1) {
				console.log(`Available commands: ${Object.keys(availableCommands).join('\n')}`)
				throw new Error(`obcommand requires exactly 1 parameter`);
			}
			let view = this.getActiveView();
			let editor = view.editor;
			const command = params.args[0];
			if (command in availableCommands) {
				let callback = availableCommands[command].callback;
				let checkCallback = availableCommands[command].checkCallback;
				let editorCallback = availableCommands[command].editorCallback;
				let editorCheckCallback = availableCommands[command].editorCheckCallback;
				if (editorCheckCallback)
					editorCheckCallback(false, editor, view);
				else if (editorCallback)
					editorCallback(editor, view);
				else if (checkCallback)
					checkCallback(false);
				else if (callback)
					callback();
				else
					throw new Error(`Command ${command} doesn't have an Obsidian callback`);
			} else
				throw new Error(`Command ${command} was not found, try 'obcommand' with no params to see in the developer console what's available`);
		});
	}

	defineCmCommand(vimObject: any) {
		vimObject.defineEx('cmcommand', '', async (cm: any, params: any) => {
			if (!params?.args?.length || params.args.length != 1) {
				throw new Error(`cmcommand requires exactly 1 parameter`);
			}
			if (this.editorMode === 'cm5') {
				let cmEditor = this.getCodeMirror(this.getActiveView());
				cmEditor.execCommand(params.args[0]);
			}
			else
				throw new Error('cmcommand currently only works on the legacy CM5 editor');
		});
	}

	defineSurround(vimObject: any) {
		// Function to surround selected text or highlighted word.
		var surroundFunc = (params: string[]) => {
			if (this.editorMode === 'cm6')
				throw new Error("surround is not yet supported in the new editor. To be added soon.");
			var editor = this.getActiveView().editor;
			if (!params.length) {
				throw new Error("surround requires exactly 2 parameters: prefix and postfix text.");
			}
			let newArgs = params.join(" ").match(/(\\.|[^\s\\\\]+)+/g);
			if (newArgs.length != 2) {
				throw new Error("surround requires exactly 2 parameters: prefix and postfix text.");
			}
			
			let beginning = newArgs[0].replace("\\\\", "\\").replace("\\ ", " "); // Get the beginning surround text
			let ending = newArgs[1].replace("\\\\", "\\").replace("\\ ", " "); // Get the ending surround text

			let currentSelections = this.currentSelection;
			var chosenSelection = currentSelections[0];
			if (this.currentSelection && currentSelections.length > 1) {
				console.log("WARNING: Multiple selections in surround. Attempt to select matching cursor. (obsidian-vimrc-support)")
				const cursorPos = editor.getCursor();
				for (const selection of currentSelections) {
					if (selection.head.line == cursorPos.line && selection.head.ch == cursorPos.ch) {
						console.log("RESOLVED: Selection matching cursor found. (obsidian-vimrc-support)")
						chosenSelection = selection;
						break;
					}
				}
			}
			if (JSON.stringify(chosenSelection.anchor) === JSON.stringify(chosenSelection.head)) {
				// No range of selected text, so select word.
				var line = editor.getLine(chosenSelection.anchor.line);
				if (line.length === 0)
					throw new Error("can't surround on an empty line");
				// Go to the beginning of the word
				let wordStart = chosenSelection.anchor.ch;
				for ( ; wordStart >= 0 ; wordStart--)
					if (line[wordStart].match(/\s/))
						break;
				wordStart++;
				let wordEnd = chosenSelection.anchor.ch;
				for ( ; wordEnd < line.length ; wordEnd++)
					if (line[wordEnd].match(/\s/))
						break;
				var word = line.substring(wordStart, wordEnd);
				chosenSelection.anchor.ch = wordStart;
				chosenSelection.head.ch = wordEnd;
				chosenSelection = {
					anchor: {line: chosenSelection.anchor.line, ch: wordStart},
					head: {line: chosenSelection.head.line, ch: wordEnd}
				};
			}
			let currText = editor.getRange(chosenSelection.anchor, chosenSelection.head);
			editor.replaceRange(beginning + currText + ending, chosenSelection.anchor, chosenSelection.head);
		}

		vimObject.defineEx("surround", "", (cm: any, params: any) => { surroundFunc(params.args); });

		vimObject.defineEx("pasteinto", "", (cm: any, params: any) => {
			// Using the register for when this.yankToSystemClipboard == false
			surroundFunc(
				['[',
				 '](' + vimObject.getRegisterController().getRegister('yank').keyBuffer + ")"]);
		})

		var editor = this.getActiveView().editor;
		// Handle the surround dialog input
		var surroundDialogCallback = (value: string) => {
			if ((/^\[+$/).test(value)) { // check for 1-inf [ and match them with ]
				surroundFunc([value, "]".repeat(value.length)])
			} else if ((/^\(+$/).test(value)) { // check for 1-inf ( and match them with )
				surroundFunc([value, ")".repeat(value.length)])
			} else if ((/^\{+$/).test(value)) { // check for 1-inf { and match them with }
				surroundFunc([value, "}".repeat(value.length)])
			} else { // Else, just put it before and after.
				surroundFunc([value, value])
			}
		}

		vimObject.defineOperator("surroundOperator", () => {
			let p = "<span>Surround with: <input type='text'></span>"
			CodeMirror.openDialog(p, surroundDialogCallback, { bottom: true, selectValueOnOpen: false })
		})


		vimObject.mapCommand("<A-y>s", "operator", "surroundOperator")

	}

	captureYankBuffer() {
		if (this.yankToSystemClipboard) {
			let currentBuffer = this.codeMirrorVimObject.getRegisterController().getRegister('yank').keyBuffer;
			if (currentBuffer != this.lastYankBuffer) {
				if (this.lastYankBuffer.length > 0 && currentBuffer.length > 0 && currentBuffer[0]) {
					navigator.clipboard.writeText(currentBuffer[0]);
					navigator.clipboard.readText().then((value) => { this.lastSystemClipboard = value; });
				}
				this.lastYankBuffer = currentBuffer;
				return;
			}
			let currentClipboard = navigator.clipboard.readText().then((value) => {
				if (value != this.lastSystemClipboard) {
					let yankRegister = this.codeMirrorVimObject.getRegisterController().getRegister('yank')
					yankRegister.setText(value);
					this.lastYankBuffer = yankRegister.keyBuffer;
					this.lastSystemClipboard = value;
				}
			})
		}
	}

	prepareChordDisplay() {
		if (this.settings.displayChord) {
			// Add status bar item
			this.vimChordStatusBar = this.addStatusBarItem();

			// Move vimChordStatusBar to the leftmost position and center it.
			let parent = this.vimChordStatusBar.parentElement;
			this.vimChordStatusBar.parentElement.insertBefore(this.vimChordStatusBar, parent.firstChild);
			this.vimChordStatusBar.style.marginRight = "auto";

			let cmEditor = this.getCodeMirror(this.getActiveView());
			// See https://codemirror.net/doc/manual.html#vimapi_events for events.
			CodeMirror.on(cmEditor, "vim-keypress", async (vimKey: any) => {
				if (vimKey != "<Esc>") { // TODO figure out what to actually look for to exit commands.
					this.currentKeyChord.push(vimKey);
					if (this.customVimKeybinds[this.currentKeyChord.join("")] != undefined) { // Custom key chord exists.
						this.currentKeyChord = [];
					}
				} else {
					this.currentKeyChord = [];
				}

				// Build keychord text
				let tempS = "";
				for (const s of this.currentKeyChord) {
					tempS += " " + s;
				}
				if (tempS != "") {
					tempS += "-";
				}
				this.vimChordStatusBar.setText(tempS);
			});
			CodeMirror.on(cmEditor, "vim-command-done", async (reason: any) => { // Reset display
				this.vimChordStatusBar.setText("");
				this.currentKeyChord = [];
			});
		}
	}

	prepareVimModeDisplay() {
		if (this.settings.displayVimMode) {
			this.vimStatusBar = this.addStatusBarItem() // Add status bar item
			this.vimStatusBar.setText(vimStatus.normal) // Init the vimStatusBar with normal mode
		}
	}

	defineFixedLayout(cm: CodeMirror.Editor) {
		cm.on('keydown', (instance: CodeMirror.Editor, ev: KeyboardEvent) => {
			if (this.settings.fixedNormalModeLayout) {
				const keyMap = this.settings.capturedKeyboardMap;
				if (!this.isInsertMode && !ev.shiftKey &&
					ev.code in keyMap && ev.key != keyMap[ev.code]) {
					this.codeMirrorVimObject.handleKey(instance, keyMap[ev.code], 'mapping');
					ev.preventDefault();
					return false;
				}
			}
		});
	}
}


class ComplexChar2SimpleCharMapping {
	_dict: Map<string, string>;

	constructor(dict_content: string)
	{
		this._dict = new Map();		
		dict_content.split("\n").forEach(
			(line: string, index: number) => {
				line = line.trim();
				if(line != "")
				{
					let fields = line.split(' ');
					console.assert(fields.length == 2,
						`Dictionary line ${index+1} "${line}" doesn't have 2 fields.`);
					let complex_char = fields[0];
					let simple_chars = fields[1];
					this._dict.set(complex_char, simple_chars);
				}
			}
		)
	}

	find_next(query: string, content: string, content_idx: number)
	{
		let query_idx = 0;
		for(; content_idx<content.length; content_idx++)
		{
			let c = content[content_idx];
			let simple_chars = this._dict.get(c);
			if(simple_chars == null)
			{
				simple_chars = c;
			}
			if(simple_chars.indexOf(query[query_idx]) != -1)
			{
				query_idx += 1;
			} else if(simple_chars.indexOf(query[0]) != -1)
			{
				query_idx = 1;
			} else {
				query_idx = 0;
			}

			if(query_idx == query.length)
			{
				break;
			}
		}

		if(query_idx == query.length)
		{
			return content_idx - query.length + 1;
		} else {
			return -1;
		}
	}

	gen_match_list(query: string, content: string): string[]
	{
		if(query.length == 0)
		{
			return [];
		}
		let start_idx = 0;
		let match_list = [];
		while(true)
		{
			let matched_idx = this.find_next(query, content, start_idx);
			if(matched_idx != -1)
			{
				let word = content.slice(matched_idx, matched_idx + query.length);
				match_list.push(word);
				start_idx = matched_idx + 1;
			} else {
				return match_list;
			}
		}
	}

	gen_enriched_pattern(query:string, content: string)
	{
		let match_list = this.gen_match_list(query, content);
		let pattern = new RegExp(match_list.join("|"), "im");
		return pattern;
	}

}
class SettingsTab extends PluginSettingTab {
	plugin: VimrcPlugin;

	constructor(app: App, plugin: VimrcPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		let { containerEl } = this;

		containerEl.empty();

		containerEl.createEl('h2', { text: 'Vimrc Settings' });

		new Setting(containerEl)
			.setName('Vimrc file name')
			.setDesc('Relative to vault directory (requires restart)')
			.addText((text) => {
				text.setPlaceholder(DEFAULT_SETTINGS.vimrcFileName);
				text.setValue(this.plugin.settings.vimrcFileName || DEFAULT_SETTINGS.vimrcFileName);
				text.onChange(value => {
					this.plugin.settings.vimrcFileName = value;
					this.plugin.saveSettings();
				})
			});

		new Setting(containerEl)
			.setName('Vim chord display')
			.setDesc('Displays the current chord until completion. Ex: "<Space> f-" (requires restart)')
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.displayChord || DEFAULT_SETTINGS.displayChord);
				toggle.onChange(value => {
					this.plugin.settings.displayChord = value;
					this.plugin.saveSettings();
				})
			});

		new Setting(containerEl)
			.setName('Vim mode display')
			.setDesc('Displays the current vim mode (requires restart)')
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.displayVimMode || DEFAULT_SETTINGS.displayVimMode);
				toggle.onChange(value => {
					this.plugin.settings.displayVimMode = value;
					this.plugin.saveSettings();
				})
			});

		new Setting(containerEl)
			.setName('Use a fixed keyboard layout for Normal mode')
			.setDesc('Define a keyboard layout to always use when in Normal mode, regardless of the input language (experimental).')
			.addButton(async (button) => {
				button.setButtonText('Capture current layout');
				button.onClick(async () => {
					this.plugin.settings.capturedKeyboardMap = await this.plugin.captureKeyboardLayout();
					this.plugin.saveSettings();
				});
			})
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.fixedNormalModeLayout || DEFAULT_SETTINGS.fixedNormalModeLayout);
				toggle.onChange(async value => {
					this.plugin.settings.fixedNormalModeLayout = value;
					if (value && Object.keys(this.plugin.settings.capturedKeyboardMap).length === 0)
						this.plugin.settings.capturedKeyboardMap = await this.plugin.captureKeyboardLayout();
					this.plugin.saveSettings();
				});
			})
	}
}
