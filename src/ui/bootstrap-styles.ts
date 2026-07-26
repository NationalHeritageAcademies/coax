// Inject the two Melodic-tagged stylesheets at runtime instead of placing them
// in index.html. Two production-only failure modes force this:
//   (1) An absolute href like "/melodic-components.css" resolves to the
//       filesystem root under file:// in the packaged app, not the renderer
//       directory, so all melodic styles (including Phosphor @font-face) fail
//       to load — leaving every icon rendered as a tofu box.
//   (2) A relative href like "./tokens.css" is processed by Vite's HTML
//       plugin, which inlines tokens.css into the bundled CSS and removes the
//       <link>. That strips the `melodic-styles` attribute, so the rules are
//       never adopted into component shadow roots and class-based styles
//       (.hu-icon-btn, .hu-tree-row, etc.) silently disappear.
// Appending the links from JS sidesteps Vite entirely and keeps a single
// codepath that works in both dev and the packaged build.

const stylesheets = [
  './melodic-components.css', // copied to renderer root by viteStaticCopy
  './tokens.css', // copied verbatim from src/ui/public
];

for (const href of stylesheets) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.setAttribute('melodic-styles', '');
  link.href = href;
  document.head.appendChild(link);
}
