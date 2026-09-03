<?php

/**
 * CP-3G-5 live-backend fixture seeder.
 *
 * This script is intentionally unusable without the private per-run contract established by
 * scripts/cp3g5LiveUpload.mjs. All filesystem and environment checks happen before Laravel is
 * loaded; Laravel's resolved connection is checked again before the first fixture write.
 *
 * Usage (authorized parent only): php seedLiveBackend.php <backend-root> <count>
 */

use App\Models\User;
use App\Modules\Catalog\Enums\ProductTaxMode;
use App\Modules\Catalog\Models\DesktopCatalogContract;
use App\Modules\Catalog\Models\Product;
use App\Modules\Catalog\Services\SellableProductResolver;
use App\Modules\Devices\Data\DesktopDeviceContext;
use App\Modules\Devices\Models\DesktopAccessToken;
use App\Modules\Devices\Models\DesktopDevice;
use App\Modules\Identity\Enums\SystemRole;
use App\Modules\Inventory\Models\StockItem;
use App\Modules\Inventory\Services\StockAllocationService;
use App\Modules\Payments\Models\PaymentMethod;
use App\Modules\Shifts\Models\Shift;
use App\Modules\Subscriptions\Models\CompanySubscription;
use App\Modules\Tenancy\Enums\IsoCurrency;
use App\Modules\Tenancy\Models\Branch;
use App\Modules\Tenancy\Models\Company;
use App\Modules\Tenancy\Models\Warehouse;
use App\Shared\Data\AccessDecision;
use App\Shared\Enums\AccessDecisionLevel;
use Carbon\CarbonImmutable;
use Illuminate\Contracts\Console\Kernel;
use Illuminate\Support\Str;

const CP3G5_DATABASE_FILENAME = 'cp3g5-backend.sqlite';
const CP3G5_MARKER_FILENAME = '.cp3g5-harness';
const CP3G5_RESPONSE_FILENAME = 'cp3g5-fixture.json';

ini_set('display_errors', '0');
ob_start();

/*
 * CP-3G-7 F2 diagnostics.
 *
 * The wrapper discards this process's stdout and stderr by design, so a failure used to surface
 * only as an exit status. These globals carry the *lifecycle position* of the seeder, and
 * `cp3g5Diagnostic()` emits one strictly whitelisted line so the wrapper can say which operation
 * failed without ever forwarding child output.
 *
 * Nothing here may ever carry a token, a token hash, a payload body, a SQL binding, a payment
 * reference, a credential, customer data or fixture contents. Only enum-like phase/operation
 * names, an exception class name, a SQLSTATE, a driver error code and a bare
 * `table.column`-shaped identifier are ever emitted, and every one is re-validated by the wrapper.
 */
$cp3g5Phase = 'authorization';
$cp3g5Operation = 'startup';
$cp3g5Iteration = -1;

/**
 * Emit exactly one whitelisted diagnostic line. Values are shape-constrained at the source.
 *
 * Silent unless the authorized wrapper switched the channel on. An unauthorized direct invocation
 * therefore still produces exactly the single low-information rejection line that CP-3G-5 froze:
 * diagnostics widen what the *harness* can see about itself, never what a caller can learn.
 */
