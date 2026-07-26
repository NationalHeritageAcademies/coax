<?php

declare(strict_types=1);

namespace Site\Controllers;

use Melodic\Controller\MvcController;
use Melodic\Core\Application;
use Melodic\Http\Response;

class HomeController extends MvcController
{
    public function __construct(\Melodic\View\ViewEngine $viewEngine, private readonly Application $app)
    {
        parent::__construct($viewEngine);
    }

    public function index(): Response
    {
        $this->setLayout('layouts/main');

        $this->viewBag->title = 'Coax — Your API workspace is just a .http file';
        // Kept under 160 chars so Google + social previews don't truncate.
        $this->viewBag->description = 'Coax is a free, open-source desktop app for .http files. ' .
            'Chain requests, run them in CI, encrypt secrets, keep your data local. MIT licensed.';
        $this->viewBag->canonical = 'https://' . $this->app->config('app.domain', 'coax.melodic.dev') . '/';

        return $this->view('home/index', [
            'config' => $this->app->getConfiguration()->all(),
        ]);
    }
}
