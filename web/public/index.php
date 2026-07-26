<?php

declare(strict_types=1);

/*
 * Router guard for PHP's built-in CLI server (`php -S`), which Railway uses
 * as our start command. Without this, the server runs THIS script for every
 * request — including `/assets/css/styles.css` etc. — so static assets get
 * served as 404'd HTML instead of files. Returning false here tells the
 * server "this URI maps to a real file on disk, serve it yourself."
 *
 * Under FPM/Apache (where `.htaccess` rules forward only non-file requests
 * to index.php) `php_sapi_name()` is not `cli-server`, so this is a no-op.
 */
if (PHP_SAPI === 'cli-server') {
    $requested = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?? '/';
    $file = __DIR__ . $requested;
    if ($requested !== '/' && is_file($file)) {
        return false;
    }
}

require_once __DIR__ . '/../vendor/autoload.php';

use Melodic\Core\Application;
use Site\Controllers\CliDocsController;
use Site\Controllers\DocsController;
use Site\Controllers\HomeController;
use Site\Controllers\PrivacyController;
use Site\Providers\AppServiceProvider;

/*
 * Coax marketing site — single entry point.
 *
 * The site is intentionally light: no auth, no DB, no body parsing.
 * MVC routes only. `ErrorHandlerMiddleware` is added by `Application::run()`
 * automatically, so we don't add it explicitly here.
 *
 * Hosted on Railway via Nixpacks → Caddy + PHP-FPM. The web root is
 * `web/public/` (configured in railway.toml).
 */

$app = new Application(__DIR__ . '/..');
$app->loadEnvironmentConfig();
$app->register(new AppServiceProvider());

$app->routes(function ($router) {
    $router->get('/', HomeController::class, 'index');
    $router->get('/privacy', PrivacyController::class, 'index');
    $router->get('/docs', DocsController::class, 'index');
    $router->get('/docs/cli', CliDocsController::class, 'index');
});

$app->run();
