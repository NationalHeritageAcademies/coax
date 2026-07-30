import type { ResponseEnvelope, ErrorEnvelope } from '@runner/types';

export interface RequestDraft {
  name?: string;
  /**
   * Identifier used by the response-chaining resolver — `# @name foo` in a
   * .http file maps to `chainName: "foo"`. Other requests can then reference
   * its last response via `{{foo.response.body.$.path}}`.
   *
   * `null` is allowed in partial-patch shape only (see `request:save`) to
   * explicitly clear a previously-set chain name. New-create flows should use
   * `undefined`/key-absent for "no chain name".
   */
  chainName?: string | null;
  method: string;
  url: string;
  headers: { key: string; value: string }[];
  body?: { kind: string; raw: string };
  auth?: { kind: string; data?: Record<string, string> };
}

export type IpcRequest =
  | { kind: 'workspace:list' }
  | { kind: 'workspace:open'; folderPath: string }
  | { kind: 'workspace:current' }
  | { kind: 'workspace:pickFolder' }
  | { kind: 'workspace:refresh' }
  | { kind: 'workspace:close' }
  | { kind: 'shell:revealInFolder'; path: string }
  | { kind: 'directory:list'; workspaceId: string }
  | { kind: 'env:listByDirectory'; directoryId: string }
  | { kind: 'directory:create'; workspaceId: string; name: string; parentDirectoryId?: string }
  | { kind: 'directory:rename'; id: string; name: string }
  | { kind: 'directory:delete'; id: string }
  | { kind: 'directory:reparent'; id: string; newParentDirectoryId: string }
  | { kind: 'collection:list'; workspaceId: string }
  | {
      kind: 'collection:create';
      workspaceId: string;
      name: string;
      /** Place into this collection's directory. Mutually exclusive with `directoryId`. */
      parent?: string;
      /** Place directly into this directory. Takes precedence over `parent`. */
      directoryId?: string;
    }
  | { kind: 'collection:rename'; id: string; name: string }
  | { kind: 'collection:reparent'; collectionId: string; newParentCollectionId: string | null }
  | { kind: 'collection:delete'; id: string }
  | { kind: 'collection:export'; collectionId: string; targetPath: string; envId?: string }
  | {
      kind: 'tree:export';
      nodeKind: 'request' | 'collection' | 'directory';
      nodeId: string;
      targetPath: string;
    }
  | { kind: 'request:create'; parent: { collectionId: string; folderId?: string }; draft: RequestDraft }
  | { kind: 'request:save'; requestId: string; patch: Partial<RequestDraft> }
  | { kind: 'request:rename'; requestId: string; name: string }
  | { kind: 'request:delete'; requestId: string }
  | { kind: 'request:duplicate'; requestId: string }
  | { kind: 'request:send'; tabId: string; requestId: string; draftJson?: RequestDraft }
  | { kind: 'request:cancel'; tabId: string }
  | { kind: 'env:list'; folderId: string }
  | { kind: 'env:create'; folderId?: string; directoryId?: string; name: string }
  | { kind: 'env:rename'; envId: string; name: string }
  | { kind: 'env:setActive'; envId: string }
  | { kind: 'env:clearActive'; folderId: string }
  | { kind: 'env:delete'; envId: string }
  | { kind: 'env:listForRequest'; requestId: string }
  | { kind: 'collection:reextractVars'; collectionId: string }
  | { kind: 'var:list'; envId: string }
  | { kind: 'var:create'; envId: string; key: string; valuePlain?: string }
  | { kind: 'var:setPlain'; varId: string; valuePlain: string }
  | { kind: 'var:delete'; varId: string }
  | { kind: 'var:setSecret'; varId: string; plaintext: string }
  | { kind: 'var:revealSecret'; varId: string }
  | { kind: 'var:resolve'; requestId: string }
  | {
      kind: 'http:import';
      path: string;
      /** Anchor on this collection's directory. Mutually exclusive with `directoryId`. */
      parentCollectionId?: string;
      /** Place directly into this directory. Takes precedence over the anchor. */
      directoryId?: string;
    }
  | { kind: 'dialog:openHttp' }
  | { kind: 'dialog:saveHttp'; defaultName?: string }
  | { kind: 'tabs:list' }
  | { kind: 'tabs:saveDraft'; tabId: string; draftJson: RequestDraft }
  | { kind: 'tabs:open'; requestId: string }
  | { kind: 'tabs:close'; tabId: string }
  | { kind: 'folder:list'; collectionId: string }
  | { kind: 'folder:create'; collectionId: string; name: string; parentFolderId?: string }
  | { kind: 'folder:rename'; folderId: string; name: string }
  | { kind: 'folder:delete'; folderId: string }
  | { kind: 'folder:reparent'; folderId: string; newParentFolderId: string }
  | { kind: 'request:list'; collectionId: string }
  | { kind: 'request:get'; requestId: string }
  | { kind: 'folder:sendAll'; folderId: string }
  | { kind: 'request:reparent'; requestId: string; newFolderId: string }
  | { kind: 'request:moveToDirectory'; requestId: string; directoryId: string }
  | { kind: 'request:overrides:list'; requestId: string }
  | { kind: 'request:overrides:set'; requestId: string; key: string; valuePlain?: string; valueSecret?: string }
  | { kind: 'request:overrides:delete'; requestId: string; key: string }
  | { kind: 'dialog:openSwagger' }
  | { kind: 'swagger:fetch'; url: string }
  | {
      kind: 'swagger:import';
      source: { kind: 'file'; path: string } | { kind: 'url'; url: string };
      parentCollectionId?: string;
    }
  | { kind: 'app:settings:get' }
  | {
      kind: 'app:settings:set';
      settings: { allowInsecureTLS?: boolean; hasSeenWelcome?: boolean; autoUpdate?: boolean };
    }
  | { kind: 'app:windowAction'; action: 'zoom' | 'minimize' }
  | { kind: 'app:popupAppMenu'; x: number; y: number }
  | { kind: 'welcome:createSampleWorkspace' }
  | { kind: 'app:quitAndInstall' }
  | { kind: 'app:openExternal'; url: string }
  | { kind: 'app:quit' };

