/* =============================================================================
   Coax marketing site — tiny interactive layer
   -----------------------------------------------------------------------------
   This is the only JS that ships. Three jobs:
     1. Theme toggle (light/dark, persisted to localStorage; the initial value
        is already applied by an inline script in the layout to avoid FOUC).
     2. Highlight the moon/sun icon for the current resolved theme.
     3. Update meta theme-color so Safari's title bar matches the chrome.

   No frameworks, no transpilation, no build step. Plain ES2020.
   ============================================================================= */

(function () {
	'use strict';

	const STORAGE_KEY = 'coax-theme';
	const root = document.documentElement;
	const toggle = document.getElementById('theme-toggle');

	function currentTheme() {
		return root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
	}

	function setTheme(theme) {
		const next = theme === 'light' ? 'light' : 'dark';
		root.setAttribute('data-theme', next);
		try {
			localStorage.setItem(STORAGE_KEY, next);
		} catch (_) { /* private mode */ }
		paintIcon(next);
		setMetaThemeColor(next);
	}

	function paintIcon(theme) {
		if (!toggle) return;
		const moon = toggle.querySelector('.theme-icon--moon');
		const sun = toggle.querySelector('.theme-icon--sun');
		if (!moon || !sun) return;
		// Show the OPPOSITE-state icon (the action the click would take).
		if (theme === 'dark') {
			moon.style.display = '';
			sun.style.display = 'none';
		} else {
			moon.style.display = 'none';
			sun.style.display = '';
		}
	}

	function setMetaThemeColor(theme) {
		let meta = document.querySelector('meta[name="theme-color"]');
		if (!meta) {
			meta = document.createElement('meta');
			meta.setAttribute('name', 'theme-color');
			document.head.appendChild(meta);
		}
		meta.setAttribute('content', theme === 'light' ? '#ffffff' : '#0a1020');
	}

	if (toggle) {
		toggle.addEventListener('click', () => {
			setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
		});
	}

	// Sync icon + theme-color to whatever the FOUC-prevention script applied.
	paintIcon(currentTheme());
	setMetaThemeColor(currentTheme());

	// If the user hasn't set an explicit preference, follow the OS as it changes.
	const mq = window.matchMedia('(prefers-color-scheme: light)');
	if (mq && typeof mq.addEventListener === 'function') {
		mq.addEventListener('change', (e) => {
			try {
				if (localStorage.getItem(STORAGE_KEY)) return; // user has chosen explicitly
			} catch (_) { /* private mode — fall through */ }
			setTheme(e.matches ? 'light' : 'dark');
		});
	}

	/* -------------------------------------------------------------------------
	   Docs scrollspy — highlight the sidebar link for the section in view.
	   No-op on pages without a docs sidebar. Uses IntersectionObserver so it
	   costs nothing while idle.
	   ----------------------------------------------------------------------- */
	(function docsScrollspy() {
		const nav = document.querySelector('.docs-nav');
		if (!nav || typeof IntersectionObserver !== 'function') return;

		const links = new Map(); // id -> anchor element
		nav.querySelectorAll('a[href^="#"]').forEach((a) => {
			links.set(a.getAttribute('href').slice(1), a);
		});

		const headings = Array.from(document.querySelectorAll('.docs__content [id]'))
			.filter((el) => links.has(el.id));
		if (headings.length === 0) return;

		const visible = new Set();

		function highlight() {
			// Pick the topmost heading currently intersecting; if none are
			// (between sections), keep the last one above the viewport.
			let activeId = null;
			if (visible.size > 0) {
				activeId = headings.find((h) => visible.has(h.id))?.id ?? null;
			} else {
				for (const h of headings) {
					if (h.getBoundingClientRect().top < 120) activeId = h.id;
				}
			}
			links.forEach((a, id) => a.classList.toggle('is-active', id === activeId));
		}

		const observer = new IntersectionObserver((entries) => {
			for (const entry of entries) {
				if (entry.isIntersecting) visible.add(entry.target.id);
				else visible.delete(entry.target.id);
			}
			highlight();
		}, {
			// Trip as a heading crosses the upper third of the viewport.
			rootMargin: '-80px 0px -70% 0px',
			threshold: 0,
		});

		headings.forEach((h) => observer.observe(h));
		highlight();
	})();

	/* -------------------------------------------------------------------------
	   Hero download button — point it straight at the visitor's platform
	   binary so one click starts the download. macOS + Windows only (a single
	   universal/installer artifact each); Linux keeps the in-page chooser
	   since arch + package format vary. Progressive: with JS off, the button
	   just scrolls to the #download section.
	   ----------------------------------------------------------------------- */
	(function heroDownload() {
		const btn = document.getElementById('hero-download');
		if (!btn) return;
		const ua = navigator.userAgent || '';
		const platform = navigator.platform || '';
		let url = null;
		let os = null;
		if (/Mac/.test(platform) || /Mac OS X/.test(ua)) {
			url = btn.getAttribute('data-dl-macos');
			os = 'macOS';
		} else if (/Win/.test(platform) || /Windows/.test(ua)) {
			url = btn.getAttribute('data-dl-windows');
			os = 'Windows';
		}
		if (!url) return; // Linux / unknown → leave the #download anchor in place
		btn.setAttribute('href', url);
		const label = btn.querySelector('.hero-download__label');
		if (label) label.textContent = 'Download for ' + os;
	})();
})();
