<?php

declare(strict_types=1);

/**
 * The one gate every disposable-backend write in this repository passes through before it touches a
 * database (`guardedArtisan.php`, `guiFixture.php`).
 *
 * It runs in the SAME PHP process that performs the write. A probe in a separate process proves only
 * what that other process resolved; a cached config, a different working directory or a changed
 * environment could still send the write elsewhere. Here the assertion and the write share one
 * booted application, one resolved connection and one configuration.
 *
 * Two stages, and a refusal at either stops the process before any write:
 *
 *  1. **Before Laravel loads** (plain `getenv`, no autoloader): the environment must name exactly the
 *     approved sandbox file. A missing or mismatched selection never gets as far as `.env`.
 *  2. **After Laravel boots**: the connection Laravel actually resolved must be that same file.
 *
 * Refused outright, whatever the environment says:
 *  - the business databases `thinis_pos` and `thinis_pos_testing`, by name or file stem;
 *  - any database inside the backend or desktop repository (e.g. `database/database.sqlite`);
 *  - any path under a real workstation profile (`~/.config/pos-desktop`);
 *  - any file outside the system temporary directory, a symlink, or a non-SQLite connection;
 *  - a Laravel configuration cache — `APP_CONFIG_CACHE` must point at a not-yet-existing file inside
 *    the sandbox, so `bootstrap/cache/config.php` can never redirect the connection.
 */

const SANDBOX_FORBIDDEN_DATABASE_NAMES = ['thinis_pos', 'thinis_pos_testing'];

function sandboxRefuse(string $reason): never
{
    fwrite(STDERR, "sandbox guard refused: {$reason}\n");
    exit(3);
}

function sandboxPathIsInside(string $path, string $root): bool
{
    $root = rtrim($root, DIRECTORY_SEPARATOR);

    return $path === $root || str_starts_with($path, $root . DIRECTORY_SEPARATOR);
}

function sandboxForbiddenName(string $value): bool
{
    $stem = strtolower(pathinfo($value, PATHINFO_FILENAME));

    return in_array(strtolower($value), SANDBOX_FORBIDDEN_DATABASE_NAMES, true)
        || in_array($stem, SANDBOX_FORBIDDEN_DATABASE_NAMES, true);
}

/**
 * Stage 1. Pure environment checks; nothing from the backend is loaded yet.
 *
 * @return array{database: string, sandbox: string}
 */
function sandboxPreflight(string $backendRoot): array
{
    $expected = getenv('POS_SANDBOX_EXPECTED_DB');

    if (! is_string($expected) || $expected === '') {
        sandboxRefuse('POS_SANDBOX_EXPECTED_DB is not set');
    }

    if (getenv('APP_ENV') !== 'testing') {
        sandboxRefuse('APP_ENV is not testing');
    }

    if (getenv('DB_CONNECTION') !== 'sqlite') {
        sandboxRefuse('DB_CONNECTION is not sqlite');
    }

    $url = getenv('DB_URL');

    if (is_string($url) && $url !== '') {
        sandboxRefuse('DB_URL is set and would override the selected database');
    }

    $selected = getenv('DB_DATABASE');

    if (! is_string($selected) || $selected === '') {
        sandboxRefuse('DB_DATABASE is not set');
    }

    if (sandboxForbiddenName($selected) || sandboxForbiddenName($expected)) {
        sandboxRefuse('the selected database is a business database');
    }

    if ($selected !== $expected) {
        sandboxRefuse('DB_DATABASE does not match the approved sandbox database');
    }

    if (! str_starts_with($expected, DIRECTORY_SEPARATOR) || is_link($expected) || ! is_file($expected)) {
        sandboxRefuse('the approved sandbox database is not an existing regular file');
    }

    $database = realpath($expected);
    $temporaryRoot = realpath(sys_get_temp_dir());

    if ($database === false || $temporaryRoot === false || $database !== $expected) {
        sandboxRefuse('the approved sandbox database path is not canonical');
    }

    if (! sandboxPathIsInside($database, $temporaryRoot)) {
        sandboxRefuse('the approved sandbox database is outside the system temporary directory');
    }

    $resolvedBackendRoot = realpath($backendRoot);
    $desktopRoot = realpath(dirname(__DIR__, 4));

    foreach ([$resolvedBackendRoot, $desktopRoot] as $repository) {
        if ($repository !== false && sandboxPathIsInside($database, $repository)) {
            sandboxRefuse('the approved sandbox database is inside a repository');
        }
    }

    $home = getenv('HOME');

    if (is_string($home) && $home !== '' && str_contains($database, rtrim($home, '/') . '/.config/pos-desktop')) {
        sandboxRefuse('the approved sandbox database is inside a real workstation profile');
    }

    $sandbox = dirname($database);
    $configCache = getenv('APP_CONFIG_CACHE');

    if (! is_string($configCache) || $configCache === '' || ! str_starts_with($configCache, DIRECTORY_SEPARATOR)) {
        sandboxRefuse('APP_CONFIG_CACHE must name an isolated file inside the sandbox');
    }

    if (dirname($configCache) !== $sandbox) {
        sandboxRefuse('APP_CONFIG_CACHE is not inside the sandbox directory');
    }

    if (file_exists($configCache) || is_link($configCache)) {
        sandboxRefuse('a Laravel configuration cache exists in the sandbox');
    }

    return ['database' => $database, 'sandbox' => $sandbox];
}

/**
 * Stage 2. Boots the backend console kernel and verifies the connection it actually resolved.
 */
function sandboxBootstrap(string $backendRoot): object
{
    $approved = sandboxPreflight($backendRoot);

    require $backendRoot . '/vendor/autoload.php';
    $app = require $backendRoot . '/bootstrap/app.php';
    $app->make(\Illuminate\Contracts\Console\Kernel::class)->bootstrap();

    $connection = $app->make('db')->connection();
    $configured = $connection->getConfig('database');
    $active = $connection->getDatabaseName();

    if (
        $app->configurationIsCached()
        || ! $app->environment('testing')
        || config('app.env') !== 'testing'
        || config('database.default') !== 'sqlite'
        || $connection->getDriverName() !== 'sqlite'
        || ! is_string($configured) || @realpath($configured) !== $approved['database']
        || ! is_string($active) || @realpath($active) !== $approved['database']
        || sandboxForbiddenName($configured)
    ) {
        sandboxRefuse('the resolved Laravel connection is not the approved sandbox database');
    }

    return $app;
}