function cp3g5Diagnostic(array $fields): void
{
    global $cp3g5Phase, $cp3g5Operation, $cp3g5Iteration;

    if (getenv('CP3G5_DIAGNOSTICS') !== '1') {
        return;
    }

    $safe = [
        'phase' => $cp3g5Phase,
        'operation' => $cp3g5Operation,
    ];

    if ($cp3g5Iteration >= 0) {
        $safe['iteration'] = $cp3g5Iteration;
    }

    foreach (['code', 'exception', 'sqlstate', 'identifier'] as $key) {
        $value = $fields[$key] ?? null;

        // Identifier-shaped strings only: no spaces, no quotes, no punctuation that could carry a
        // value. A message, a binding or a token cannot survive this filter.
        if (is_string($value) && preg_match('/\A[A-Za-z0-9_.\\\\-]{1,120}\z/D', $value)) {
            $safe[$key] = $value;
        }
    }

    if (isset($fields['driver_code']) && is_int($fields['driver_code'])) {
        $safe['driver_code'] = $fields['driver_code'];
    }

    if (isset($fields['transaction_level']) && is_int($fields['transaction_level'])) {
        $safe['transaction_level'] = $fields['transaction_level'];
    }

    $encoded = @json_encode($safe, JSON_UNESCAPED_SLASHES);

    if (is_string($encoded)) {
        fwrite(STDERR, 'CP3G5-DIAG ' . $encoded . "\n");
    }
}

/**
 * Extract the safest possible identifier from a database exception.
 *
 * Only fixed constraint markers are recognised, and only the `table.column` text that follows one
 * is captured. Every other message shape yields nothing, so no binding, value or free-form text
 * can ever reach the diagnostic line.
 */
function cp3g5DatabaseIdentifier(string $message): ?string
{
    $markers = [
        '/UNIQUE constraint failed: ([A-Za-z0-9_]+\.[A-Za-z0-9_]+)/' => null,
        '/NOT NULL constraint failed: ([A-Za-z0-9_]+\.[A-Za-z0-9_]+)/' => null,
        '/CHECK constraint failed: ([A-Za-z0-9_]+)/' => null,
        '/no such table: ([A-Za-z0-9_]+)/' => null,
        '/no such column: ([A-Za-z0-9_]+\.?[A-Za-z0-9_]*)/' => null,
    ];

    foreach ($markers as $pattern => $_) {
        if (preg_match($pattern, $message, $matches) === 1) {
            return $matches[1];
        }
    }

    foreach ([
        'FOREIGN KEY constraint failed' => 'foreign-key',
        'database is locked' => 'database-locked',
        'database table is locked' => 'table-locked',
        'attempt to write a readonly database' => 'readonly-database',
        'disk I/O error' => 'disk-io-error',
    ] as $needle => $identifier) {
        if (str_contains($message, $needle)) {
            return $identifier;
        }
    }

    return null;
}

/** Exit through one deliberately low-information channel. */
function rejectSeeder(string $reason, string $code = 'rejected'): never
{
    while (ob_get_level() > 0) {
        ob_end_clean();
    }

    cp3g5Diagnostic(['code' => $code]);
    fwrite(STDERR, "CP-3G-5 seeder rejected: {$reason}\n");
    exit(1);
}

/** Read an environment variable without accepting empty values. */
function requiredEnvironment(string $name, string $reason): string
{
    $value = getenv($name);

    if (! is_string($value) || $value === '') {
        rejectSeeder($reason);
    }

    return $value;
}

/** True only when $path is lexically beneath $root. Both inputs are already canonical here. */
function pathIsInside(string $path, string $root): bool
{
    return str_starts_with($path, $root . DIRECTORY_SEPARATOR);
}

/** Validate a non-symlinked regular file and return its canonical path. */
function canonicalRegularFile(string $path, string $reason): string
{
    $stat = @lstat($path);
    $canonical = @realpath($path);

    if ($stat === false || $canonical === false || is_link($path) || ! is_file($path)) {
        rejectSeeder($reason);
    }

    return $canonical;
}

if (getenv('CP3G5_LIVE_HARNESS') !== '1') {
    rejectSeeder('authorization marker missing');
}

if (getenv('APP_ENV') !== 'testing') {
    rejectSeeder('testing environment required');
}

if (getenv('DB_CONNECTION') !== 'sqlite') {
    rejectSeeder('sqlite connection required');
}

$databaseFromEnvironment = requiredEnvironment('DB_DATABASE', 'database path missing');

if ($databaseFromEnvironment === ':memory:' || ! str_starts_with($databaseFromEnvironment, DIRECTORY_SEPARATOR)) {
    rejectSeeder('database path is not an approved absolute file');
}

