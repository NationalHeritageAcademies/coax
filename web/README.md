# Coax marketing site

The public-facing site that lives at **getcoax.com** (TBD), built on
[Melodic PHP](https://github.com/MelodicDevelopment/melodic-php). Visual identity
mirrors the desktop app's design tokens line-for-line — same Inter + JetBrains
Mono fonts, same blue brand, same dark-card icon aesthetic.

MIT licensed — see the top-level `LICENSE` file.

## Run locally

```bash
cd web
composer install
php -S localhost:8080 -t public
```

Visit http://localhost:8080.

`composer install` writes `vendor/` (gitignored). The `melodicdev/framework`
package is pulled from Packagist.

## File layout

```
config/                Base + per-env JSON config (config.dev.json gitignored)
public/                Web root — point Apache / Caddy / Railway here
  index.php            Single entry point
  .htaccess            Apache pretty-URL rewrites
  assets/              CSS, JS, images, favicons (served directly)
src/
  Controllers/         HomeController, PrivacyController (MvcController subclasses)
  Providers/           AppServiceProvider (wires the ViewEngine)
views/
  layouts/main.phtml   Shared header/footer + meta + theme-toggle script
  home/index.phtml     Landing page (hero, why, features, compare, download, FAQ, CTA)
  privacy/index.phtml  Privacy doc (mirror of docs/privacy.md in the parent repo)
  partials/            Shared SVG glyphs
storage/               Logs + cache (gitignored)
railway.toml           Railway deploy config
nixpacks.toml          Build steps (PHP 8.2 + Composer)
```

## Deploy (Railway)

1. Create a new Railway project, connect it to the `MelodicDevelopment/coax`
   GitHub repo.
2. In the service settings, set **Root Directory** to `web/` so the build
   doesn't try to build the Electron app.
3. Railway picks up `railway.toml` + `nixpacks.toml` automatically. The
   default start command is `php -S 0.0.0.0:$PORT -t public public/index.php`.
4. Add a custom domain in Railway → DNS → CNAME pointing at the Railway
   endpoint. Railway provisions Let's Encrypt automatically.

## Customizing the brand

Site styling lives entirely in `public/assets/css/styles.css`. The token block
at the top mirrors the desktop app's `src/ui/public/tokens.css`. If you change
the brand color in one place, change it in the other so they stay in sync.

The brand glyph is `views/partials/_brand-glyph.svg` for the header (32×32
viewport) and `_hero-glyph.svg` for the hero (64×64). Both reference the same
blue → cyan gradient. The favicon (`public/favicon.ico` + the SVG and Apple
touch icon under `assets/img/`) is generated from `build/icon.svg` in the
parent repo via `scripts/generate-icons.py`.

## Privacy

The site ships zero analytics, zero trackers, zero cookies. If we ever
add analytics, we'll wire in a privacy-respecting option (e.g. Cloudflare
Web Analytics or self-hosted Umami) — not Google Analytics.
