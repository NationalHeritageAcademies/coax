import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, OnInit, effect, inject, input, output } from '@angular/core';
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import { ThemeService } from '../../store/theme.service';

// Wire Monaco's worker loader. Vite's `?worker` suffix resolves these as
// constructable Worker classes. We only enable JSON syntactically — TS/CSS/HTML
// language workers can be added later if/when those bodies need them.
(globalThis as { MonacoEnvironment?: monaco.Environment }).MonacoEnvironment = {
	getWorker(_moduleId: string, label: string) {
		if (label === 'json') return new jsonWorker();
		return new editorWorker();
	}
};

/**
 * Monaco-backed code editor. The template is deliberately empty — Monaco
 * manages its own DOM inside the host element and re-renders must never
 * disturb it. Input changes flow through effects that call Monaco's
 * imperative API instead of touching the DOM.
 *
 * The Melodic version needed ~90 lines of stylesheet mirroring to make
 * Monaco's document.head styles pierce shadow roots; Angular's emulated
 * encapsulation is not Shadow DOM, so all of that is gone — Monaco's global
 * styles just apply.
 */
@Component({
	selector: 'hu-monaco-editor',
	template: '',
	styles: `
		:host {
			display: block;
			min-height: 120px;
		}
	`,
	changeDetection: ChangeDetectionStrategy.OnPush
})
export class MonacoEditorComponent implements OnInit, OnDestroy {
	/** Current text content. Programmatic sets don't re-emit valueChange. */
	readonly value = input<string>('');
	/** Monaco language id (json, javascript, html, plaintext, shell, …). */
	readonly language = input<string>('plaintext');
	readonly readonly = input<boolean>(false);

	/** Fired on user edits with the full editor text. */
	readonly valueChange = output<string>();

	private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
	private readonly theme = inject(ThemeService);

	private editor: monaco.editor.IStandaloneCodeEditor | null = null;
	private suppressChange = false;

	constructor() {
		// Inputs → Monaco's imperative API. Guarded on `editor` so the initial
		// effect run (before ngOnInit creates the editor) is a no-op; creation
		// reads the current input values directly.
		effect(() => {
			const value = this.value();
			if (this.editor && this.editor.getValue() !== value) {
				this.suppressChange = true;
				this.editor.setValue(value);
				this.suppressChange = false;
			}
		});
		effect(() => {
			const language = this.language();
			const model = this.editor?.getModel();
			if (model) monaco.editor.setModelLanguage(model, language);
		});
		effect(() => {
			const readOnly = this.readonly();
			this.editor?.updateOptions({ readOnly });
		});
		// Sync Monaco's theme with the host app. Without this, the editor stays
		// on the default light theme even when the rest of the UI is in dark
		// mode, producing a glaring white box. monaco.editor.setTheme is global —
		// every editor on the page picks up the change.
		effect(() => {
			monaco.editor.setTheme(this.theme.resolved() === 'dark' ? 'vs-dark' : 'vs');
		});
	}

	ngOnInit(): void {
		this.editor = monaco.editor.create(this.host.nativeElement, {
			value: this.value(),
			language: this.language(),
			readOnly: this.readonly(),
			automaticLayout: true,
			minimap: { enabled: false },
			scrollBeyondLastLine: false,
			fontSize: 13,
			tabSize: 2,
			wordWrap: 'on'
		});

		this.editor.onDidChangeModelContent(() => {
			if (this.suppressChange) return;
			this.valueChange.emit(this.editor?.getValue() ?? '');
		});
	}

	ngOnDestroy(): void {
		this.editor?.dispose();
		this.editor = null;
	}
}