$temporaryRootFromEnvironment = requiredEnvironment('CP3G5_TEMP_ROOT', 'temporary root missing');
$nonce = requiredEnvironment('CP3G5_RUN_NONCE', 'run nonce missing');
$responseFromEnvironment = requiredEnvironment('CP3G5_RESPONSE_FILE', 'response path missing');

if (! preg_match('/\A[a-f0-9]{64}\z/D', $nonce)) {
    rejectSeeder('run nonce invalid');
}

$temporaryRootStat = @lstat($temporaryRootFromEnvironment);
$temporaryRootPermissions = @fileperms($temporaryRootFromEnvironment);
$temporaryRoot = @realpath($temporaryRootFromEnvironment);
$systemTemporaryRoot = @realpath(sys_get_temp_dir());

if (
    $temporaryRootStat === false
    || $temporaryRoot === false
    || $systemTemporaryRoot === false
    || is_link($temporaryRootFromEnvironment)
    || ! is_dir($temporaryRootFromEnvironment)
    || $temporaryRootPermissions === false
    || ($temporaryRootPermissions & 0777) !== 0700
    || $temporaryRoot !== $temporaryRootFromEnvironment
    || dirname($temporaryRoot) !== $systemTemporaryRoot
    || ! preg_match('/\Apos-desktop-cp3g5-[A-Za-z0-9]+\z/D', basename($temporaryRoot))
) {
    rejectSeeder('temporary root is not approved');
}

$expectedDatabase = $temporaryRoot . DIRECTORY_SEPARATOR . CP3G5_DATABASE_FILENAME;
$expectedMarker = $temporaryRoot . DIRECTORY_SEPARATOR . CP3G5_MARKER_FILENAME;
$expectedResponse = $temporaryRoot . DIRECTORY_SEPARATOR . CP3G5_RESPONSE_FILENAME;

if ($databaseFromEnvironment !== $expectedDatabase) {
    rejectSeeder('database path is outside the approved root');
}

if ($responseFromEnvironment !== $expectedResponse || file_exists($expectedResponse) || is_link($expectedResponse)) {
    rejectSeeder('response path is not approved');
}

$databasePath = canonicalRegularFile($databaseFromEnvironment, 'database file is not approved');

if ($databasePath !== $expectedDatabase || ! pathIsInside($databasePath, $temporaryRoot)) {
    rejectSeeder('database path is outside the approved root');
}

$markerPath = canonicalRegularFile($expectedMarker, 'authorization marker file missing');
$markerPermissions = @fileperms($markerPath);
$markerContents = @file_get_contents($markerPath);

if (
    $markerPath !== $expectedMarker
    || ! pathIsInside($markerPath, $temporaryRoot)
    || $markerPermissions === false
    || ($markerPermissions & 0777) !== 0600
    || ! is_string($markerContents)
    || ! hash_equals($nonce . "\n", $markerContents)
) {
    rejectSeeder('authorization marker file invalid');
}

$backendRootFromArgument = $argv[1] ?? '';
$backendRoot = @realpath($backendRootFromArgument);
$desktopRoot = realpath(dirname(__DIR__, 4));

if (
    $backendRoot === false
    || $backendRoot !== $backendRootFromArgument
    || ! is_dir($backendRoot)
    || ! is_file($backendRoot . '/vendor/autoload.php')
    || ! is_file($backendRoot . '/bootstrap/app.php')
) {
    rejectSeeder('backend root is not approved');
}

if (pathIsInside($databasePath, $backendRoot) || ($desktopRoot !== false && pathIsInside($databasePath, $desktopRoot))) {
    rejectSeeder('database path targets a repository');
}

$connection = null;
$responseHandle = null;

