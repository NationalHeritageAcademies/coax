import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, OnInit, computed, effect, inject, input, signal } from '@angular/core';
import { rpc } from '@ipc/renderer';
import type { RequestSendResult, SentRequest } from '@ipc/types';
import { WorkspaceStateService } from '../../store/workspace-state.service';
import { toCurl } from '../curl';
import { MonacoEditorComponent } from '../monaco-editor/monaco-editor.component';
import { ButtonComponent, IconComponent } from '../ui';

interface RequestDraftLocal {
	/** Display name on the sidebar tree + tab strip. Editable in the request pane. */
	name: string;
	method: string;
	url: string;
	headers: { key: string; value: string }[];
	body?: { kind: string; raw: string };
	auth?: { kind: string; data?: Record<string, string> };
	// Identifier used by response-chaining (`{{name.response.body.$.x}}`).
	// Optional — most requests won't set this. Persisted via the `chainName`
	// field on the saved request.
	chainName?: string;
}

type SubTab = 'params' | 'headers' | 'body' | 'auth' | 'vars' | 'curl';
type RespSubTab = 'body' | 'headers' | 'raw';
type Response = RequestSendResult['result'] | null;

// In-memory cache of per-request UI state — last response, the wire-form
// of the sent request, and which sub-tab + response sub-tab the user had
// open. Survives tab-switches (the component is destroyed and recreated,
// but the Map lives at module scope) but is wiped on app close — by
// design, not persisted to disk.
interface SessionState {
	response?: NonNullable<Response>;
	sentRequest?: SentRequest | null;
	subTab?: SubTab;
	respSubTab?: RespSubTab;
}
const sessionResponses = new Map<string, SessionState>();

function patchSession(key: string, patch: SessionState): void {
	const existing = sessionResponses.get(key) ?? {};
	sessionResponses.set(key, { ...existing, ...patch });
}

interface VarDebugRow {
	name: string;
	value?: string;
	source?: string;
	isSecret?: boolean;
}

// One rung of the resolver chain that contributes vars to the request.
// folderName labels the source for the Vars sub-tab badge; envName labels
// the active env at that folder. `vars` is empty when no env is active at
// that level — the level is shown anyway so the UI surfaces the chain.
type EnvVarsList = {
	envId: string;
	envName: string;
	folderName: string;
	vars: { id: string; key: string; valuePlain?: string; isSecret: boolean }[];
}[];

/**
 * One row of the unified Vars table.
 * 'env' rows are resolved env vars (click-to-override applies). 'chain',
 * 'builtin', 'unresolved' come from referenced-but-not-in-env tokens picked
 * up via var:resolve. Chain/builtin are read-only — overriding
 * `getToken.response.body.$.x` doesn't make sense.
 */
interface UnifiedVarRow {
	key: string;
	value: string;
	isSecret: boolean;
	source: string;
	overridden: boolean;
	kind: 'env' | 'chain' | 'builtin' | 'unresolved';
}

const MIN_REQUEST_PANE = 120;
const DEFAULT_REQUEST_PANE = 360;

/**
 * The main request workspace: chain-name row, method+URL+Send bar, draggable
 * request pane with sub-tabs (Params / Headers / Body / Auth / Vars / cURL),
 * splitter, and response pane with sub-tabs (Body / Headers / Raw).
 *
 * The local request draft (`draft`) is a plain non-reactive object — the
 * template reads it directly, but mutating fields like draft.url doesn't
 * trigger change detection. That preserves focus while the user types in the
 * URL or KV inputs. When we DO want a refresh after a draft mutation (body
 * kind change, headers add/remove, async draft load) we bump the
 * `draftVersion` signal, which the TEMPLATE consumes via a data attribute on
 * its first element. It must be a template binding, not a host binding:
 * zoneless fine-grained reactivity only marks the views that actually read a
 * signal dirty, and a host-binding consumer would refresh the host attribute
 * without re-evaluating the template (the draft.* reads below are plain
 * properties, invisible to the reactivity graph).
 *
 * The splitter drag intentionally bypasses the template — it sets a CSS
 * custom property on the host directly. A drag-triggered re-render would
 * disturb Monaco (selection/scroll/undo state).
 */
