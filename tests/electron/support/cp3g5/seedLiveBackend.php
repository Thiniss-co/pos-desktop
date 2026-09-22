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
use App\Modules\Accounting\Models\PosAccountingSetting;
use App\Modules\Accounting\Services\DefaultChartOfAccountsService;
use App\Modules\Catalog\Enums\ProductTaxMode;
use App\Modules\Catalog\Enums\TaxType;
use App\Modules\Catalog\Models\DesktopCatalogContract;
use App\Modules\Catalog\Models\Product;
use App\Modules\Catalog\Models\Tax;
use App\Modules\Catalog\Services\ProductStockTrackingService;
use App\Modules\Catalog\Services\SellableProductResolver;
use App\Modules\Devices\Data\DesktopDeviceContext;
use App\Modules\Devices\Models\DesktopAccessToken;
use App\Modules\Devices\Models\DesktopDevice;
use App\Modules\Identity\Enums\SystemRole;
use App\Modules\Inventory\Enums\StockMovementDirection;
use App\Modules\Inventory\Enums\StockMovementType;
use App\Modules\Inventory\Models\StockItem;
use App\Modules\Inventory\Models\StockMovement;
use App\Modules\Inventory\Services\StockAllocationService;
use App\Modules\Payments\Models\PaymentMethod;
use App\Modules\POS\Enums\PosInvoiceStatus;
use App\Modules\POS\Enums\PosPaymentStatus;
use App\Modules\POS\Enums\PosTaxMode;
use App\Modules\POS\Models\DesktopRefundSync;
use App\Modules\POS\Models\PosInvoice;
use App\Modules\POS\Models\PosInvoiceItem;
use App\Modules\POS\Models\PosPayment;
use App\Modules\POS\Models\PosRefund;
use App\Modules\POS\Models\PosRefundItem;
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

    /*
     * Refund live-gate context (r6). Opt-in via CP3G5_MINT_REFUND_CONTEXT=1 so the ordinary
     * CP-3G-5 invoice-upload run is byte-for-byte unchanged when this is not asked for.
     *
     * Every "original sale" here is created DIRECTLY via Eloquent (real PosInvoice/PosInvoiceItem/
     * PosPayment/StockMovement rows, exactly the shape UploadDesktopRefundAction reads) rather than
     * through a real invoice-upload HTTP round trip -- that is a deliberate, bounded scope choice:
     * the SUBJECT under test is the REFUND, and every refund in every scenario below goes through
     * the desktop's real RefundService / refundUpload.client.ts / DesktopApiClient / HTTP / the
     * real POST /api/v1/desktop/refunds/upload route with the real R4 calculator, the real
     * confirmed-calculation contract and the real claim-then-collide concurrency protocol. Minting
     * the precondition directly is the same discipline PS8/PS9 already use for their own "already
     * committed" fixtures (see committedInvoice() in serviceLineLiveUpload.suite.ts).
     */
    $refundContext = null;

    if (getenv('CP3G5_MINT_REFUND_CONTEXT') === '1') {
        $cp3g5Phase = 'refund-context';
        $cp3g5Operation = 'company-create';

        $refundCompany = Company::factory()->withDefaultCurrency(IsoCurrency::Usd)->create();
        CompanySubscription::factory()->create([
            'company_id' => $refundCompany->id,
            'features_snapshot' => ['pos' => true, 'inventory' => true, 'reports' => true, 'refunds' => true, 'cash_drawer' => true, 'accounting' => true],
        ]);
        $refundBranch = Branch::factory()->create(['company_id' => $refundCompany->id]);
        $refundWarehouse = Warehouse::factory()->create(['company_id' => $refundCompany->id, 'branch_id' => $refundBranch->id]);
        $refundDevice = DesktopDevice::factory()->create(['company_id' => $refundCompany->id, 'branch_id' => $refundBranch->id, 'warehouse_id' => $refundWarehouse->id]);
        $refundCashier = User::factory()->forCompany($refundCompany)->role(SystemRole::Cashier)->create();
        $refundPaymentMethod = PaymentMethod::factory()->forCompany($refundCompany)->create(['type' => 'cash']);
        $refundShift = Shift::factory()->create([
            'company_id' => $refundCompany->id, 'branch_id' => $refundBranch->id, 'warehouse_id' => $refundWarehouse->id,
            'desktop_device_id' => $refundDevice->id, 'user_id' => $refundCashier->id, 'status' => 'open',
        ]);
        $refundToken = issueToken($refundCashier, $refundDevice);

        $cp3g5Operation = 'accounting-setup';
        $chart = app(DefaultChartOfAccountsService::class)->apply($refundCompany);
        PosAccountingSetting::query()->create([
            'company_id' => $refundCompany->id,
            'cash_account_id' => $chart['1000']->id,
            'card_clearing_account_id' => $chart['1010']->id,
            'bank_transfer_clearing_account_id' => $chart['1020']->id,
            'wallet_clearing_account_id' => $chart['1030']->id,
            'other_payment_clearing_account_id' => $chart['1040']->id,
            'safe_drop_clearing_account_id' => $chart['1050']->id,
            'inventory_asset_account_id' => $chart['1100']->id,
            'sales_tax_payable_account_id' => $chart['2000']->id,
            'loyalty_liability_account_id' => $chart['2100']->id,
            'inventory_receiving_clearing_account_id' => $chart['2200']->id,
            'sales_revenue_account_id' => $chart['4000']->id,
            'sales_discount_account_id' => $chart['4010']->id,
            'refunds_contra_revenue_account_id' => $chart['4020']->id,
            'cost_of_goods_sold_account_id' => $chart['5000']->id,
            'inventory_adjustment_loss_account_id' => $chart['5100']->id,
            'inventory_shrinkage_expense_account_id' => $chart['5110']->id,
            'expense_payout_account_id' => $chart['5200']->id,
            'cash_over_short_account_id' => $chart['6000']->id,
            'cash_drawer_adjustment_account_id' => $chart['6100']->id,
            'inventory_adjustment_gain_account_id' => $chart['7000']->id,
            'auto_post_invoices' => true,
            'auto_post_refunds' => true,
            'auto_post_cash_movements' => true,
            // Fail loudly rather than silently record a Failed posting record: the live suite
            // must be able to tell "no journal" (a real defect) from "posting was skipped".
            'strict_posting' => true,
        ]);

        $refundTax = Tax::query()->create([
            'company_id' => $refundCompany->id, 'name' => 'Refund Live VAT', 'code' => 'RVAT',
            'rate' => 10, 'type' => TaxType::Percentage, 'is_default' => false, 'is_active' => true,
        ]);

        /** One already-committed "original sale" line, created directly (see the note above). */
        $mintRefundSale = function (array $config) use ($refundCompany, $refundBranch, $refundWarehouse, $refundDevice, $refundCashier, $refundShift, $refundPaymentMethod, $runAnchor): array {
            $cp3g5Operation2 = 'refund-scenario-product';
            $product = Product::factory()->forCompany($refundCompany)->create([
                'price' => $config['unitPrice'], 'tax_mode' => $config['taxMode'], 'tax_id' => $config['taxId'] ?? null,
                'track_stock' => $config['trackStock'], 'sellable_revision_started_at' => $runAnchor,
            ]);

            $stockItem = null;

            if ($config['trackStock']) {
                $stockItem = StockItem::factory()->forCompany($refundCompany)->create([
                    'product_id' => $product->id, 'warehouse_id' => $refundWarehouse->id,
                    'quantity' => '10.000', 'available_quantity' => '10.000', 'reserved_quantity' => '0.000',
                ]);
            }

            $invoice = PosInvoice::factory()->create([
                'company_id' => $refundCompany->id, 'branch_id' => $refundBranch->id, 'warehouse_id' => $refundWarehouse->id,
                'desktop_device_id' => $refundDevice->id, 'shift_id' => $refundShift->id, 'cashier_user_id' => $refundCashier->id,
                'server_number' => 'CP3G5R-' . strtoupper(Str::random(8)),
                'status' => PosInvoiceStatus::Completed, 'payment_status' => PosPaymentStatus::Paid,
                'currency' => 'USD', 'subtotal_amount' => $config['subtotal'], 'discount_total_amount' => 0,
                'tax_total_amount' => $config['tax'], 'grand_total_amount' => $config['total'], 'paid_total_amount' => $config['total'],
                'branch_snapshot' => ['name' => $refundBranch->name], 'warehouse_snapshot' => ['name' => $refundWarehouse->name],
                'device_snapshot' => ['device_uuid' => $refundDevice->device_uuid], 'cashier_snapshot' => ['name' => $refundCashier->name],
            ]);
            $invoiceItem = PosInvoiceItem::factory()->create([
                'company_id' => $refundCompany->id, 'pos_invoice_id' => $invoice->id, 'product_id' => $product->id, 'product_uuid' => $product->uuid,
                'product_name' => $product->name, 'quantity' => $config['quantity'], 'unit_price_amount' => $config['unitPrice'],
                'unit_cost_amount' => $config['unitCost'] ?? 0, 'total_cost_amount' => $config['totalCost'] ?? 0,
                'cost_snapshot' => ['unit_cost_amount' => $config['unitCost'] ?? 0, 'source' => 'stock_item_average'],
                'subtotal_amount' => $config['subtotal'], 'discount_amount' => 0, 'tax_amount' => $config['tax'], 'total_amount' => $config['total'],
                'tax_mode' => $config['taxMode'] === ProductTaxMode::None ? PosTaxMode::None : PosTaxMode::Exclusive,
                'tax_rate' => $config['taxMode'] === ProductTaxMode::None ? '0.00' : '10.00',
            ]);
            PosPayment::factory()->create(['company_id' => $refundCompany->id, 'pos_invoice_id' => $invoice->id, 'payment_method_id' => $refundPaymentMethod->id, 'amount' => $config['total']]);

            if ($config['trackStock']) {
                StockMovement::query()->create([
                    'company_id' => $refundCompany->id, 'product_id' => $product->id, 'warehouse_id' => $refundWarehouse->id,
                    'stock_item_id' => $stockItem->id, 'pos_invoice_id' => $invoice->id, 'pos_invoice_item_id' => $invoiceItem->id,
                    'desktop_device_id' => $refundDevice->id, 'shift_id' => $refundShift->id, 'user_id' => $refundCashier->id,
                    'type' => StockMovementType::Sale, 'direction' => StockMovementDirection::Out,
                    'quantity' => $config['quantity'], 'quantity_before' => '10.000',
                    'quantity_after' => bcsub('10.000', $config['quantity'], 3),
                    'unit_cost_amount' => $config['unitCost'] ?? 0, 'total_cost_amount' => $config['totalCost'] ?? 0,
                    'occurred_at' => $invoice->sold_at ?? now(),
                ]);
            }

            return [
                'product' => $product, 'invoice' => $invoice, 'invoiceItem' => $invoiceItem,
                'invoice_uuid' => $invoice->uuid, 'invoice_item_uuid' => $invoiceItem->uuid,
                'product_uuid' => $product->uuid,
            ];
        };

        $cp3g5Operation = 'refund-scenario-service';
        $service = $mintRefundSale(['unitPrice' => 1500, 'taxMode' => ProductTaxMode::None, 'trackStock' => false, 'quantity' => '2.000', 'subtotal' => 3000, 'tax' => 0, 'total' => 3000]);

        $cp3g5Operation = 'refund-scenario-tracked-return';
        $trackedReturn = $mintRefundSale(['unitPrice' => 2000, 'taxMode' => ProductTaxMode::Exclusive, 'taxId' => $refundTax->id, 'trackStock' => true, 'quantity' => '1.000', 'subtotal' => 2000, 'tax' => 200, 'total' => 2200, 'unitCost' => 800, 'totalCost' => 800]);

        $cp3g5Operation = 'refund-scenario-tracked-no-return';
        $trackedNoReturn = $mintRefundSale(['unitPrice' => 1200, 'taxMode' => ProductTaxMode::None, 'trackStock' => true, 'quantity' => '1.000', 'subtotal' => 1200, 'tax' => 0, 'total' => 1200, 'unitCost' => 500, 'totalCost' => 500]);

        $cp3g5Operation = 'refund-scenario-trackedness-changed';
        $trackednessChanged = $mintRefundSale(['unitPrice' => 900, 'taxMode' => ProductTaxMode::None, 'trackStock' => true, 'quantity' => '1.000', 'subtotal' => 900, 'tax' => 0, 'total' => 900, 'unitCost' => 400, 'totalCost' => 400]);
        // The sale genuinely happened while tracked (the StockMovement above proves it). The
        // product is toggled OFF immediately afterward -- the PS9 "trackedness changed after the
        // sale" shape, proven live: the refund must still return stock from the sale's own
        // recorded effect, never from the product's CURRENT track_stock.
        $trackednessChanged['product']->track_stock = false;
        $trackednessChanged['product']->save();
        // Real production evidence path (mirrors UpdateProductAction's own ordering): the interval
        // opened at creation (track_stock=true) is closed and a new one opened at false, so the
        // toggle is a legitimate recorded transition rather than the R9-blocking divergence a raw
        // `->update()` alone would leave behind.
        app(ProductStockTrackingService::class)->recordChange(
            $trackednessChanged['product'],
            false,
            CarbonImmutable::now()
        );

        $cp3g5Operation = 'refund-scenario-repeated-partial';
        // Deliberately hand-set amounts (not derived from unitPrice*quantity): this reproduces the
        // plan §1 worked table (a) verbatim -- 100 over quantity 3, no tax, no discount -- so the
        // live refund-by-1-unit sequence can be asserted against the exact literal 33/34/33 split.
        $repeatedPartial = $mintRefundSale(['unitPrice' => 34, 'taxMode' => ProductTaxMode::None, 'trackStock' => false, 'quantity' => '3.000', 'subtotal' => 100, 'tax' => 0, 'total' => 100]);

        $cp3g5Operation = 'refund-scenario-free';
        $free = $mintRefundSale(['unitPrice' => 0, 'taxMode' => ProductTaxMode::None, 'trackStock' => false, 'quantity' => '1.000', 'subtotal' => 0, 'tax' => 0, 'total' => 0]);

        $cp3g5Operation = 'refund-scenario-infeasible';
        // The plan's G2 counterexample, verbatim: subtotal=1, tax=1, total=2, quantity=4. Two
        // legacy refunds (as an R4-predating desktop would have produced) each return total=1 and
        // tax=0 -- consuming ALL the money while quantity=2 remains and ALL the tax stays
        // unreversed. R = A - P = (0, 0, 1, 0): R_tax(1) > R_total(0) => HARD.
        $infeasible = $mintRefundSale(['unitPrice' => 25, 'taxMode' => ProductTaxMode::Exclusive, 'taxId' => $refundTax->id, 'trackStock' => false, 'quantity' => '4.000', 'subtotal' => 1, 'tax' => 1, 'total' => 2]);

        // r7 -- one dedicated original sale PER scenario that performs a real, full-quantity live
        // refund submission. Sharing a single scenario's line across multiple tests would exhaust
        // it on the first submission and make every later test observe a real, correct backend
        // refusal (not a bug) -- so scenarios 6-9 and 11c/12 each get their own line here, never
        // reused across two `liveTest` bodies.
        $cp3g5Operation = 'refund-scenario-lost-response';
        $lostResponse = $mintRefundSale(['unitPrice' => 1200, 'taxMode' => ProductTaxMode::None, 'trackStock' => true, 'quantity' => '1.000', 'subtotal' => 1200, 'tax' => 0, 'total' => 1200, 'unitCost' => 500, 'totalCost' => 500]);

        $cp3g5Operation = 'refund-scenario-restart-control';
        $restartControl = $mintRefundSale(['unitPrice' => 1500, 'taxMode' => ProductTaxMode::None, 'trackStock' => false, 'quantity' => '2.000', 'subtotal' => 3000, 'tax' => 0, 'total' => 3000]);

        $cp3g5Operation = 'refund-scenario-restart-second';
        $restartSecond = $mintRefundSale(['unitPrice' => 1200, 'taxMode' => ProductTaxMode::None, 'trackStock' => true, 'quantity' => '1.000', 'subtotal' => 1200, 'tax' => 0, 'total' => 1200, 'unitCost' => 500, 'totalCost' => 500]);

        $cp3g5Operation = 'refund-scenario-accepted-replay';
        $acceptedReplay = $mintRefundSale(['unitPrice' => 1500, 'taxMode' => ProductTaxMode::None, 'trackStock' => false, 'quantity' => '2.000', 'subtotal' => 3000, 'tax' => 0, 'total' => 3000]);

        $cp3g5Operation = 'refund-scenario-stale-confirmation';
        $staleConfirmation = $mintRefundSale(['unitPrice' => 2000, 'taxMode' => ProductTaxMode::Exclusive, 'taxId' => $refundTax->id, 'trackStock' => true, 'quantity' => '1.000', 'subtotal' => 2000, 'tax' => 200, 'total' => 2200, 'unitCost' => 800, 'totalCost' => 800]);

        $cp3g5Operation = 'refund-scenario-conflict-409';
        $conflict409 = $mintRefundSale(['unitPrice' => 1200, 'taxMode' => ProductTaxMode::None, 'trackStock' => true, 'quantity' => '1.000', 'subtotal' => 1200, 'tax' => 0, 'total' => 1200, 'unitCost' => 500, 'totalCost' => 500]);

        $cp3g5Operation = 'refund-scenario-rapid-repeat';
        $rapidRepeat = $mintRefundSale(['unitPrice' => 1200, 'taxMode' => ProductTaxMode::None, 'trackStock' => true, 'quantity' => '1.000', 'subtotal' => 1200, 'tax' => 0, 'total' => 1200, 'unitCost' => 500, 'totalCost' => 500]);

        foreach ([1, 2] as $legacyIndex) {
            $legacyRefund = PosRefund::factory()->create([
                'company_id' => $refundCompany->id, 'branch_id' => $refundBranch->id, 'warehouse_id' => $refundWarehouse->id,
                'desktop_device_id' => $refundDevice->id, 'shift_id' => $refundShift->id, 'cashier_user_id' => $refundCashier->id,
                'pos_invoice_id' => $infeasible['invoice']->id, 'refund_number' => 'CP3G5R-LEGACY-' . $legacyIndex . '-' . strtoupper(Str::random(6)),
                'idempotency_key' => (string) Str::uuid(), 'local_refund_uuid' => (string) Str::uuid(),
                'subtotal_amount' => 0, 'discount_total_amount' => 0, 'tax_total_amount' => 0, 'grand_total_amount' => 1, 'refunded_total_amount' => 1,
                'stock_returned' => false, 'refunded_at' => now(),
            ]);
            PosRefundItem::factory()->create([
                'company_id' => $refundCompany->id, 'pos_refund_id' => $legacyRefund->id, 'pos_invoice_item_id' => $infeasible['invoiceItem']->id,
                'product_id' => $infeasible['product']->id, 'product_uuid' => $infeasible['product_uuid'], 'product_name' => $infeasible['product']->name,
                'quantity' => '1.000', 'unit_price_amount' => 25, 'subtotal_amount' => 0, 'discount_amount' => 0, 'tax_amount' => 0, 'total_amount' => 1,
                'tax_mode' => PosTaxMode::Exclusive, 'tax_rate' => '10.00',
            ]);
            DesktopRefundSync::query()->create([
                'company_id' => $refundCompany->id, 'desktop_device_id' => $refundDevice->id, 'shift_id' => $refundShift->id, 'user_id' => $refundCashier->id,
                'pos_refund_id' => $legacyRefund->id, 'idempotency_key' => $legacyRefund->idempotency_key, 'local_refund_uuid' => $legacyRefund->local_refund_uuid,
                'status' => 'processed', 'request_hash' => hash('sha256', 'legacy-' . $legacyIndex), 'processed_at' => now(),
            ]);
        }

        // A second, authority-denied company: same shape, but WITHOUT the `refunds` plan feature.
        // Proves "missing authority blocks submission" against the real backend, real HTTP, real
        // FeaturePermissionGate -- not simulated.
        $cp3g5Operation = 'refund-scenario-denied-authority';
        $deniedCompany = Company::factory()->withDefaultCurrency(IsoCurrency::Usd)->create();
        CompanySubscription::factory()->create([
            'company_id' => $deniedCompany->id,
            'features_snapshot' => ['pos' => true, 'inventory' => true, 'reports' => true, 'cash_drawer' => true],
        ]);
        $deniedBranch = Branch::factory()->create(['company_id' => $deniedCompany->id]);
        $deniedWarehouse = Warehouse::factory()->create(['company_id' => $deniedCompany->id, 'branch_id' => $deniedBranch->id]);
        $deniedDevice = DesktopDevice::factory()->create(['company_id' => $deniedCompany->id, 'branch_id' => $deniedBranch->id, 'warehouse_id' => $deniedWarehouse->id]);
        $deniedCashier = User::factory()->forCompany($deniedCompany)->role(SystemRole::Cashier)->create();
        $deniedPaymentMethod = PaymentMethod::factory()->forCompany($deniedCompany)->create(['type' => 'cash']);
        $deniedShift = Shift::factory()->create([
            'company_id' => $deniedCompany->id, 'branch_id' => $deniedBranch->id, 'warehouse_id' => $deniedWarehouse->id,
            'desktop_device_id' => $deniedDevice->id, 'user_id' => $deniedCashier->id, 'status' => 'open',
        ]);
        $deniedToken = issueToken($deniedCashier, $deniedDevice);
        // $mintRefundSale closes over the PRIMARY $refundCompany/$refundShift/etc via `use`, so it
        // cannot build the denied company's invoice; it is built inline for this one company.
        $deniedProduct = Product::factory()->forCompany($deniedCompany)->create(['price' => 1000, 'tax_mode' => ProductTaxMode::None, 'track_stock' => false, 'sellable_revision_started_at' => $runAnchor]);
        $deniedInvoice = PosInvoice::factory()->create([
            'company_id' => $deniedCompany->id, 'branch_id' => $deniedBranch->id, 'warehouse_id' => $deniedWarehouse->id,
            'desktop_device_id' => $deniedDevice->id, 'shift_id' => $deniedShift->id, 'cashier_user_id' => $deniedCashier->id,
            'server_number' => 'CP3G5R-DENIED-' . strtoupper(Str::random(8)),
            'status' => PosInvoiceStatus::Completed, 'payment_status' => PosPaymentStatus::Paid,
            'currency' => 'USD', 'subtotal_amount' => 1000, 'tax_total_amount' => 0, 'grand_total_amount' => 1000, 'paid_total_amount' => 1000,
            'branch_snapshot' => ['name' => $deniedBranch->name], 'warehouse_snapshot' => ['name' => $deniedWarehouse->name],
            'device_snapshot' => ['device_uuid' => $deniedDevice->device_uuid], 'cashier_snapshot' => ['name' => $deniedCashier->name],
        ]);
        $deniedInvoiceItem = PosInvoiceItem::factory()->create([
            'company_id' => $deniedCompany->id, 'pos_invoice_id' => $deniedInvoice->id, 'product_id' => $deniedProduct->id, 'product_uuid' => $deniedProduct->uuid,
            'product_name' => $deniedProduct->name, 'quantity' => '1.000', 'unit_price_amount' => 1000,
            'subtotal_amount' => 1000, 'discount_amount' => 0, 'tax_amount' => 0, 'total_amount' => 1000, 'tax_mode' => PosTaxMode::None, 'tax_rate' => '0.00',
        ]);
        PosPayment::factory()->create(['company_id' => $deniedCompany->id, 'pos_invoice_id' => $deniedInvoice->id, 'payment_method_id' => $deniedPaymentMethod->id, 'amount' => 1000]);

        $refundContext = [
            'token' => $refundToken,
            'device_uuid' => $refundDevice->device_uuid,
            'company_uuid' => $refundCompany->uuid,
            'user_uuid' => $refundCashier->uuid,
            'shift_uuid' => $refundShift->uuid,
            'payment_method_uuid' => $refundPaymentMethod->uuid,
            'currency' => 'USD',
            'currency_exponent' => 2,
            'scenarios' => [
                'service' => ['invoice_uuid' => $service['invoice_uuid'], 'invoice_item_uuid' => $service['invoice_item_uuid'], 'product_uuid' => $service['product_uuid'], 'quantity' => '2.000', 'subtotal_amount' => 3000, 'tax_amount' => 0, 'total_amount' => 3000],
                'tracked_return' => ['invoice_uuid' => $trackedReturn['invoice_uuid'], 'invoice_item_uuid' => $trackedReturn['invoice_item_uuid'], 'product_uuid' => $trackedReturn['product_uuid'], 'quantity' => '1.000', 'subtotal_amount' => 2000, 'tax_amount' => 200, 'total_amount' => 2200],
                'tracked_no_return' => ['invoice_uuid' => $trackedNoReturn['invoice_uuid'], 'invoice_item_uuid' => $trackedNoReturn['invoice_item_uuid'], 'product_uuid' => $trackedNoReturn['product_uuid'], 'quantity' => '1.000', 'subtotal_amount' => 1200, 'tax_amount' => 0, 'total_amount' => 1200],
                'trackedness_changed' => ['invoice_uuid' => $trackednessChanged['invoice_uuid'], 'invoice_item_uuid' => $trackednessChanged['invoice_item_uuid'], 'product_uuid' => $trackednessChanged['product_uuid'], 'quantity' => '1.000', 'subtotal_amount' => 900, 'tax_amount' => 0, 'total_amount' => 900],
                'repeated_partial' => ['invoice_uuid' => $repeatedPartial['invoice_uuid'], 'invoice_item_uuid' => $repeatedPartial['invoice_item_uuid'], 'product_uuid' => $repeatedPartial['product_uuid'], 'quantity' => '3.000', 'subtotal_amount' => 100, 'tax_amount' => 0, 'total_amount' => 100],
                'free' => ['invoice_uuid' => $free['invoice_uuid'], 'invoice_item_uuid' => $free['invoice_item_uuid'], 'product_uuid' => $free['product_uuid'], 'quantity' => '1.000', 'subtotal_amount' => 0, 'tax_amount' => 0, 'total_amount' => 0],
                'infeasible' => ['invoice_uuid' => $infeasible['invoice_uuid'], 'invoice_item_uuid' => $infeasible['invoice_item_uuid'], 'product_uuid' => $infeasible['product_uuid'], 'quantity' => '4.000', 'subtotal_amount' => 1, 'tax_amount' => 1, 'total_amount' => 2],
                'lost_response' => ['invoice_uuid' => $lostResponse['invoice_uuid'], 'invoice_item_uuid' => $lostResponse['invoice_item_uuid'], 'product_uuid' => $lostResponse['product_uuid'], 'quantity' => '1.000', 'subtotal_amount' => 1200, 'tax_amount' => 0, 'total_amount' => 1200],
                'restart_control' => ['invoice_uuid' => $restartControl['invoice_uuid'], 'invoice_item_uuid' => $restartControl['invoice_item_uuid'], 'product_uuid' => $restartControl['product_uuid'], 'quantity' => '2.000', 'subtotal_amount' => 3000, 'tax_amount' => 0, 'total_amount' => 3000],
                'restart_second' => ['invoice_uuid' => $restartSecond['invoice_uuid'], 'invoice_item_uuid' => $restartSecond['invoice_item_uuid'], 'product_uuid' => $restartSecond['product_uuid'], 'quantity' => '1.000', 'subtotal_amount' => 1200, 'tax_amount' => 0, 'total_amount' => 1200],
                'accepted_replay' => ['invoice_uuid' => $acceptedReplay['invoice_uuid'], 'invoice_item_uuid' => $acceptedReplay['invoice_item_uuid'], 'product_uuid' => $acceptedReplay['product_uuid'], 'quantity' => '2.000', 'subtotal_amount' => 3000, 'tax_amount' => 0, 'total_amount' => 3000],
                'stale_confirmation' => ['invoice_uuid' => $staleConfirmation['invoice_uuid'], 'invoice_item_uuid' => $staleConfirmation['invoice_item_uuid'], 'product_uuid' => $staleConfirmation['product_uuid'], 'quantity' => '1.000', 'subtotal_amount' => 2000, 'tax_amount' => 200, 'total_amount' => 2200],
                'conflict_409' => ['invoice_uuid' => $conflict409['invoice_uuid'], 'invoice_item_uuid' => $conflict409['invoice_item_uuid'], 'product_uuid' => $conflict409['product_uuid'], 'quantity' => '1.000', 'subtotal_amount' => 1200, 'tax_amount' => 0, 'total_amount' => 1200],
                'rapid_repeat' => ['invoice_uuid' => $rapidRepeat['invoice_uuid'], 'invoice_item_uuid' => $rapidRepeat['invoice_item_uuid'], 'product_uuid' => $rapidRepeat['product_uuid'], 'quantity' => '1.000', 'subtotal_amount' => 1200, 'tax_amount' => 0, 'total_amount' => 1200],
            ],
            'denied_authority' => [
                'token' => $deniedToken,
                'device_uuid' => $deniedDevice->device_uuid,
                'company_uuid' => $deniedCompany->uuid,
                'user_uuid' => $deniedCashier->uuid,
                'shift_uuid' => $deniedShift->uuid,
                'payment_method_uuid' => $deniedPaymentMethod->uuid,
                'invoice_uuid' => $deniedInvoice->uuid,
                'invoice_item_uuid' => $deniedInvoiceItem->uuid,
                'quantity' => '1.000',
                'subtotal_amount' => 1000,
                'tax_amount' => 0,
                'total_amount' => 1000,
            ],
        ];
    }

    $cp3g5Phase = 'fixture-write';
    $cp3g5Operation = 'encode-fixture';

    $encodedFixture = json_encode([
        'token' => $token,
        'device_uuid' => $device->device_uuid,
        'company_uuid' => $company->uuid,
        'shift_uuid' => $shift->uuid,
        'payloads' => $payloads,
        'refund_context' => $refundContext,
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