try {
    $cp3g5Phase = 'laravel-bootstrap';
    $cp3g5Operation = 'autoload-and-bootstrap';

    require $backendRoot . '/vendor/autoload.php';
    $app = require $backendRoot . '/bootstrap/app.php';
    $app->make(Kernel::class)->bootstrap();

    $cp3g5Phase = 'post-bootstrap-check';
    $cp3g5Operation = 'connection-verification';

    $connection = $app->make('db')->connection();
    $configuredDatabase = $connection->getConfig('database');
    $activeDatabase = $connection->getDatabaseName();
    $canonicalConfiguredDatabase = is_string($configuredDatabase) ? @realpath($configuredDatabase) : false;
    $canonicalActiveDatabase = is_string($activeDatabase) ? @realpath($activeDatabase) : false;

    if (
        ! $app->environment('testing')
        || config('app.env') !== 'testing'
        || config('database.default') !== 'sqlite'
        || $connection->getDriverName() !== 'sqlite'
        || $canonicalConfiguredDatabase !== $databasePath
        || $canonicalActiveDatabase !== $databasePath
    ) {
        rejectSeeder('active Laravel database differs from the approved file');
    }

    $mintCount = filter_var($argv[2] ?? 12, FILTER_VALIDATE_INT, [
        'options' => ['min_range' => 1, 'max_range' => 100],
    ]);

    if ($mintCount === false) {
        rejectSeeder('fixture count invalid');
    }

    $cp3g5Phase = 'fixture-write';
    $cp3g5Operation = 'response-reservation';

    $responseHandle = @fopen($expectedResponse, 'x');

    if (
        $responseHandle === false
        || ! @chmod($expectedResponse, 0600)
        || is_link($expectedResponse)
        || (@fileperms($expectedResponse) & 0777) !== 0600
    ) {
        throw new RuntimeException('private response reservation failed');
    }

    $cp3g5Phase = 'seed';
    $cp3g5Operation = 'begin-transaction';

    $connection->beginTransaction();

    function issueToken(User $user, DesktopDevice $device): string
    {
        $createdToken = $user->createToken('cp3g5-desktop', ['desktop']);
        DesktopAccessToken::create([
            'token_id' => $createdToken->accessToken->id,
            'desktop_device_id' => $device->id,
            'user_id' => $user->id,
            'company_id' => $device->company_id,
            'issued_at' => now(),
        ]);

        return $createdToken->plainTextToken;
    }

    $cp3g5Operation = 'company-create';
    $company = Company::factory()->withDefaultCurrency(IsoCurrency::Usd)->create();
    $cp3g5Operation = 'subscription-create';
    CompanySubscription::factory()->create(['company_id' => $company->id]);
    $cp3g5Operation = 'branch-create';
    $branch = Branch::factory()->create(['company_id' => $company->id]);
    $cp3g5Operation = 'warehouse-create';
    $warehouse = Warehouse::factory()->create(['company_id' => $company->id, 'branch_id' => $branch->id]);
    $cp3g5Operation = 'device-create';
    $device = DesktopDevice::factory()->create([
        'company_id' => $company->id,
        'branch_id' => $branch->id,
        'warehouse_id' => $warehouse->id,
    ]);
    $cp3g5Operation = 'cashier-create';
    $cashier = User::factory()->forCompany($company)->role(SystemRole::Cashier)->create();
    $cp3g5Operation = 'payment-method-create';
    $paymentMethod = PaymentMethod::factory()->forCompany($company)->create();

    $cp3g5Operation = 'shift-create';
    $shift = Shift::factory()->create([
        'company_id' => $company->id,
        'branch_id' => $branch->id,
        'warehouse_id' => $warehouse->id,
        'desktop_device_id' => $device->id,
        'user_id' => $cashier->id,
    ]);

    $cp3g5Operation = 'token-issue';
    $token = issueToken($cashier, $device);
    $cp3g5Operation = 'binding-lookup';
    $binding = DesktopAccessToken::query()->where('user_id', $cashier->id)
        ->where('desktop_device_id', $device->id)->latest('id')->firstOrFail();
    $subscription = CompanySubscription::query()->where('company_id', $company->id)->latest('id')->first();

    $context = new DesktopDeviceContext(
        user: $cashier,
        company: $company,
        device: $device->refresh(),
        branch: $branch,
        warehouse: $warehouse,
        subscription: $subscription,
        accessDecision: new AccessDecision(
            isActive: true,
            isTrial: false,
            isInGrace: false,
            isExpired: false,
            isSuspended: false,
            canLogin: true,
            canSell: true,
            canSync: true,
            canActivateDevice: true,
            restrictionLevel: AccessDecisionLevel::AllowAll,
        ),
        desktopAccessToken: $binding,
    );

    $payloads = [];

    /*
     * CP-3G-7 F2 — the run's single deterministic time anchor.
     *
     * Every minted payload is sold at exactly this instant, and every minted product's catalog
     * revision becomes valid at exactly this instant. Pinning both to one run-scoped value is what
     * makes seeding deterministic.
     *
     * Before this, `$soldAt` was the shift's second-precision `opened_at` (written once, before the
     * loop) while each product's revision validity started at that product's *own* second-precision
     * `updated_at`, because `ProductFactory` never sets `sellable_revision_started_at`.
     * `SellableProductResolver::resolveCurrent()` throws `SellableCatalogUnavailable` when
     * `$asOf->lt($validFrom)`, so seeding succeeded only while the whole loop stayed inside the same
     * wall-clock second as the shift row, and failed the instant the clock ticked. That was
     * finding F2: a nondeterministic generated value, not a lock, a collision or a race.
     */
    $runAnchor = CarbonImmutable::instance($shift->opened_at ?? now());

    /*
     * The backend requires a gap-free consumption sequence per grant. One grant per payload keeps
     * scenarios independent: each consumes sequence 1 and cannot disturb another scenario.
     */
    for ($i = 0; $i < $mintCount; $i++) {
        $cp3g5Iteration = $i;

        $cp3g5Operation = 'product-create';
        $product = Product::factory()->forCompany($company)->create([
            'price' => 1000,
            'tax_mode' => ProductTaxMode::None,
            'track_stock' => true,
            // Run-scoped and deterministic: without it `$validFrom` falls back to this product's own
            // `updated_at`, which advances during the loop and eventually passes `$runAnchor`.
            'sellable_revision_started_at' => $runAnchor,
        ]);

        $cp3g5Operation = 'stock-item-create';
        StockItem::factory()->forCompany($company)->create([
            'product_id' => $product->id,
            'warehouse_id' => $warehouse->id,
            'quantity' => '10.000',
            'available_quantity' => '10.000',
        ]);

        $cp3g5Operation = 'allocation-top-up';
        $grant = app(StockAllocationService::class)->topUp(
            $context,
            (string) Str::uuid(),
            [['product_uuid' => $product->uuid, 'quantity' => '1.000']],
        )['allocations']->sole();

        $cp3g5Operation = 'sellable-resolve';
        $soldAt = $runAnchor;
        $validUntil = $soldAt->addDay();
        $snapshot = app(SellableProductResolver::class)->resolveCurrent($product, $soldAt, $validUntil);
        $catalogRevision = hash('sha256', implode(':', [
            $device->device_uuid,
            $snapshot->priceRevision,
            $soldAt->toIso8601String(),
        ]));

        $cp3g5Operation = 'catalog-contract-create';
        DesktopCatalogContract::query()->create([
            'company_id' => $company->id,
            'desktop_device_id' => $device->id,
            'branch_id' => $branch->id,
            'warehouse_id' => $warehouse->id,
            'revision' => $catalogRevision,
            'product_revisions' => [$product->uuid => $snapshot->priceRevision],
            'generated_at' => $soldAt,
            'valid_until' => $validUntil,
        ]);

        $localInvoiceUuid = (string) Str::uuid();

        $payloads[] = [
            'idempotency_key' => $localInvoiceUuid,
            'local_invoice_uuid' => $localInvoiceUuid,
            'catalog_revision' => $catalogRevision,
            'offline_number' => sprintf('CP3G5-%04d', $i + 1),
            'sold_at' => $soldAt->toIso8601String(),
            'sold_while_offline' => true,
            'currency' => 'USD',
            'tax_mode' => 'none',
            'client_contract_version' => 2,
            'shift_uuid' => $shift->uuid,
            'items' => [[
                'product_uuid' => $product->uuid,
                'quantity' => '1.000',
                'unit_price_amount' => 1000,
                'currency' => $snapshot->currency,
                'price_revision' => $snapshot->priceRevision,
                'tax_id' => $snapshot->taxUuid,
                'tax_mode' => $snapshot->taxMode,
                'tax_rate_basis_points' => $snapshot->taxRateBasisPoints,
                'tax_revision' => $snapshot->taxRevision,
                'allocations' => [[
                    'allocation_uuid' => $grant->uuid,
                    'rights_generation' => $grant->rights_generation,
                    'consumption_sequence' => 1,
                    'local_consumption_uuid' => (string) Str::uuid(),
                    'quantity_milli' => 1000,
                ]],
            ]],
            'payments' => [[
                'payment_method_uuid' => $paymentMethod->uuid,
                'type' => 'cash',
                'amount' => 1000,
            ]],
        ];
    }

    $cp3g5Iteration = -1;
    $cp3g5Phase = 'fixture-write';
    $cp3g5Operation = 'encode-fixture';

    $encodedFixture = json_encode([
        'token' => $token,
        'device_uuid' => $device->device_uuid,
        'company_uuid' => $company->uuid,
        'shift_uuid' => $shift->uuid,
        'payloads' => $payloads,
    ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);

    $cp3g5Operation = 'write-fixture';
    $written = @fwrite($responseHandle, $encodedFixture . PHP_EOL);
    $closed = @fclose($responseHandle);
    $responseHandle = null;

    if ($written !== strlen($encodedFixture) + 1 || ! $closed) {
        throw new RuntimeException('private response write failed');
    }

    $cp3g5Operation = 'commit';
    $connection->commit();

    while (ob_get_level() > 0) {
        ob_end_clean();
    }
} catch (Throwable $throwable) {
    // Only shape-constrained facts about the throwable ever leave this process. The message itself
    // is never emitted: it can carry SQL bindings, and a binding can carry fixture content.
    $diagnostic = ['code' => 'fixture-creation-failed', 'exception' => get_class($throwable)];

    if ($throwable instanceof PDOException || $throwable instanceof Illuminate\Database\QueryException) {
        $sqlstate = $throwable->getCode();

        if (is_string($sqlstate) && preg_match('/\A[A-Za-z0-9]{5}\z/D', $sqlstate) === 1) {
            $diagnostic['sqlstate'] = $sqlstate;
        }

        $errorInfo = $throwable->errorInfo ?? null;

        if (is_array($errorInfo) && isset($errorInfo[1]) && is_int($errorInfo[1])) {
            $diagnostic['driver_code'] = $errorInfo[1];
        }

        $identifier = cp3g5DatabaseIdentifier($throwable->getMessage());

        if ($identifier !== null) {
            $diagnostic['identifier'] = $identifier;
        }
    }

    if ($connection !== null) {
        $diagnostic['transaction_level'] = $connection->transactionLevel();
    }

    cp3g5Diagnostic($diagnostic);

    if (is_resource($responseHandle)) {
        @fclose($responseHandle);
    }

    if ($connection !== null && $connection->transactionLevel() > 0) {
        $connection->rollBack();
    }

    @unlink($expectedResponse);

    while (ob_get_level() > 0) {
        ob_end_clean();
    }

    fwrite(STDERR, "CP-3G-5 seeder rejected: fixture creation failed\n");
    exit(1);
}
