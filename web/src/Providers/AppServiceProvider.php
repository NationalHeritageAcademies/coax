<?php

declare(strict_types=1);

namespace Site\Providers;

use Melodic\Cache\ArrayCache;
use Melodic\Core\Application;
use Melodic\DI\Container;
use Melodic\DI\ServiceProvider;
use Melodic\View\ViewEngine;

/**
 * Wires the marketing site's only real dependency: the ViewEngine,
 * pointed at `<basePath>/views`. We use ArrayCache rather than FileCache
 * because the templates are static at deploy time and the site has zero
 * dynamic content — re-rendering on every request is essentially free.
 *
 * Container API note: the framework exposes `bind()` and `singleton()` —
 * both accept a class name OR a callable. Use `singleton()` for the view
 * engine so the same instance is shared across requests in the same process.
 */
class AppServiceProvider extends ServiceProvider
{
    public function register(Container $container): void
    {
        $container->singleton(ViewEngine::class, function () use ($container): ViewEngine {
            /** @var Application $app */
            $app = $container->get(Application::class);

            return new ViewEngine(
                viewsPath: $app->getBasePath() . '/views',
                cache: new ArrayCache(),
            );
        });
    }

    public function boot(Container $container): void
    {
        // No post-registration work needed yet.
    }
}
