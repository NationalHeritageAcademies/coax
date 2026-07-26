export interface ResolverScopes {
  /**
   * Inline / per-request overrides. Take precedence over the env chain.
   */
  request?: Record<string, string>;
  /**
   * The folder-chain env vars, flattened root → leaf with deepest-wins
   * already applied. Build via Repos.Envs.listForRequest and merging
   * variables from outer folder to inner (current request's parent
   * folder last) so deeper folders override shallower ones.
   */
  chainFlat?: Record<string, string>;
  /**
   * Collection-level fallback (e.g. `# @key = value` lines at the top of
   * a .http file). Lowest priority — only used when nothing in the chain
   * defined the key.
   */
  collectionDefaults?: Record<string, string>;
}
export interface ResolverContext {
  scopes: ResolverScopes;
  responses?: Record<string, { body: unknown; headers: Record<string, string>; status: number }>;
  now?: () => Date;
  random?: () => number;
}
export interface ResolveResult {
  text: string;
  unresolved: string[]; // unique list of {{var}} references that did not resolve
}