@Component({
	selector: 'hu-request-tab',
	templateUrl: './request-tab.component.html',
	styleUrls: ['./request-tab.component.scss'],
	imports: [ButtonComponent, IconComponent, MonacoEditorComponent],
	changeDetection: ChangeDetectionStrategy.OnPush
})
export class RequestTabComponent implements OnInit, OnDestroy {
	readonly tabId = input.required<string>();
	readonly requestId = input.required<string>();

	private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
	private readonly workspace = inject(WorkspaceStateService);

	protected readonly methodOptions = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
	protected readonly bodyKindOptions = ['none', 'text', 'json', 'form', 'multipart', 'graphql'];
	protected readonly authKindOptions = ['none', 'bearer', 'basic', 'api-key'];

	protected readonly requestSubTabs: { key: SubTab; label: string }[] = [
		{ key: 'params', label: 'Params' },
		{ key: 'headers', label: 'Headers' },
		{ key: 'body', label: 'Body' },
		{ key: 'auth', label: 'Auth' },
		{ key: 'vars', label: 'Vars' },
		{ key: 'curl', label: 'cURL' }
	];
	protected readonly responseSubTabs: RespSubTab[] = ['body', 'headers', 'raw'];

	// Non-reactive — mutating fields on this object never triggers a refresh.
	// Bump `draftVersion` to force one (used after structural changes like
	// adding a header or switching body kind, not URL keystrokes).
	protected draft: RequestDraftLocal = { name: '', method: 'GET', url: '', headers: [] };
	protected readonly draftVersion = signal(0);

	// Reactive — flipping these refreshes the template.
	protected readonly response = signal<Response>(null);
	// The wire-form of the last request, post variable resolution. Used by
	// the Raw response transcript so what's shown matches what the server
	// received rather than the template the user typed.
	protected readonly sentRequest = signal<SentRequest | null>(null);
	protected readonly subTab = signal<SubTab>('params');
	protected readonly respSubTab = signal<RespSubTab>('body');
	protected readonly sendInFlight = signal(false);
	protected readonly varDebug = signal<VarDebugRow[] | null>(null);
	protected readonly envVars = signal<EnvVarsList | null>(null);
	protected readonly overrides = signal<{ key: string; valuePlain?: string; isSecret: boolean }[] | null>(null);

	// Loading flags stay as plain fields so the in-flight toggle doesn't
	// re-render (the template only cares about the resulting data).
	private varDebugLoading = false;
	private envVarsLoading = false;
	private overridesLoading = false;
	private saveTimer: ReturnType<typeof setTimeout> | null = null;
	private requestPaneHeight: number = (() => {
		const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('hu-request-pane-height') : null;
		const n = stored ? Number(stored) : NaN;
		return Number.isFinite(n) && n >= MIN_REQUEST_PANE ? n : DEFAULT_REQUEST_PANE;
	})();
	private dragging = false;
	private dragStartY = 0;
	private dragStartHeight = 0;

	/** Params derived from the URL's query string (template-safe split). */
	protected readonly paramRows = computed(() => {
		this.draftVersion();
		return splitUrlAtQuery(this.draft.url).params;
	});

	protected readonly curlText = computed(() => {
		this.draftVersion();
		return toCurl(
			{
				method: this.draft.method,
				url: this.draft.url,
				headers: this.draft.headers,
				...(this.draft.body ? { body: this.draft.body } : {})
			},
			this.maskHeaderKeysForCurl()
		);
	});

