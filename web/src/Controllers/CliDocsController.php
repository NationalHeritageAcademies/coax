<?php

declare(strict_types=1);

namespace Site\Controllers;

use Melodic\Controller\MvcController;
use Melodic\Core\Application;
use Melodic\Http\Response;

/**
 * The standalone CLI reference was folded into the unified `/docs` page
 * (its content now lives under the "Command-line (CLI)" section). This
 * controller keeps the old `/docs/cli` URL — still linked from the footer,
 * the sitemap, and any inbound links — alive with a permanent redirect to
 * the in-page anchor.
 */
class CliDocsController extends MvcController
{
    public function __construct(\Melodic\View\ViewEngine $viewEngine, private readonly Application $app)
    {
        parent::__construct($viewEngine);
    }

    public function index(): Response
    {
        return (new Response())
            ->withStatus(301)
            ->withHeader('Location', '/docs#cli');
    }
}
