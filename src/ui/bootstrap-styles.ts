// Inject the Coax design-token stylesheet at runtime rather than linking it
// from index.html.
//
// tokens.css ships verbatim via Vite's publicDir (src/ui/public), so `./tokens.css`
// resolves next to index.html in both dev and the packaged app. Injecting it from
// JS keeps Vite's HTML plugin from rewriting the href — an absolute href like
// "/tokens.css" resolves to the filesystem root under file:// in the packaged
// app, which silently drops every token and leaves the UI unstyled.
//
// Angular's default (emulated) view encapsulation is attribute-based rather than
// Shadow DOM, so these global rules reach component templates directly. That is
// why the old `melodic-styles` adoption attribute is gone: there are no shadow
// roots left to adopt stylesheets into.

const link = document.createElement('link');
link.rel = 'stylesheet';
link.href = './tokens.css';
document.head.appendChild(link);