	/**
	 * The unified Vars table: every var the request will resolve against —
	 * env chain (deepest wins), per-request overrides (highest precedence),
	 * then referenced-but-not-env tokens (chain refs, built-ins, unresolved).
	 * null while any of the three sources is still loading. Orphan overrides
	 * (whose env var no longer exists) surface separately for cleanup.
	 */
	protected readonly varsView = computed<{ rows: UnifiedVarRow[]; orphans: { key: string; valuePlain?: string; isSecret: boolean }[] } | null>(() => {
		const list = this.envVars();
		const overrides = this.overrides();
		if (list === null || overrides === null) return null;

		// Walk the env chain root → leaf so deeper folders overwrite shallower
		// ones — same deepest-wins semantics the resolver uses.
		const map = new Map<string, UnifiedVarRow>();
		for (const env of list) {
			for (const v of env.vars) {
				map.set(v.key, {
					key: v.key,
					value: v.valuePlain ?? '',
					isSecret: v.isSecret,
					source: `${env.folderName} · ${env.envName}`,
					overridden: false,
					kind: 'env'
				});
			}
		}
		// Apply overrides (highest precedence). Track orphans for the section below.
		const orphans: { key: string; valuePlain?: string; isSecret: boolean }[] = [];
		for (const o of overrides) {
			const base = map.get(o.key);
			if (!base) {
				orphans.push(o);
				continue;
			}
			map.set(o.key, {
				key: o.key,
				value: o.isSecret ? '' : (o.valuePlain ?? ''),
				// A row's `isSecret` follows the override — a plaintext override on
				// top of a secret env var displays as plaintext on this request.
				isSecret: o.isSecret,
				source: 'This request',
				overridden: true,
				kind: 'env'
			});
		}
		// Fold in referenced tokens that aren't env vars — chain refs, built-ins,
		// and unresolved `{{x}}` references — so the table covers everything the
		// request actually uses. If an override already exists for an otherwise-
		// unresolved key, fold it into the main row so we don't double-render it
		// as both unresolved AND orphan.
		const refs = this.varDebug();
		if (refs) {
			for (const ref of refs) {
				if (map.has(ref.name)) continue;
				const existingOverride = overrides.find((o) => o.key === ref.name);
				if (existingOverride) {
					map.set(ref.name, {
						key: ref.name,
						value: existingOverride.isSecret ? '' : (existingOverride.valuePlain ?? ''),
						isSecret: existingOverride.isSecret,
						source: 'This request',
						overridden: true,
						// Treat as 'env' so the row gets the editable input + override clear.
						kind: 'env'
					});
					continue;
				}
				const kind: UnifiedVarRow['kind'] = ref.source === 'chain' ? 'chain' : ref.source === 'builtin' ? 'builtin' : 'unresolved';
				map.set(ref.name, {
					key: ref.name,
					value: ref.value ?? '',
					isSecret: Boolean(ref.isSecret),
					source: ref.source ?? 'unresolved',
					overridden: false,
					kind
				});
			}
		}
		return { rows: [...map.values()].sort((a, b) => a.key.localeCompare(b.key)), orphans };
	});

