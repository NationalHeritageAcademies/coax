<?php

declare(strict_types=1);

namespace Site\Controllers;

use Melodic\Controller\MvcController;
use Melodic\Core\Application;
use Melodic\Http\Response;

class DocsController extends MvcController
{
    public function __construct(\Melodic\View\ViewEngine $viewEngine, private readonly Application $app)
    {
        parent::__construct($viewEngine);
    }

    public function index(): Response
    {
        $this->setLayout('layouts/main');

        $this->viewBag->title = 'Coax docs — desktop app & CLI guide';
        $this->viewBag->description = 'How to use Coax: import and send requests, chain responses, manage ' .
            'variables and secrets, and run .http files headlessly with the CLI.';
        $this->viewBag->canonical = 'https://' . $this->app->config('app.domain', 'coax.melodic.dev') . '/docs';

        return $this->view('docs/index', [
            'config' => $this->app->getConfiguration()->all(),
        ]);
    }
}
