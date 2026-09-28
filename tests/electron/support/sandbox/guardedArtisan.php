<?php

declare(strict_types=1);

/**
 * `php guardedArtisan.php <backend-root> migrate`
 * `php guardedArtisan.php <backend-root> db:seed <SeederClass>`
 *
 * Runs one whitelisted artisan write against a disposable SQLite backend, in the same process that
 * has just verified the resolved connection (see `laravelSandboxGuard.php`). There is no generic
 * pass-through: a command outside this list is refused before Laravel loads.
 */

require __DIR__ . '/laravelSandboxGuard.php';

$backendRoot = $argv[1] ?? '';
$command = $argv[2] ?? '';

if ($backendRoot === '' || ! is_file($backendRoot . '/artisan')) {
    sandboxRefuse('the backend root is missing');
}

$parameters = match ($command) {
    'migrate' => ['--force' => true],
    'db:seed' => preg_match('/^[A-Z][A-Za-z0-9]*Seeder$/', $argv[3] ?? '') === 1
        ? ['--class' => $argv[3], '--force' => true]
        : sandboxRefuse('db:seed needs one seeder class name'),
    // PS7's fixture command writes its JSON beside the sandbox database and nowhere else.
    'ps7:seed-physical-presence-fixture' => str_starts_with($argv[3] ?? '', DIRECTORY_SEPARATOR)
        && dirname($argv[3]) === dirname((string) getenv('POS_SANDBOX_EXPECTED_DB'))
        ? ['path' => $argv[3]]
        : sandboxRefuse('the fixture path must be inside the sandbox directory'),
    default => sandboxRefuse('the command is not on the guarded whitelist'),
};

// Refuses (exit 3) before any write unless the resolved connection is the approved sandbox file.
$app = sandboxBootstrap($backendRoot);
$kernel = $app->make(\Illuminate\Contracts\Console\Kernel::class);
$status = $kernel->call($command, $parameters);

fwrite(STDOUT, $kernel->output());
exit($status);