	/**
	 * Scan the request's URL, headers, and body for `{{name}}` tokens — used
	 * to produce a friendlier error than "Invalid URL" when the user fires a
	 * request that has unresolved template variables (almost always because no
	 * env is active in this folder's chain). Chain references and built-ins
	 * are skipped — those aren't fixed by setting an active env.
	 */
	protected readonly unresolvedTokens = computed<string[]>(() => {
		this.draftVersion();
		this.response();
		const found = new Set<string>();
		const TOKEN = /\{\{\s*([^}]+?)\s*\}\}/g;
		const collect = (s: string): void => {
			for (const match of s.matchAll(TOKEN)) {
				const name = match[1]!;
				if (name.includes('.response.')) continue;
				if (name.startsWith('$')) continue;
				found.add(`{{${name}}}`);
			}
		};
		collect(this.draft.url);
		for (const h of this.draft.headers) {
			collect(h.key);
			collect(h.value);
		}
		if (this.draft.body) collect(this.draft.body.raw);
		return [...found];
	});

	protected readonly responseBodyLanguage = computed(() => {
		const r = this.response();
		return r ? responseLanguage(r) : 'plaintext';
	});
	protected readonly responseBodyPreview = computed(() => {
		const r = this.response();
		return r ? responseBodyText(r) : '';
	});
	protected readonly responseHeadersText = computed(() => {
		const r = this.response();
		return r ? responseHeadersPreview(r) : '';
	});

	/**
	 * Curl/HTTPie-style transcript: request lines prefixed with "> ", response
	 * lines with "< ". Reads from sentRequest (the wire-form returned by the
	 * runner) so the transcript shows resolved variables — not the template
	 * the user typed. Falls back to the current draft if a send hasn't
	 * completed yet (e.g. just-loaded tab with a cached response).
	 */
	protected readonly responseRawText = computed(() => {
		const r = this.response();
		if (!r) return '';
		const sent = this.sentRequest();
		const method = (sent?.method ?? this.draft.method).toUpperCase();
		const url = sent?.url ?? this.draft.url;
		const headers = sent?.headers ?? this.draft.headers;
		const body = sent?.body ?? this.draft.body;

		const reqLine = `${method} ${url} HTTP/1.1`;
		const reqHeaders = headers
			.filter((h) => h.key.trim() !== '')
			.map((h) => `${h.key}: ${h.value}`)
			.join('\n');
		const reqBody = body?.raw ?? '';

		if (!r.ok) {
			return [
				`> ${reqLine}`,
				reqHeaders ? `> ${reqHeaders.split('\n').join('\n> ')}` : '',
				reqBody ? `>\n> ${reqBody.split('\n').join('\n> ')}` : '',
				'',
				`< ERROR (${r.category})`,
				`< ${r.message}`
			]
				.filter(Boolean)
				.join('\n');
		}

		const respHeaders = responseHeadersPreview(r);
		const respBody = responseBodyText(r);
		return [
			`> ${reqLine}`,
			reqHeaders ? `> ${reqHeaders.split('\n').join('\n> ')}` : '',
			reqBody ? `>\n> ${reqBody.split('\n').join('\n> ')}` : '',
			'',
			`< HTTP/1.1 ${r.status}`,
			`< ${respHeaders.split('\n').join('\n< ')}`,
			`<`,
			respBody
		].join('\n');
	});

	constructor() {
		// Lazy-load the Vars panel's three data sources whenever the panel is
		// visible and any of them has been invalidated (set back to null after
		// an override mutation or env switch).
		effect(() => {
			if (this.subTab() !== 'vars') return;
			this.ensureVarsLoaded();
		});
	}

	ngOnInit(): void {
		// Apply the persisted splitter height as a CSS var on the host.
		this.host.nativeElement.style.setProperty('--hu-request-pane-height', `${this.requestPaneHeight}px`);
		// Restore last response + which sub-tabs were active for this request
		// from the in-memory session cache — so tab-switching back to a request
		// shows its previous response AND the same sub-tab the user left it on.
		const cached = sessionResponses.get(this.sessionKey());
		if (cached) {
			if (cached.response !== undefined) this.response.set(cached.response);
			if (cached.sentRequest !== undefined) this.sentRequest.set(cached.sentRequest);
			if (cached.subTab !== undefined) this.subTab.set(cached.subTab);
			if (cached.respSubTab !== undefined) this.respSubTab.set(cached.respSubTab);
		}
		void this.loadDraft();
	}

	ngOnDestroy(): void {
		document.removeEventListener('mousemove', this.handleSplitterMove);
		document.removeEventListener('mouseup', this.handleSplitterUp);
		document.body.style.cursor = '';
		document.body.style.userSelect = '';
		// Flush a pending autosave so the trailing edit isn't lost when the user
		// closes the tab or navigates away inside the debounce window.
		if (this.saveTimer !== null) {
			clearTimeout(this.saveTimer);
			this.saveTimer = null;
			void this.save();
		}
	}

	private sessionKey(): string {
		return this.requestId() || this.tabId();
	}

	protected bumpDraft(): void {
		this.draftVersion.update((n) => n + 1);
	}

	private scheduleSave(): void {
		if (this.saveTimer !== null) clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			void this.save();
		}, 500);
	}

	private async save(): Promise<void> {
		const id = this.requestId();
		if (!id) return;
		try {
			const trimmedName = this.draft.name.trim();
			const patch: Record<string, unknown> = {
				// Skip name when empty so we don't overwrite the stored value with
				// a blank — the input stays editable but the persisted name doesn't
				// disappear if the user clears it.
				...(trimmedName !== '' ? { name: trimmedName } : {}),
				method: this.draft.method,
				url: this.draft.url,
				headers: this.draft.headers,
				// Always include chainName so blanking the field actually clears the
				// stored value. `null` is the explicit "clear" signal honored by
				// Repos.Requests.update; `undefined` would be a no-op.
				chainName: this.draft.chainName ?? null
			};
			if (this.draft.body !== undefined) patch.body = this.draft.body;
			if (this.draft.auth !== undefined) patch.auth = this.draft.auth;
			await rpc({ kind: 'request:save', requestId: id, patch });
			// Reflect name changes in the sidebar tree and tab strip without a
			// round-trip — both read from the workspace requests signal.
			if (trimmedName !== '') {
				const list = this.workspace.requests();
				const idx = list.findIndex((r) => r.id === id);
				if (idx >= 0 && list[idx]!.name !== trimmedName) {
					const next = [...list];
					next[idx] = { ...list[idx]!, name: trimmedName };
					this.workspace.setRequests(next);
				}
			}
		} catch (err) {
			// Quiet failure: autosave runs frequently and we don't toast on each.
			console.error('autosave failed:', err);
		}
	}

	private async loadDraft(): Promise<void> {
		const id = this.requestId();
		if (!id) return;
		try {
			const r = await rpc<{
				id: string;
				name: string;
				method: string;
				url: string;
				headers: { key: string; value: string }[];
				bodyText: string;
				bodyKind: string;
				auth: { kind: string; data?: Record<string, string> };
				chainName?: string;
			}>({ kind: 'request:get', requestId: id });
			const next: RequestDraftLocal = {
				name: r.name,
				method: r.method,
				url: r.url,
				headers: r.headers
			};
			if (r.bodyText !== '' || r.bodyKind !== 'none') {
				next.body = { kind: r.bodyKind, raw: r.bodyText };
			}
			if (r.auth) {
				next.auth = r.auth;
			}
			if (r.chainName !== undefined) {
				next.chainName = r.chainName;
			}
			this.draft = next;
			this.bumpDraft();
		} catch (err) {
			console.error('loadDraft failed:', err);
		}
	}

	// === splitter drag ===

	protected handleSplitterDown(e: MouseEvent): void {
		this.dragging = true;
		this.dragStartY = e.clientY;
		this.dragStartHeight = this.requestPaneHeight;
		document.body.style.cursor = 'row-resize';
		document.body.style.userSelect = 'none';
		document.addEventListener('mousemove', this.handleSplitterMove);
		document.addEventListener('mouseup', this.handleSplitterUp);
		e.preventDefault();
	}

	private readonly handleSplitterMove = (e: MouseEvent): void => {
		if (!this.dragging) return;
		const dy = e.clientY - this.dragStartY;
		const newHeight = Math.max(MIN_REQUEST_PANE, this.dragStartHeight + dy);
		this.requestPaneHeight = newHeight;
		// Direct CSS-var update — never re-render during drag, that would
		// dispose & recreate Monaco and lose its selection/scroll/undo state.
		this.host.nativeElement.style.setProperty('--hu-request-pane-height', `${newHeight}px`);
	};

	private readonly handleSplitterUp = (): void => {
		if (!this.dragging) return;
		this.dragging = false;
		document.body.style.cursor = '';
		document.body.style.userSelect = '';
		document.removeEventListener('mousemove', this.handleSplitterMove);
		document.removeEventListener('mouseup', this.handleSplitterUp);
		try {
			localStorage.setItem('hu-request-pane-height', String(this.requestPaneHeight));
		} catch {
			// localStorage may be unavailable (e.g. file:// in some sandboxes).
		}
	};

	// === input handling ===
	// Draft mutations deliberately do NOT bump draftVersion on keystrokes —
	// that would re-evaluate value bindings mid-typing. Structural changes
	// (add/remove row, kind switches) do bump.

	protected onNameInput(value: string): void {
		this.draft.name = value;
		this.scheduleSave();
		this.bumpDraft();
	}

	protected onChainNameInput(value: string): void {
		// Empty string clears the chain name. Persisted as NULL via save().
		// Using delete to keep the property absent under
		// exactOptionalPropertyTypes.
		if (value === '') delete this.draft.chainName;
		else this.draft.chainName = value;
		this.scheduleSave();
	}

	protected onMethodChange(value: string): void {
		this.draft.method = value;
		this.scheduleSave();
	}

	protected onUrlInput(value: string): void {
		this.draft.url = value;
		this.scheduleSave();
		// No refresh on URL keystrokes — the Params panel only needs the parsed
		// URL when the user opens it, and the input already shows the live value.
	}

	protected onBodyKindChange(value: string): void {
		if (value === 'none') {
			delete this.draft.body;
		} else {
			this.draft.body = { kind: value, raw: this.draft.body?.raw ?? '' };
		}
		this.scheduleSave();
		this.bumpDraft();
	}

	protected onBodyEditorChange(value: string): void {
		if (this.draft.body) {
			this.draft.body.raw = value;
			this.scheduleSave();
		}
	}

	protected onAuthKindChange(value: string): void {
		this.draft.auth = { kind: value, data: {} };
		this.scheduleSave();
		this.bumpDraft();
	}

	protected onAuthFieldInput(field: string, value: string): void {
		if (this.draft.auth) {
			this.draft.auth.data = { ...(this.draft.auth.data ?? {}), [field]: value };
			this.scheduleSave();
		}
	}

	protected onKvInput(group: 'params' | 'headers', index: number, field: 'key' | 'value', value: string): void {
		if (group === 'params') {
			// Template-safe — works for both `{{baseUrl}}/x?a=1` and real URLs.
			const { base, params } = splitUrlAtQuery(this.draft.url);
			if (params[index]) {
				params[index][field] = value;
				this.draft.url = joinUrlWithParams(base, params);
				this.scheduleSave();
			}
		} else if (this.draft.headers[index]) {
			this.draft.headers[index][field] = value;
			this.scheduleSave();
		}
	}

	// === sub-tab handling ===

	protected selectSubTab(tab: SubTab): void {
		// When leaving Vars, drop the cached envVars/varDebug so the next visit
		// re-fetches fresh (picks up env-switcher / IPC mutations).
		if (this.subTab() === 'vars' && tab !== 'vars') {
			this.varDebug.set(null);
			this.envVars.set(null);
			this.overrides.set(null);
		}
		this.subTab.set(tab);
		patchSession(this.sessionKey(), { subTab: tab });
	}

	protected selectRespSubTab(tab: RespSubTab): void {
		this.respSubTab.set(tab);
		patchSession(this.sessionKey(), { respSubTab: tab });
	}

	// === send ===

	protected async handleSend(): Promise<void> {
		if (this.sendInFlight()) return;
		this.sendInFlight.set(true);
		try {
			const r = await rpc<RequestSendResult>({
				kind: 'request:send',
				tabId: this.tabId(),
				requestId: this.sessionKey(),
				draftJson: {
					method: this.draft.method,
					url: this.draft.url,
					headers: this.draft.headers,
					...(this.draft.body ? { body: this.draft.body } : {}),
					...(this.draft.auth ? { auth: this.draft.auth } : {})
				}
			});
			this.response.set(r.result);
			this.sentRequest.set(r.sentRequest);
			patchSession(this.sessionKey(), { response: r.result, sentRequest: r.sentRequest });
		} catch (err: unknown) {
			const errResponse: NonNullable<Response> = {
				id: 'err',
				ok: false,
				category: 'unknown',
				message: (err as Error).message
			};
			this.response.set(errResponse);
			this.sentRequest.set(null);
			patchSession(this.sessionKey(), { response: errResponse, sentRequest: null });
		} finally {
			this.sendInFlight.set(false);
		}
	}

	// === KV grid (params / headers) ===

	protected addKVRow(group: 'params' | 'headers'): void {
		if (group === 'headers') {
			this.draft.headers.push({ key: '', value: '' });
		} else {
			const { base, params } = splitUrlAtQuery(this.draft.url);
			params.push({ key: '', value: '' });
			this.draft.url = joinUrlWithParams(base, params);
		}
		this.bumpDraft();
	}

	protected removeKVRow(group: 'params' | 'headers', index: number): void {
		if (group === 'headers') {
			this.draft.headers.splice(index, 1);
		} else {
			const { base, params } = splitUrlAtQuery(this.draft.url);
			params.splice(index, 1);
			this.draft.url = joinUrlWithParams(base, params);
		}
		this.bumpDraft();
	}

	// === cURL ===

	protected async handleCopyCurl(): Promise<void> {
		try {
			await navigator.clipboard.writeText(this.curlText());
		} catch {
			/* clipboard may be unavailable in unusual sandboxes */
		}
	}

	private maskHeaderKeysForCurl(): Set<string> {
		// For v1, mask Authorization. Future: also mask any header whose value
		// is a known secret var.
		return new Set(['authorization']);
	}

	// === vars sub-tab ===

	/** Kicks off any of the three Vars fetches whose cache is invalidated. */
	private ensureVarsLoaded(): void {
		if (this.varDebug() === null && !this.varDebugLoading) {
			this.varDebugLoading = true;
			void this.fetchVarDebug();
		}
		if (this.envVars() === null && !this.envVarsLoading) {
			this.envVarsLoading = true;
			void this.fetchEnvVars();
		}
		if (this.overrides() === null && !this.overridesLoading) {
			this.overridesLoading = true;
			void this.fetchOverrides();
		}
	}

	private async fetchVarDebug(): Promise<void> {
		const id = this.requestId();
		if (!id) {
			this.varDebug.set([]);
			this.varDebugLoading = false;
			return;
		}
		try {
			const r = await rpc<{ refs: VarDebugRow[] }>({ kind: 'var:resolve', requestId: id });
			this.varDebug.set(r.refs);
		} catch (err) {
			console.error('var:resolve failed:', err);
			this.varDebug.set([]);
		} finally {
			this.varDebugLoading = false;
		}
	}

	private async fetchEnvVars(): Promise<void> {
		const id = this.requestId();
		if (!id) {
			this.envVars.set([]);
			this.envVarsLoading = false;
			return;
		}
		try {
			const r = await rpc<{
				chain: {
					scopeKind: 'folder' | 'directory';
					scopeId: string;
					scopeName: string;
					env: { id: string; name: string; isActive: boolean } | null;
				}[];
			}>({ kind: 'env:listForRequest', requestId: id });
			const out: EnvVarsList = [];
			// The chain comes root → leaf so the UI naturally reads outer-to-inner.
			// Only include steps that have an active env — steps without one have
			// nothing to display.
			for (const step of r.chain) {
				if (!step.env) continue;
				const vars = await rpc<{ id: string; key: string; valuePlain?: string; isSecret: boolean }[]>({ kind: 'var:list', envId: step.env.id });
				out.push({ envId: step.env.id, envName: step.env.name, folderName: step.scopeName, vars });
			}
			this.envVars.set(out);
		} catch (err) {
			console.error('env:listForRequest / var:list failed:', err);
			this.envVars.set([]);
		} finally {
			this.envVarsLoading = false;
		}
	}

	private async fetchOverrides(): Promise<void> {
		const id = this.requestId();
		if (!id) {
			this.overrides.set([]);
			this.overridesLoading = false;
			return;
		}
		try {
			const r = await rpc<{ overrides: { key: string; valuePlain?: string; isSecret: boolean }[] }>({ kind: 'request:overrides:list', requestId: id });
			this.overrides.set(r.overrides);
		} catch (err) {
			console.error('request:overrides:list failed:', err);
			this.overrides.set([]);
		} finally {
			this.overridesLoading = false;
		}
	}

	/**
	 * Save (or delete) a var override from the always-on input in the Vars
	 * panel. Empty value → delete the override and revert to the env value.
	 * Fires on the input's change event (i.e. blur or Enter after an edit).
	 */
	protected async saveVarOverride(key: string, kind: 'plain' | 'secret', rawValue: string): Promise<void> {
		const id = this.requestId();
		if (!id) return;
		const value = rawValue.trim();
		try {
			if (value === '') {
				await rpc({ kind: 'request:overrides:delete', requestId: id, key });
			} else if (kind === 'secret') {
				await rpc({ kind: 'request:overrides:set', requestId: id, key, valueSecret: value });
			} else {
				await rpc({ kind: 'request:overrides:set', requestId: id, key, valuePlain: value });
			}
			this.overrides.set(null);
			this.varDebug.set(null);
		} catch (err) {
			console.error('saveVarOverride failed:', err);
		}
	}

	protected async clearOverride(key: string): Promise<void> {
		const id = this.requestId();
		if (!id) return;
		try {
			await rpc({ kind: 'request:overrides:delete', requestId: id, key });
			this.overrides.set(null);
			this.varDebug.set(null);
		} catch (err) {
			console.error('request:overrides:delete failed:', err);
		}
	}

	// === response helpers used by the template ===

	protected openEnvManager(e: Event): void {
		e.preventDefault();
		document.dispatchEvent(new CustomEvent('hu:open-env-manager'));
	}

	protected bodyKindToLanguage(kind: string): string {
		if (kind === 'json' || kind === 'graphql') return 'json';
		return 'plaintext';
	}

	/**
	 * Map HTTP status code to a semantic color from the design tokens. We
	 * reuse the method tokens for 2xx/3xx so the response chrome echoes the
	 * rest of the UI palette without introducing new tokens.
	 */
	protected statusColor(status: number): string {
		if (status >= 200 && status < 300) return 'var(--hu-method-post)';
		if (status >= 300 && status < 400) return 'var(--hu-method-get)';
		if (status >= 400 && status < 500) return 'var(--hu-warning)';
		return 'var(--hu-danger)';
	}

	protected formatBytes(n: number): string {
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
		return `${(n / 1024 / 1024).toFixed(2)} MB`;
	}
}

