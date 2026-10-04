<?php

declare(strict_types=1);

/**
 * Router for `php -S` that guards EVERY HTTP request a journey sends to the disposable backend
 * (`POS_SANDBOX_GUARD_HTTP=1` in tests/playwright/support/sandbox.mjs).
 *
 * `php artisan serve` cannot verify which database the serving process resolved, and a prepend that
 * boots the console kernel would break boot (`public/index.php` uses `require_once` on the same
 * bootstrap file). So this router replaces `public/index.php` for the request instead. In the serving
 * process, for each request (the built-in server runs a fresh script context per request):
 *   1. `sandboxPreflight()` — environment and file identity (refuses thinis_pos, thinis_pos_testing,
 *      repository paths, ~/.config/pos-desktop, a config cache);
 *   2. an existing NON-PHP static asset under public/ is served as-is (never `.php`, never index.php);
 *   3. the application is bootstrapped through its HTTP kernel, and the RESOLVED connection of that very
 *      instance is checked (not cached, testing, sqlite, configured and active database = the approved
 *      file) before the request is handled;
 *   4. the request is handled by that same instance.
 * Any refusal answers 503 and exits before routing. The developer's own `public/hot` (a running Vite
 * dev server) is ignored for this process, so built assets are served.
 */

if (! defined('STDERR')) {
    define('STDERR', fopen('php://stderr', 'wb'));
}

http_response_code(503);
header('Content-Type: application/json');

require __DIR__ . '/laravelSandboxGuard.php';

$backendRoot = getenv('POS_SANDBOX_BACKEND_ROOT');

if (! is_string($backendRoot) || $backendRoot === '' || ! is_file($backendRoot . '/artisan')) {
    sandboxRefuse('POS_SANDBOX_BACKEND_ROOT must name the backend');
}

$approved = sandboxPreflight($backendRoot);

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$static = realpath($backendRoot . '/public' . $path);
$assetExtensions = ['css', 'js', 'mjs', 'map', 'json', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'woff', 'woff2', 'ttf', 'txt'];

if ($static !== false && is_file($static) && sandboxPathIsInside($static, realpath($backendRoot . '/public'))
    && in_array(strtolower(pathinfo($static, PATHINFO_EXTENSION)), $assetExtensions, true)) {
    header_remove('Content-Type');
    http_response_code(200);

    return false;
}

if (file_exists($maintenance = $backendRoot . '/storage/framework/maintenance.php')) {
    require $maintenance;
}

require $backendRoot . '/vendor/autoload.php';
$app = require $backendRoot . '/bootstrap/app.php';
$app->make(Illuminate\Contracts\Http\Kernel::class)->bootstrap();

$connection = $app->make('db')->connection();
$configured = $connection->getConfig('database');
$active = $connection->getDatabaseName();

if (
    $app->configurationIsCached()
    || ! $app->environment('testing')
    || $connection->getDriverName() !== 'sqlite'
    || ! is_string($configured) || @realpath($configured) !== $approved['database']
    || ! is_string($active) || @realpath($active) !== $approved['database']
    || sandboxForbiddenName($configured)
) {
    sandboxRefuse('the HTTP application resolved a connection other than the approved sandbox database');
}

$app->make(Illuminate\Foundation\Vite::class)->useHotFile($approved['sandbox'] . '/no-vite-hot-file');

header_remove('Content-Type');
http_response_code(200);

$app->handleRequest(Illuminate\Http\Request::capture());