/**
 * App-level user preferences. Persisted as a JSON sidecar in userData.
 * Add fields here as new prefs land; reads are forward-compatible.
 */
export interface AppSettings {
  /**
   * When true, the runner skips TLS cert validation for every request.
   * Intended for self-signed dev certs. Off by default.
   */
  allowInsecureTLS: boolean;
  /** Flipped true on first welcome-dialog dismissal. */
  hasSeenWelcome: boolean;
  /** When true, the app checks for updates on launch. Default true. */
  autoUpdate: boolean;
}

export interface IpcError {
  code: string;
  message: string;
  hint?: string;
}

export type IpcResponse<R = unknown> =
  | { ok: true; data: R }
  | { ok: false; error: IpcError };

// The wire-form of the request as it was actually sent (after variable
// substitution + auth shaping). The renderer uses this in the Raw response
// transcript so what's shown matches what the server received — not the
// pre-resolution draft the user typed.
export interface SentRequest {
  method: string;
  url: string;
  headers: { key: string; value: string }[];
  body?: { kind: string; raw: string };
}

export interface RequestSendResult {
  result: ResponseEnvelope | ErrorEnvelope;
  sentRequest: SentRequest;
}

export interface ExportCollectionResult {
  written: true;
  path: string;
  warnings: { kind: 'literal-auth' | 'literal-secret-leak'; requestId?: string; detail: string }[];
}

export interface FolderSendAllResult {
  results: { requestId: string; result: ResponseEnvelope | ErrorEnvelope }[];
}

export interface ReextractResult {
  envId: string;
  envName: string;
  variablesAdded: number;
  source: string;
}