// === pure helpers ===

function responseBodyText(r: NonNullable<Response>): string {
	if (!r.ok) return `${r.category}: ${r.message}`;
	if (r.bodyBytes.byteLength === 0) return '(empty body)';
	try {
		const text = new TextDecoder().decode(r.bodyBytes);
		if (text.trim() === '') return '(empty body)';
		try {
			return JSON.stringify(JSON.parse(text), null, 2);
		} catch {
			return text;
		}
	} catch {
		return `(binary — ${r.bodyBytes.byteLength} bytes)`;
	}
}

function responseLanguage(r: NonNullable<Response>): string {
	if (!r.ok) return 'plaintext';
	const ct = (r.headers['content-type'] ?? '').toLowerCase();
	if (ct.includes('json')) return 'json';
	if (ct.includes('xml')) return 'xml';
	if (ct.includes('html')) return 'html';
	return 'plaintext';
}

function responseHeadersPreview(r: NonNullable<Response>): string {
	if (!r.ok) return '';
	if (Object.keys(r.headers).length === 0) return '(no headers)';
	return Object.entries(r.headers)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([k, v]) => `${k}: ${v}`)
		.join('\n');
}

// -----------------------------------------------------------------------------
// Template-safe URL/query helpers
// -----------------------------------------------------------------------------
//
// Coax URLs frequently use template syntax like `{{baseUrl}}/api/Guardian`
// which is not a valid URL — `new URL(...)` throws on it. Split the query
// string off manually at the first `?`. Everything before is the base
// (preserved verbatim, including `{{...}}` tokens); everything after is
// `&`-separated key=value pairs. No percent-encoding round-trip: the strings
// the user typed (keys and values, possibly themselves containing template
// tokens) flow through unchanged.

interface ParamRow {
	key: string;
	value: string;
}

function splitUrlAtQuery(url: string): { base: string; params: ParamRow[] } {
	const qIdx = url.indexOf('?');
	if (qIdx === -1) return { base: url, params: [] };
	const base = url.slice(0, qIdx);
	const queryStr = url.slice(qIdx + 1);
	if (queryStr === '') return { base, params: [] };
	const params: ParamRow[] = queryStr.split('&').map((kv) => {
		const eq = kv.indexOf('=');
		if (eq === -1) return { key: kv, value: '' };
		return { key: kv.slice(0, eq), value: kv.slice(eq + 1) };
	});
	return { base, params };
}

function joinUrlWithParams(base: string, params: ParamRow[]): string {
	if (params.length === 0) return base;
	return `${base}?${params.map((p) => `${p.key}=${p.value}`).join('&')}`;
}
