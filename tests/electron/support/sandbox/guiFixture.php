<?php

declare(strict_types=1);

/**
 * Fixture steps for driving the real Electron app against a disposable Laravel backend seeded with
 * `DesktopMvpSmokeSeeder` (see docs/design/claude-v3/verification/README.md, "GUI sandbox").
 *
 *   php guiFixture.php <backend-root> assign-device <device-uuid>
 *   php guiFixture.php <backend-root> mode-physical-presence [<window hours 1-72>]
 *   php guiFixture.php <backend-root> mode-allocation <SKU>[,<SKU>...]
 *   php guiFixture.php <backend-root> report <device-uuid>
 *   php guiFixture.php <backend-root> create-owner-product <SKU>
 *   php guiFixture.php <backend-root> receive-stock <SKU>:<quantity>
 *   php guiFixture.php <backend-root> stock <SKU>
 *   php guiFixture.php <backend-root> device <device-uuid>
 *   php guiFixture.php <backend-root> allocations <device-uuid>
 *   php guiFixture.php <backend-root> devices
 *   php guiFixture.php <backend-root> authorities
 *   php guiFixture.php <backend-root> movements <device-uuid>
 *   php guiFixture.php <backend-root> set-tracking <SKU>:<0|1>
 *   php guiFixture.php <backend-root> adjust-stock <SKU>:<quantity-to-remove>
 *   php guiFixture.php <backend-root> owner-permission <inventory.adjust|inventory.view|inventory.manage>:<0|1>
 *   php guiFixture.php <backend-root> company-feature inventory:<0|1>
 *   php guiFixture.php <backend-root> stock-position <SKU>
 *   php guiFixture.php <backend-root> record-opening-stock <SKU>:<quantity>
 *   php guiFixture.php <backend-root> product-image <SKU>:<1|2|3|remove>
 *   php guiFixture.php <backend-root> brand <#rrggbb|none>:<logo1|logo2|keep|nologo>
 *   php guiFixture.php <backend-root> revoke-device <device-uuid>
 *   php guiFixture.php <backend-root> second-company
 *   php guiFixture.php <backend-root> assign-device-other <device-uuid>
 *   php guiFixture.php <backend-root> move-device-other <device-uuid>
 *   php guiFixture.php <backend-root> create-named-products <count 1-25>
 *   php guiFixture.php <backend-root> create-plain-products <count 1-25>
 *
 * Company identity (owner UX plan P9). `brand` sets the GUI company's primary colour and logo through
 * `ChangeCompanyBrandingAction` / `StoreCompanyBrandLogoAction` at the current brand revision (the
 * actions behind the owner endpoints). `revoke-device` revokes through `RevokeDeviceAction`.
 * `second-company` seeds a second, minimal company (code OTHER-CO, activation code ACTIVATE-OTHER-CO,
 * cashier other-cashier@desktop-mvp.test, one untracked product) the way `DesktopMvpSmokeSeeder` seeds
 * the first — an INJECTED precondition for the re-registration journey, reported as simulated.
 * `assign-device-other` places a device in that company's branch and warehouse through the fence.
 * `move-device-other` moves a registered device row to that company (a raw row move, SIMULATED): the
 * backend refuses to register a device uuid that belongs to another company, so no product flow can
 * re-register a till elsewhere today; the move only exercises the register's company-change handling.
 *
 * Product images (owner UX plan P8). `product-image` gives the product a generated image (variant
 * 1–3: distinct colours and sizes) or removes it, through `StoreProductImageAction` and
 * `ChangeProductImageAction` at the product's current image revision — the actions behind the owner
 * image endpoints. It never touches the product row.
 *
 * Opening-stock journey support. `owner-permission` grants or revokes a permission on the
 * company_admin system role (as role management would) and clears the permission cache;
 * `company-feature` switches a plan feature in the company's active subscription snapshot — both are
 * INJECTED preconditions, reported as simulated. `stock-position` is read-only: the Main Warehouse
 * stock row of a SKU plus every effect an opening-stock request can have (opening adjustments,
 * movements, journals, position events, products with that SKU, stored request outcomes).
 * `record-opening-stock` is an independent writer through `RecordOpeningStockAction`.
 *
 * `create-owner-product` runs the company-owner create path in-process: the owner FormRequest
 * (`OwnerStoreProductRequest`: authorization, uuid reference translation, every product rule), then
 * `CreateProductData::fromRequest` and `CreateProductAction`, exactly as `OwnerProductController::store`
 * does. Only the HTTP session layer is skipped. `track_stock` is left unset, so the owner default
 * applies. `receive-stock` posts a stock receiving through `CreateStockReceivingAction`, the action
 * behind `POST /api/v1/stock-receivings`.
 *
 * Every write goes through the backend's own supported mechanisms, never a raw row write:
 *  - device placement through `DeviceAssignmentFenceService::applyAssignment` (the same fence
 *    re-registration uses, so allocation recovery semantics are preserved);
 *  - the offline-sale mode through `UpsertPosOfflineSalePolicyAction`;
 *  - per-product allocation exposure through `UpsertStockAllocationExposurePolicyAction`.
 *
 * `report` is read-only. It prints what exactly-once verification needs: per local invoice, how
 * many server invoices and sync records exist, and the stock movements they produced.
 *
 * The guard (`laravelSandboxGuard.php`) runs in this process before any of it.
 */

require __DIR__ . '/laravelSandboxGuard.php';

use App\Models\User;
use App\Modules\Catalog\Actions\ChangeProductImageAction;
use App\Modules\Catalog\Actions\CreateProductAction;
use App\Modules\Catalog\Actions\CreateTaxAction;
use App\Modules\Catalog\Data\CreateTaxData;
use App\Modules\Catalog\Enums\TaxCategory;
use App\Modules\Catalog\Enums\TaxType;
use App\Modules\Catalog\Models\Tax;
use App\Modules\Catalog\Actions\StoreProductImageAction;
use App\Modules\Catalog\Models\ProductImage;
use App\Modules\Catalog\Enums\ProductStatus;
use App\Modules\Catalog\Enums\ProductTaxMode;
use App\Modules\Devices\Actions\RevokeDeviceAction;
use App\Modules\Identity\Enums\SystemRole;
use App\Modules\Payments\Enums\PaymentMethodType;
use App\Modules\Payments\Models\PaymentMethod;
use App\Modules\Subscriptions\Models\CompanySubscription;
use App\Modules\Tenancy\Actions\ChangeCompanyBrandingAction;
use App\Modules\Tenancy\Actions\StoreCompanyBrandLogoAction;
use App\Modules\Tenancy\Enums\IsoCurrency;
use App\Modules\Tenancy\Models\CompanyBrandProfile;
use App\Modules\Tenancy\Services\CompanyCurrencyProvisioner;
use App\Modules\Catalog\Actions\UpdateProductAction;
use App\Modules\Catalog\Data\UpdateProductData;
use App\Modules\Inventory\Actions\CreateInventoryAdjustmentAction;
use App\Modules\Inventory\Enums\InventoryAdjustmentType;
use App\Modules\Catalog\Data\CreateProductData;
use App\Modules\Catalog\Http\Requests\CompanyOwner\OwnerStoreProductRequest;
use App\Modules\Catalog\Models\Category;
use App\Modules\Catalog\Models\Product;
use App\Modules\Inventory\Actions\CreateStockReceivingAction;
use App\Modules\Tenancy\Data\CompanyContext;
use App\Modules\Tenancy\Services\CurrentCompanyResolver;
use App\Modules\Devices\Models\DesktopDevice;
use App\Modules\Devices\Services\DeviceAssignmentFenceService;
use App\Modules\Inventory\Actions\UpsertStockAllocationExposurePolicyAction;
use App\Modules\Inventory\Data\UpsertStockAllocationExposurePolicyData;
use App\Modules\POS\Actions\UpsertPosOfflineSalePolicyAction;
use App\Modules\POS\Data\UpsertPosOfflineSalePolicyData;
use App\Modules\POS\Enums\PosOfflineSaleMode;
use App\Modules\Tenancy\Models\Branch;
use App\Modules\Tenancy\Models\Company;
use App\Modules\Tenancy\Models\Warehouse;
use Illuminate\Support\Facades\DB;

const GUI_COMPANY_CODE = 'DESKTOP-MVP';
const GUI_ADMIN_EMAIL = 'admin@desktop-mvp.test';

$backendRoot = $argv[1] ?? '';
$operation = $argv[2] ?? '';
$argument = $argv[3] ?? '';

if ($backendRoot === '' || ! is_file($backendRoot . '/artisan')) {
    sandboxRefuse('the backend root is missing');
}

if (! in_array($operation, ['assign-device', 'mode-physical-presence', 'mode-allocation', 'report', 'create-owner-product', 'receive-stock', 'stock', 'device', 'allocations', 'devices', 'set-tracking', 'adjust-stock', 'authorities', 'movements', 'owner-permission', 'company-feature', 'stock-position', 'record-opening-stock', 'product-image', 'brand', 'revoke-device', 'second-company', 'assign-device-other', 'move-device-other', 'quick-create-report', 'quick-create-grant', 'mixed-tax-catalog', 'mixed-tax-report', 'create-named-products', 'create-plain-products', 'receipt-snapshots', 'fiscal-zatca', 'offer-start', 'offer-end', 'offer-report', 'suspend-company', 'resume-company', 'inspect-suspension', 'subscription-lapse', 'subscription-request', 'inspect-subscription', 'subscription-end-soon', 'plan-capacity-change'], true)) {
    sandboxRefuse('unknown fixture operation');
}

if (in_array($operation, ['create-owner-product', 'stock'], true) && preg_match('/^[A-Z0-9-]{1,40}$/', $argument) !== 1) {
    sandboxRefuse('a SKU is required');
}

// Phase 3 (platform company suspension): suspend/resume through the production platform actions, with an optional
// short reason; `inspect-suspension` is read-only and takes no argument.
if (in_array($operation, ['suspend-company', 'resume-company'], true) && $argument !== '' && preg_match('/^[A-Za-z0-9 .,:-]{3,120}$/', $argument) !== 1) {
    sandboxRefuse($operation.' takes an optional plain reason (3-120 characters)');
}
if ($operation === 'inspect-suspension' && $argument !== '') {
    sandboxRefuse('inspect-suspension takes no argument');
}

// Platform Phase 4 (plans, requests, review, payment, activation): `subscription-lapse` is a labelled precondition (the
// current period ended and its grace passed — access is computed from these dates, there is no expiry job);
// `subscription-request` places a same-plan, same-cycle request as the company admin and takes it through approval,
// the exact manual payment and activation with the production actions; `inspect-subscription` is read-only.
if (in_array($operation, ['subscription-lapse', 'subscription-request', 'inspect-subscription', 'plan-capacity-change'], true) && $argument !== '') {
    sandboxRefuse($operation.' takes no argument');
}

// Phase 4 closeout (O-7): `subscription-end-soon <seconds>` is a labelled precondition — the current period ends that many
// seconds from now with no grace, so a journey can cross the period boundary in real time (server and till alike);
// `plan-capacity-change` edits the current plan in place for future requests through the platform action (Phase 4B), so
// the next renewal's recorded entitlements differ from the current period's.
if ($operation === 'subscription-end-soon'
    && (preg_match('/^\d{2,3}$/', $argument) !== 1 || (int) $argument < 60 || (int) $argument > 900)) {
    sandboxRefuse('subscription-end-soon needs <seconds 60-900>');
}

if ($operation === 'mode-physical-presence' && $argument !== ''
    && (preg_match('/^\d{1,2}$/', $argument) !== 1 || (int) $argument < 1 || (int) $argument > 72)) {
    sandboxRefuse('mode-physical-presence takes an optional window in hours (1-72)');
}

// POS improvements, Stage 2: grant or revoke ONE quick-create permission on the seeded cashier or
// manager (a labelled precondition; the owner-SPA delegation itself is exercised by qc1permissions).
if ($operation === 'quick-create-grant'
    && preg_match('/^(cashier|manager):(customers\.create|catalog\.products\.create|suppliers\.create):[01]$/', $argument) !== 1) {
    sandboxRefuse('quick-create-grant needs <cashier|manager>:<customers.create|catalog.products.create|suppliers.create>:<0|1>');
}

// POS improvements, Stage 4: a labelled precondition (categorized taxes and mixed-mode products) and a
// READ-ONLY report of mixed-tax upload effects; neither takes an argument.
if (in_array($operation, ['mixed-tax-catalog', 'mixed-tax-report'], true) && $argument !== '') {
    sandboxRefuse($operation.' takes no argument');
}

// POS workspace: a labelled precondition of N untracked products with realistic long EN/AR names
// (`WS-01`…, barcodes 62910000000NN), created through the owner create path like `mixed-tax-catalog`.
if ($operation === 'create-named-products'
    && (preg_match('/^[1-9]\d?$/', $argument) !== 1 || (int) $argument > 25)) {
    sandboxRefuse('create-named-products needs <count 1-25>');
}

// POS workspace: the ordinary-cart precondition — N untracked products with short, single-line
// EN/AR names (`PL-01`…, barcodes 62920000000NN), created through the same owner create path.
if ($operation === 'create-plain-products'
    && (preg_match('/^[1-9]\d?$/', $argument) !== 1 || (int) $argument > 25)) {
    sandboxRefuse('create-plain-products needs <count 1-25>');
}

// Owner expansion Phase E: a labelled precondition (the business time zone and one live 10% register offer on a
// SKU, started an hour ago), the owner ending it, and a READ-ONLY report of offered upload effects.
if ($operation === 'offer-start' && preg_match('/^[A-Z0-9-]{1,40}$/', $argument) !== 1) {
    sandboxRefuse('offer-start needs <SKU>');
}
if (in_array($operation, ['offer-end', 'offer-report'], true) && $argument !== '') {
    sandboxRefuse($operation.' takes no argument');
}

// POS improvements, Stage 1: a READ-ONLY report of register quick-create effects; it takes no argument.
if ($operation === 'quick-create-report' && $argument !== '') {
    sandboxRefuse('quick-create-report takes no argument');
}

if ($operation === 'set-tracking' && preg_match('/^[A-Z0-9-]{1,40}:[01]$/', $argument) !== 1) {
    sandboxRefuse('set-tracking needs <SKU>:<0|1>');
}

if ($operation === 'adjust-stock' && preg_match('/^[A-Z0-9-]{1,40}:\d{1,6}(\.\d{1,3})?$/', $argument) !== 1) {
    sandboxRefuse('adjust-stock needs <SKU>:<quantity>');
}

if ($operation === 'receive-stock' && preg_match('/^[A-Z0-9-]{1,40}:\d{1,6}(\.\d{1,3})?$/', $argument) !== 1) {
    sandboxRefuse('receive-stock needs <SKU>:<quantity>');
}

if ($operation === 'owner-permission' && preg_match('/^inventory\.(adjust|view|manage):[01]$/', $argument) !== 1) {
    sandboxRefuse('owner-permission needs <inventory.adjust|inventory.view|inventory.manage>:<0|1>');
}

if ($operation === 'company-feature' && preg_match('/^inventory:[01]$/', $argument) !== 1) {
    sandboxRefuse('company-feature needs inventory:<0|1>');
}

if ($operation === 'stock-position' && preg_match('/^[A-Z0-9-]{1,40}$/', $argument) !== 1) {
    sandboxRefuse('a SKU is required');
}

if ($operation === 'record-opening-stock' && preg_match('/^[A-Z0-9-]{1,40}:\d{1,6}(\.\d{1,3})?$/', $argument) !== 1) {
    sandboxRefuse('record-opening-stock needs <SKU>:<quantity>');
}

if ($operation === 'product-image' && preg_match('/^[A-Z0-9-]{1,40}:(1|2|3|remove)$/', $argument) !== 1) {
    sandboxRefuse('product-image needs <SKU>:<1|2|3|remove>');
}
if ($operation === 'brand' && preg_match('/^(#[0-9a-f]{6}|none):(logo1|logo2|keep|nologo)$/', $argument) !== 1) {
    sandboxRefuse('brand needs <#rrggbb|none>:<logo1|logo2|keep|nologo>');
}
if (in_array($operation, ['assign-device', 'report', 'device', 'allocations', 'movements', 'revoke-device', 'assign-device-other', 'move-device-other'], true)
    && preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i', $argument) !== 1) {
    sandboxRefuse('a device uuid is required');
}

$app = sandboxBootstrap($backendRoot);

$company = Company::query()->where('code', GUI_COMPANY_CODE)->firstOrFail();
$branch = Branch::query()->where('company_id', $company->id)->where('name', 'Main Branch')->firstOrFail();
$warehouse = Warehouse::query()->where('company_id', $company->id)->where('name', 'Main Warehouse')->firstOrFail();
$actor = User::query()->where('email', GUI_ADMIN_EMAIL)->firstOrFail();

$result = match ($operation) {
    'assign-device' => DB::transaction(function () use ($argument, $company, $branch, $warehouse, $actor): array {
        $device = DesktopDevice::query()
            ->where('company_id', $company->id)
            ->where('device_uuid', $argument)
            ->firstOrFail();
        $quarantined = app(DeviceAssignmentFenceService::class)
            ->applyAssignment($device, $branch->id, $warehouse->id, $actor->id);

        return ['assigned' => true, 'quarantined_allocations' => $quarantined];
    }),
    'mode-physical-presence' => [
        'policy_revision' => app(UpsertPosOfflineSalePolicyAction::class)->execute(new UpsertPosOfflineSalePolicyData(
            companyId: $company->id,
            actorUserId: $actor->id,
            warehouseUuid: $warehouse->uuid,
            mode: PosOfflineSaleMode::PhysicalPresence,
            maxOfflineHours: $argument === '' ? 72 : (int) $argument,
            isEnabled: true,
        ))->revision ?? null,
    ],
    'mode-allocation' => (function () use ($argument, $company, $warehouse, $actor): array {
        $policy = app(UpsertPosOfflineSalePolicyAction::class)->execute(new UpsertPosOfflineSalePolicyData(
            companyId: $company->id,
            actorUserId: $actor->id,
            warehouseUuid: $warehouse->uuid,
            mode: PosOfflineSaleMode::AllocationExclusive,
            maxOfflineHours: 72,
            isEnabled: true,
        ));
        $exposures = [];

        foreach (array_filter(explode(',', $argument)) as $sku) {
            $product = Product::query()->where('company_id', $company->id)->where('sku', $sku)->firstOrFail();
            $exposures[$sku] = app(UpsertStockAllocationExposurePolicyAction::class)->execute(
                new UpsertStockAllocationExposurePolicyData(
                    companyId: $company->id,
                    actorUserId: $actor->id,
                    warehouseUuid: $warehouse->uuid,
                    productUuid: $product->uuid,
                    warehouseProductBudgetMilli: 20_000,
                    deviceProductHardCapMilli: 10_000,
                    advanceTargetMilli: 5_000,
                    advanceGrantLifetimeMinutes: null,
                    isEnabled: true,
                )
            )->id !== null;
        }

        return ['policy_revision' => $policy->revision ?? null, 'exposures' => $exposures];
    })(),
    'report' => (function () use ($argument, $company): array {
        $device = DesktopDevice::query()
            ->where('company_id', $company->id)
            ->where('device_uuid', $argument)
            ->firstOrFail();
        $syncs = DB::table('desktop_invoice_syncs')
            ->where('desktop_device_id', $device->id)
            ->select('local_invoice_uuid', 'status', 'pos_invoice_id')
            ->orderBy('id')
            ->get();
        $invoices = [];

        foreach ($syncs->groupBy('local_invoice_uuid') as $localUuid => $records) {
            $invoiceIds = $records->pluck('pos_invoice_id')->filter()->unique()->values();
            $invoices[$localUuid] = [
                'sync_records' => $records->count(),
                'statuses' => $records->pluck('status')->values()->all(),
                'server_invoices' => $invoiceIds->count(),
                'stock_movements' => DB::table('stock_movements')->whereIn('pos_invoice_id', $invoiceIds)->count(),
                'sold_while_offline' => DB::table('pos_invoices')->whereIn('id', $invoiceIds)->pluck('sold_while_offline')->map(fn ($v): bool => (bool) $v)->all(),
                // Phase 4 closeout: when the sale was rung and under which offline authority (read-only).
                'sold_at' => DB::table('pos_invoices')->whereIn('id', $invoiceIds)->pluck('sold_at')->map(fn ($v): string => (string) $v)->all(),
                'authority' => DB::table('pos_invoices')->whereIn('pos_invoices.id', $invoiceIds)
                    ->leftJoin('pos_offline_sale_authorities', 'pos_offline_sale_authorities.id', '=', 'pos_invoices.offline_sale_authority_id')
                    ->pluck('pos_offline_sale_authorities.uuid')->all(),
            ];
        }

        return [
            'device_assigned' => $device->warehouse_id !== null && $device->branch_id !== null,
            'invoices' => $invoices,
            'device_invoice_count' => DB::table('pos_invoices')->where('desktop_device_id', $device->id)->count(),
        ];
    })(),
    // Owner receipt copies: the server's stored receipt snapshots of a register, each with the txn-ref-v1
    // reference recomputed from the stored invoice (read-only; a backend without the table reports none).
    'receipt-snapshots' => (function () use ($argument, $company): array {
        if (! Illuminate\Support\Facades\Schema::hasTable('pos_invoice_receipt_snapshots')) {
            return ['supported' => false, 'snapshots' => []];
        }
        $device = DesktopDevice::query()->where('company_id', $company->id)->where('device_uuid', $argument)->firstOrFail();
        $rows = DB::table('pos_invoice_receipt_snapshots as s')
            ->join('pos_invoices as i', 'i.id', '=', 's.pos_invoice_id')
            ->leftJoin('shifts as sh', 'sh.id', '=', 'i.shift_id')
            ->where('s.desktop_device_id', $device->id)
            ->orderBy('s.id')
            ->get(['s.local_invoice_uuid', 's.qr_type', 's.qr_payload', 's.content_sha256', 's.snapshot_version', 's.canonical_content', 'i.id as invoice_id', 'i.sold_at', 'i.grand_total_amount', 'i.tax_total_amount', 'i.currency', 'sh.currency_exponent']);
        $currencyExponent = fn (string $code): ?int => DB::table('currencies')->where('company_id', $company->id)->where('code', $code)->value('exponent');

        return ['supported' => true, 'snapshots' => $rows->map(function ($row) use ($company, $currencyExponent): array {
            $exponent = (int) ($row->currency_exponent ?? $currencyExponent($row->currency));
            $soldAt = Carbon\CarbonImmutable::parse($row->sold_at, 'UTC');
            $fiscal = json_decode($row->canonical_content, true)['fiscal'] ?? null;
            $expected = $row->qr_type === 'zatca-p1'
                ? App\Modules\POS\Support\ZatcaPhase1Qr::encode((string) $fiscal['seller_name'], (string) $fiscal['vat_number'], App\Modules\POS\Support\TransactionReferenceQr::timestamp($soldAt), App\Modules\POS\Support\ZatcaPhase1Qr::amount((int) $row->grand_total_amount, $exponent), App\Modules\POS\Support\ZatcaPhase1Qr::amount((int) $row->tax_total_amount, $exponent))
                : App\Modules\POS\Support\TransactionReferenceQr::encode(strtolower($company->uuid), 'sale', $row->local_invoice_uuid, $soldAt, (int) $row->grand_total_amount, $exponent, $row->currency);
            $invoice = App\Modules\POS\Models\PosInvoice::query()->with(['items', 'payments', 'receiptSnapshot', 'shift'])->findOrFail($row->invoice_id);

            return [
                'local_invoice_uuid' => $row->local_invoice_uuid,
                'content_sha256' => $row->content_sha256,
                'snapshot_version' => (int) $row->snapshot_version,
                'qr_type' => $row->qr_type,
                'qr_payload' => $row->qr_payload,
                'expected_qr' => $expected,
                // What the owner portal's receipt copy carries for this sale (read-only).
                'owner_copy_qr' => app(App\Modules\POS\Actions\BuildOwnerReceiptCopyAction::class)->execute($invoice)['qr']['payload'],
            ];
        })->all()];
    })(),
    // Owner receipt copies: the company switches to ZATCA phase 1 with a complete identity, as the owner
    // fiscal settings would save it (the register mirrors it on its next bootstrap).
    'fiscal-zatca' => (function () use ($company): array {
        DB::table('companies')->where('id', $company->id)->update([
            'legal_name' => 'Harbour Coffee Trading LLC', 'tax_number' => '310122393500003', 'street' => '1 Corniche Road',
            'city' => 'Jeddah', 'postal_code' => '23511', 'country' => 'Saudi Arabia', 'fiscal_regime' => 'sa_zatca_phase1',
            'fiscal_revision' => DB::raw('fiscal_revision + 1'),
        ]);

        return ['regime' => 'sa_zatca_phase1', 'revision' => (int) DB::table('companies')->where('id', $company->id)->value('fiscal_revision')];
    })(),
    'create-owner-product' => (function () use ($argument, $company, $actor): array {
        $context = app(CurrentCompanyResolver::class)->resolve($actor);
        app()->instance(CompanyContext::class, $context);
        $category = Category::query()->where('company_id', $company->id)->orderBy('id')->firstOrFail();
        $request = OwnerStoreProductRequest::create('/api/v1/company-owner/products', 'POST', [
            'name' => "Owner product {$argument}",
            'category_id' => $category->uuid,
            'sku' => $argument,
            'barcode' => 'OWN'.preg_replace('/[^0-9A-Z]/', '', $argument),
            'price' => 1250,
        ]);
        $request->setContainer(app())->setRedirector(app('redirect'));
        $request->setUserResolver(fn () => $actor);
        $request->validateResolved();
        $product = app(CreateProductAction::class)->execute(CreateProductData::fromRequest($request, $context));

        return ['uuid' => $product->uuid, 'sku' => $product->sku, 'barcode' => $product->barcode, 'track_stock' => (bool) $product->track_stock];
    })(),
    'receive-stock' => (function () use ($argument, $company, $warehouse, $actor): array {
        [$sku, $quantity] = explode(':', $argument, 2);
        $product = Product::query()->where('company_id', $company->id)->where('sku', $sku)->firstOrFail();
        $receiving = app(CreateStockReceivingAction::class)->execute(
            $company->id,
            $warehouse->id,
            $actor->id,
            'Sandbox supplier',
            null,
            'GUI sandbox receiving',
            now(),
            [['product_id' => $product->id, 'quantity' => $quantity, 'unit_cost_amount' => 100]],
        );

        return ['receiving' => $receiving->uuid ?? $receiving->id, 'sku' => $sku, 'quantity' => $quantity];
    })(),
    'stock' => (function () use ($argument, $company): array {
        $product = Product::query()->where('company_id', $company->id)->where('sku', $argument)->firstOrFail();

        return [
            'sku' => $argument,
            'track_stock' => (bool) $product->track_stock,
            'stock_items' => DB::table('stock_items')->where('product_id', $product->id)
                ->select('warehouse_id', 'quantity', 'reserved_quantity', 'allocation_reserved_quantity', 'available_quantity')
                ->get()->all(),
        ];
    })(),
    'device' => (function () use ($argument, $company): array {
        $device = DesktopDevice::query()->where('company_id', $company->id)->where('device_uuid', $argument)->firstOrFail();

        return [
            'status' => $device->status?->value ?? $device->status,
            'last_seen_at' => $device->last_seen_at?->toIso8601String(),
            'server_now' => now()->toIso8601String(),
        ];
    })(),
    // The owner/admin update path (UpdateProductAction), which also records the tracking timeline.
    'set-tracking' => (function () use ($argument, $company): array {
        [$sku, $flag] = explode(':', $argument, 2);
        $product = Product::query()->where('company_id', $company->id)->where('sku', $sku)->firstOrFail();
        $updated = app(UpdateProductAction::class)->execute($product, new UpdateProductData(
            categoryId: null, name: null, sku: null, barcode: null, description: null, status: null,
            isActive: null, trackStock: $flag === '1', unit: null, taxMode: null, taxId: null,
            taxIdProvided: false, price: null,
        ));

        return ['sku' => $sku, 'track_stock' => (bool) $updated->track_stock];
    })(),
    // A posted decrease adjustment (CreateInventoryAdjustmentAction), the inventory module's own path.
    'adjust-stock' => (function () use ($argument, $company, $warehouse, $actor): array {
        [$sku, $quantity] = explode(':', $argument, 2);
        $product = Product::query()->where('company_id', $company->id)->where('sku', $sku)->firstOrFail();
        $adjustment = app(CreateInventoryAdjustmentAction::class)->execute(
            $company->id, $warehouse->id, $actor->id, InventoryAdjustmentType::Decrease,
            'GUI sandbox stock level', null,
            [['product_id' => $product->id, 'direction' => 'out', 'quantity' => $quantity, 'unit_cost_amount' => null, 'notes' => null]],
        );

        return ['adjustment' => $adjustment->uuid ?? $adjustment->id, 'sku' => $sku, 'removed' => $quantity];
    })(),
    'movements' => (function () use ($argument, $company): array {
        $device = DesktopDevice::query()->where('company_id', $company->id)->where('device_uuid', $argument)->firstOrFail();
        $invoiceIds = DB::table('pos_invoices')->where('desktop_device_id', $device->id)->pluck('id');

        return [
            'movements' => DB::table('stock_movements')
                ->join('products', 'products.id', '=', 'stock_movements.product_id')
                ->whereIn('stock_movements.pos_invoice_id', $invoiceIds)
                ->orderBy('stock_movements.id')
                ->get([
                    'products.sku', 'stock_movements.quantity', 'stock_movements.quantity_before',
                    'stock_movements.quantity_after', 'stock_movements.stock_authorization',
                    'stock_movements.is_oversold', 'stock_movements.allocation_covered_milli',
                    'stock_movements.uncovered_milli', 'stock_movements.pos_invoice_id',
                ])->map(fn ($row): array => (array) $row)->all(),
            'invoices' => DB::table('pos_invoices')->where('desktop_device_id', $device->id)
                ->orderBy('id')->get(['id', 'sold_while_offline'])->map(fn ($row): array => (array) $row)->all(),
        ];
    })(),
    'owner-permission' => (function () use ($argument): array {
        [$permission, $flag] = explode(':', $argument, 2);
        $role = \Spatie\Permission\Models\Role::findByName('company_admin', 'web');
        $flag === '1' ? $role->givePermissionTo($permission) : $role->revokePermissionTo($permission);
        app(\Spatie\Permission\PermissionRegistrar::class)->forgetCachedPermissions();

        return ['permission' => $permission, 'granted' => $flag === '1', 'injected' => true];
    })(),
    'company-feature' => (function () use ($argument, $company): array {
        [$feature, $flag] = explode(':', $argument, 2);
        // The subscription in effect (a scheduled renewal starting later is a newer row but not the current one).
        $subscription = $company->currentSubscription()->firstOrFail();
        $subscription->update(['features_snapshot' => array_merge((array) $subscription->features_snapshot, [$feature => $flag === '1'])]);

        return ['feature' => $feature, 'enabled' => $flag === '1', 'injected' => true];
    })(),
    'stock-position' => (function () use ($argument, $company, $warehouse): array {
        $products = Product::query()->where('company_id', $company->id)->where('sku', $argument)->pluck('id');
        $productId = $products->first();
        $at = fn (string $table) => $productId === null ? 0 : DB::table($table)->where('product_id', $productId)->where('warehouse_id', $warehouse->id)->count();

        return [
            'sku' => $argument,
            'products_with_sku' => $products->count(),
            'stock_row' => $productId === null ? null : DB::table('stock_items')->where('product_id', $productId)->where('warehouse_id', $warehouse->id)
                ->first(['quantity', 'available_quantity', 'average_unit_cost_amount', 'inventory_value_amount']),
            'opening_adjustments' => $productId === null ? 0 : DB::table('inventory_adjustment_items')
                ->join('inventory_adjustments', 'inventory_adjustments.id', '=', 'inventory_adjustment_items.inventory_adjustment_id')
                ->where('inventory_adjustments.type', 'opening_balance')->where('inventory_adjustment_items.product_id', $productId)->count(),
            'movements' => $at('stock_movements'),
            'position_events' => $at('stock_item_position_events'),
            'journals' => DB::table('accounting_journals')->where('company_id', $company->id)->count(),
            'stored_outcomes' => DB::table('owner_operation_requests')->where('company_id', $company->id)
                ->orderBy('id')->get(['operation', 'response_status'])->map(fn ($row): array => (array) $row)->all(),
        ];
    })(),
    'brand' => (function () use ($argument, $company, $actor): array {
        [$color, $logo] = explode(':', $argument);
        $branding = app(ChangeCompanyBrandingAction::class);
        $revision = (int) (CompanyBrandProfile::query()->where('company_id', $company->id)->value('revision') ?? 0);
        $profile = $branding->setColor($company->id, $color === 'none' ? null : $color, $revision);
        if ($logo === 'nologo') {
            $profile = $branding->removeLogo($company->id, $profile->revision);
        } elseif ($logo !== 'keep') {
            [$width, $height, $rgb] = $logo === 'logo1' ? [300, 120, [20, 110, 100]] : [240, 240, [150, 40, 160]];
            $image = imagecreatetruecolor($width, $height);
            imagefill($image, 0, 0, imagecolorallocate($image, ...$rgb));
            imagefilledrectangle($image, 20, 20, $width - 20, $height - 20, imagecolorallocate($image, 250, 250, 250));
            ob_start();
            imagepng($image);
            $asset = app(StoreCompanyBrandLogoAction::class)->execute($company->id, $actor->id, (string) ob_get_clean());
            $profile = $branding->setLogo($company->id, $asset->id, $profile->revision);
        }

        return ['revision' => $profile->revision, 'primary_color' => $profile->primary_color, 'logo_asset_id' => $profile->logo_asset_id];
    })(),
    'revoke-device' => (function () use ($argument, $company, $actor): array {
        $device = DesktopDevice::query()->where('company_id', $company->id)->where('device_uuid', $argument)->firstOrFail();
        app(RevokeDeviceAction::class)->execute($device, $actor->id, 'P9 re-registration journey');

        return ['revoked' => true];
    })(),
    'second-company' => (function () use ($company): array {
        $other = Company::query()->firstOrCreate(
            ['code' => 'OTHER-CO'],
            ['name' => 'Other Company', 'email' => 'other@desktop-mvp.test', 'is_active' => true, 'activation_code' => 'ACTIVATE-OTHER-CO'],
        );
        app(CompanyCurrencyProvisioner::class)->provision($other, IsoCurrency::Usd);
        $template = CompanySubscription::query()->where('company_id', $company->id)->latest('id')->firstOrFail();
        if (! CompanySubscription::query()->where('company_id', $other->id)->exists()) {
            // Same plan, features and limits; a fresh public uuid (HasUuid fills an empty one).
            $copy = $template->replicate(['uuid']);
            $copy->company_id = $other->id;
            $copy->save();
        }
        $branch = Branch::query()->firstOrCreate(['company_id' => $other->id, 'name' => 'Other Branch']);
        $warehouse = Warehouse::query()->firstOrCreate(['company_id' => $other->id, 'name' => 'Other Warehouse'], ['branch_id' => $branch->id]);
        $cashier = User::query()->updateOrCreate(
            ['email' => 'other-cashier@desktop-mvp.test'],
            ['name' => 'Other Cashier', 'company_id' => $other->id, 'password' => 'Password123!', 'is_active' => true],
        );
        $cashier->syncRoles(SystemRole::Cashier->value);
        $category = Category::query()->firstOrCreate(['company_id' => $other->id, 'name' => 'Other goods'], ['is_active' => true]);
        PaymentMethod::query()->firstOrCreate(
            ['company_id' => $other->id, 'code' => 'cash'],
            ['name' => 'Cash', 'type' => PaymentMethodType::Cash, 'allows_change' => true, 'requires_reference' => false, 'sort_order' => 1, 'is_active' => true],
        );
        if (! Product::query()->where('company_id', $other->id)->exists()) {
            app(CreateProductAction::class)->execute(new CreateProductData(
                companyId: $other->id,
                categoryId: $category->id,
                name: 'Other Service',
                sku: 'OTHER-SVC',
                barcode: null,
                description: null,
                status: ProductStatus::Active,
                isActive: true,
                trackStock: false,
                unit: null,
                taxMode: ProductTaxMode::None,
                taxId: null,
                price: 1_000,
            ));
        }

        return ['company' => $other->uuid, 'branch' => $branch->uuid, 'warehouse' => $warehouse->uuid];
    })(),
    'move-device-other' => DB::transaction(function () use ($argument, $company): array {
        $other = Company::query()->where('code', 'OTHER-CO')->firstOrFail();
        $device = DesktopDevice::query()->where('company_id', $company->id)->where('device_uuid', $argument)->firstOrFail();
        $device->forceFill(['company_id' => $other->id, 'branch_id' => null, 'warehouse_id' => null])->save();

        return ['moved' => true, 'simulated' => true];
    }),
    'assign-device-other' => DB::transaction(function () use ($argument, $actor): array {
        $other = Company::query()->where('code', 'OTHER-CO')->firstOrFail();
        $device = DesktopDevice::query()->where('company_id', $other->id)->where('device_uuid', $argument)->firstOrFail();
        $branch = Branch::query()->where('company_id', $other->id)->where('name', 'Other Branch')->firstOrFail();
        $warehouse = Warehouse::query()->where('company_id', $other->id)->where('name', 'Other Warehouse')->firstOrFail();
        app(DeviceAssignmentFenceService::class)->applyAssignment($device, $branch->id, $warehouse->id, $actor->id);

        return ['assigned' => true];
    }),
    'product-image' => (function () use ($argument, $company, $actor): array {
        [$sku, $variant] = explode(':', $argument);
        $product = Product::query()->where('company_id', $company->id)->where('sku', $sku)->firstOrFail();
        $revision = (int) (ProductImage::query()->where('product_id', $product->id)->value('revision') ?? 0);
        $images = app(ChangeProductImageAction::class);
        if ($variant === 'remove') {
            return ['revision' => $images->remove($product, $revision)->revision, 'thumb_sha256' => null];
        }
        [$width, $height, $rgb] = ['1' => [480, 360, [200, 40, 40]], '2' => [360, 480, [40, 140, 60]], '3' => [400, 400, [40, 80, 200]]][$variant];
        $image = imagecreatetruecolor($width, $height);
        imagefill($image, 0, 0, imagecolorallocate($image, ...$rgb));
        imagefilledellipse($image, intdiv($width, 2), intdiv($height, 2), intdiv($width, 2), intdiv($height, 2), imagecolorallocate($image, 250, 250, 250));
        ob_start();
        imagepng($image);
        $assets = app(StoreProductImageAction::class)->execute($company->id, $actor->id, (string) ob_get_clean());
        $saved = $images->set($product, $assets['display']->id, $assets['thumb']->id, $revision);

        return ['revision' => $saved->revision, 'thumb_sha256' => $assets['thumb']->sha256, 'display_sha256' => $assets['display']->sha256];
    })(),
    'record-opening-stock' => (function () use ($argument, $company, $warehouse, $actor): array {
        [$sku, $quantity] = explode(':', $argument, 2);
        $product = Product::query()->where('company_id', $company->id)->where('sku', $sku)->firstOrFail();

        try {
            $row = app(\App\Modules\Inventory\Actions\RecordOpeningStockAction::class)->execute(
                $company->id, $product->id, new \App\Modules\Inventory\Data\OpeningStockData($warehouse->id, $quantity), $actor->id,
            );

            return ['result' => 'recorded', 'quantity' => $row->quantity];
        } catch (\App\Shared\Exceptions\ApiException $refusal) {
            return ['result' => 'refused', 'code' => $refusal->errorCode->value];
        }
    })(),
    // Phase 3: the platform decision, taken by a company-less platform account through the real actions.
    'suspend-company', 'resume-company' => (function () use ($operation, $argument, $company): array {
        $platform = User::query()->firstOrCreate(
            ['email' => 'platform.fixture@desktop-mvp.test'],
            ['name' => 'Platform Fixture', 'password' => 'Password123!', 'company_id' => null, 'is_active' => true],
        );
        $company->refresh();
        $action = $operation === 'suspend-company'
            ? app(\App\Modules\Tenancy\Actions\SuspendPlatformCompanyAction::class)
            : app(\App\Modules\Tenancy\Actions\ResumePlatformCompanyAction::class);
        $outcome = $action->execute($platform, $company, $argument !== '' ? $argument : 'Electron journey '.$operation, (int) $company->suspension_revision, (string) \Illuminate\Support\Str::uuid());
        $company->refresh();

        return ['applied' => $outcome->refusal === null, 'refusal' => $outcome->refusal?->getStatusCode(),
            'state' => $company->current_suspension_id === null ? 'active' : 'suspended', 'revision' => (int) $company->suspension_revision];
    })(),
    'inspect-suspension' => (function () use ($company): array {
        $company->refresh();
        $current = $company->current_suspension_id;

        return [
            'state' => $current === null ? 'active' : 'suspended',
            'revision' => (int) $company->suspension_revision,
            'is_active' => (bool) $company->is_active,
            'offline_limits_enforced' => (bool) config('pos_offline_sale.offline_limits.enforced'),
            'intervals' => DB::table('company_suspensions')->where('company_id', $company->id)->count(),
            'uploads' => DB::table('company_suspension_uploads')->where('company_id', $company->id)->orderBy('id')
                ->get(['company_suspension_id', 'kind', 'local_uuid', 'flagged', 'flag_reasons'])->map(fn ($row): array => (array) $row)->all(),
            'device_notices' => DB::table('company_suspension_device_notices')->count(),
            'authorities' => DB::table('pos_offline_sale_authorities')->where('company_id', $company->id)->orderBy('id')
                ->get(['uuid', 'issued_at', 'not_after', 'superseded_at', 'revoked_at'])->map(fn ($row): array => (array) $row)->all(),
            'bindings' => [
                'active' => DB::table('desktop_access_tokens')->where('company_id', $company->id)->whereNull('revoked_at')->count(),
                'revoked' => DB::table('desktop_access_tokens')->where('company_id', $company->id)->whereNotNull('revoked_at')->count(),
            ],
            'license_tokens' => DB::table('license_tokens')->count(),
        ];
    })(),
    'subscription-lapse' => (function () use ($company): array {
        $subscription = $company->currentSubscription()->firstOrFail();
        $subscription->forceFill(['expires_at' => now()->subDays(30), 'grace_ends_at' => now()->subDays(20)])->save();

        return ['subscription' => $subscription->id, 'expires_at' => (string) $subscription->expires_at, 'grace_ends_at' => (string) $subscription->grace_ends_at, 'injected' => true];
    })(),
    'subscription-request' => (function () use ($company, $actor): array {
        $platform = User::query()->firstOrCreate(
            ['email' => 'platform.fixture@desktop-mvp.test'],
            ['name' => 'Platform Fixture', 'password' => 'Password123!', 'company_id' => null, 'is_active' => true],
        );
        $current = $company->currentSubscription()->with('plan')->firstOrFail();
        $order = app(\App\Modules\Subscriptions\Actions\CreateCompanySubscriptionOrderAction::class)->execute($company->id, $actor, [
            'plan_uuid' => $current->plan->uuid, 'billing_cycle' => $current->billing_cycle->value, 'addons' => [], 'notes' => 'Electron journey renewal',
        ]);
        app(\App\Modules\Subscriptions\Actions\ReviewSubscriptionOrderAction::class)->execute($platform, $order, true, 'Electron journey: verified', null, (int) $order->revision, (string) \Illuminate\Support\Str::uuid());
        if ((int) $order->fresh()->total_amount > 0) {
            app(\App\Modules\Subscriptions\Actions\RecordManualSubscriptionPaymentAction::class)->execute($order->fresh(), $platform, [
                'amount' => (int) $order->total_amount, 'currency' => $order->currency, 'method' => 'bank_transfer', 'reference' => 'EJ-'.$order->uuid,
            ]);
        }
        $plan = app(\App\Modules\Subscriptions\Services\SubscriptionActivationPlanner::class)->plan($order->fresh(), $company->fresh());

        try {
            $created = app(\App\Modules\Subscriptions\Actions\ActivateSubscriptionOrderAction::class)->execute($order->fresh(), $platform, $plan->fingerprint);
        } catch (\App\Shared\Exceptions\ApiException $refusal) {
            return ['order' => $order->uuid, 'activated' => false, 'refusal' => $refusal->errorCode->value];
        }

        return ['order' => $order->uuid, 'activated' => true, 'outcome' => $created->starts_at?->isFuture() ? 'scheduled' : 'started',
            'starts_at' => (string) $created->starts_at, 'expires_at' => (string) $created->expires_at, 'grace_ends_at' => (string) $created->grace_ends_at];
    })(),
    'subscription-end-soon' => (function () use ($company, $argument): array {
        $subscription = $company->currentSubscription()->firstOrFail();
        $end = now()->addSeconds((int) $argument)->startOfSecond();
        $subscription->forceFill(['expires_at' => $end, 'renews_at' => $end, 'grace_ends_at' => $end])->save();

        return ['subscription' => $subscription->id, 'expires_at' => (string) $subscription->expires_at, 'grace_ends_at' => (string) $subscription->grace_ends_at, 'injected' => true];
    })(),
    'plan-capacity-change' => (function () use ($company): array {
        $platform = User::query()->firstOrCreate(
            ['email' => 'platform.fixture@desktop-mvp.test'],
            ['name' => 'Platform Fixture', 'password' => 'Password123!', 'company_id' => null, 'is_active' => true],
        );
        $plan = $company->currentSubscription()->with('plan')->firstOrFail()->plan;
        $devices = (int) ($plan->limits['desktop_devices'] ?? 0) + 1;
        app(\App\Modules\Subscriptions\Actions\Platform\UpdatePlatformPlanAction::class)->execute($platform, $plan, ['limits' => ['desktop_devices' => $devices]], (int) $plan->revision, (string) \Illuminate\Support\Str::uuid());

        return ['plan' => $plan->uuid, 'desktop_devices' => $plan->fresh()->limits['desktop_devices'] ?? null, 'revision' => (int) $plan->fresh()->revision];
    })(),
    'inspect-subscription' => (function () use ($company): array {
        $row = fn (?CompanySubscription $subscription): ?array => $subscription === null ? null : [
            'id' => $subscription->id, 'status' => $subscription->status->value, 'starts_at' => (string) $subscription->starts_at,
            'expires_at' => (string) $subscription->expires_at, 'grace_ends_at' => (string) $subscription->grace_ends_at,
        ];

        return [
            'current' => $row($company->currentSubscription()->first()),
            'scheduled' => $row($company->scheduledSubscription()->first()),
            'rows' => CompanySubscription::query()->where('company_id', $company->id)->count(),
            'offline_limits_enforced' => (bool) config('pos_offline_sale.offline_limits.enforced'),
            'authorities' => DB::table('pos_offline_sale_authorities')->where('company_id', $company->id)->orderBy('id')
                ->get(['uuid', 'issued_at', 'not_after', 'superseded_at', 'revoked_at'])->map(fn ($row): array => (array) $row)->all(),
            // Phase 4 closeout: the coverage decision of the latest licence validation (audit context; absent before it).
            'coverage' => \App\Modules\Licensing\Models\LicenseEvent::query()->where('company_id', $company->id)->latest('id')->first()?->context['offline_coverage'] ?? null,
        ];
    })(),
    'authorities' => [
        'authorities' => DB::table('pos_offline_sale_authorities')->orderBy('id')
            ->get(['uuid', 'warehouse_id', 'issued_at', 'not_after', 'superseded_at'])
            ->map(fn ($row): array => (array) $row)->all(),
    ],
    // POS improvements, Stage 1 (read-only): register quick-create results, uuid bindings, the created
    // entities and each staff member's quick-create grants.
    'quick-create-grant' => (function () use ($argument, $company): array {
        [$who, $permission, $on] = explode(':', $argument);
        $user = User::query()->where('company_id', $company->id)->where('email', "{$who}@desktop-mvp.test")->firstOrFail();
        $model = Spatie\Permission\Models\Permission::findOrCreate($permission, 'web');
        $on === '1' ? $user->givePermissionTo($model) : $user->revokePermissionTo($model);
        app(Spatie\Permission\PermissionRegistrar::class)->forgetCachedPermissions();

        return ['user' => $user->email, 'permission' => $permission, 'granted' => $on === '1',
            'direct' => $user->fresh()->getDirectPermissions()->pluck('name')->sort()->values()->all()];
    })(),
    'mixed-tax-catalog' => (function () use ($company, $actor): array {
        $context = app(CurrentCompanyResolver::class)->resolve($actor);
        app()->instance(CompanyContext::class, $context);
        $category = Category::query()->where('company_id', $company->id)->orderBy('id')->firstOrFail();
        $tax = fn (string $code, string $rate, string $taxCategory) => Tax::query()->where('company_id', $company->id)->where('code', $code)->first()
            ?? app(CreateTaxAction::class)->execute(new CreateTaxData(
                companyId: $company->id, name: $code, code: $code, rate: $rate, type: TaxType::Percentage,
                isDefault: false, isActive: true, category: TaxCategory::from($taxCategory),
            ));
        $standard = $tax('QC4-VAT15', '15.00', 'standard');
        $zero = $tax('QC4-ZERO', '0.00', 'zero_rated');
        $exempt = $tax('QC4-EXEMPT', '0.00', 'exempt');
        $products = [];

        foreach ([
            ['MIX-INC', 'Qc4 Inclusive', 1150, 'inclusive', $standard, '7780000000011'],
            ['MIX-ZERO', 'Qc4 Zero-rated', 250, 'exclusive', $zero, '7780000000028'],
            ['MIX-EXEMPT', 'Qc4 Exempt', 700, 'inclusive', $exempt, '7780000000035'],
        ] as [$sku, $name, $price, $mode, $productTax, $barcode]) {
            $existing = Product::query()->where('company_id', $company->id)->where('sku', $sku)->first();

            if ($existing === null) {
                $request = OwnerStoreProductRequest::create('/api/v1/company-owner/products', 'POST', [
                    'name' => $name, 'category_id' => $category->uuid, 'sku' => $sku, 'barcode' => $barcode,
                    'price' => $price, 'tax_mode' => $mode, 'tax_id' => $productTax->uuid, 'track_stock' => false,
                ]);
                $request->setContainer(app())->setRedirector(app('redirect'));
                $request->setUserResolver(fn () => $actor);
                $request->validateResolved();
                $existing = app(CreateProductAction::class)->execute(CreateProductData::fromRequest($request, $context));
            }

            $products[$sku] = ['uuid' => $existing->uuid, 'barcode' => $existing->barcode, 'tax_mode' => $existing->tax_mode?->value, 'tax_category' => $productTax->category?->value];
        }

        return ['products' => $products, 'precondition' => true];
    })(),
    'create-named-products' => (function () use ($argument, $company, $actor): array {
        $context = app(CurrentCompanyResolver::class)->resolve($actor);
        app()->instance(CompanyContext::class, $context);
        $category = Category::query()->where('company_id', $company->id)->orderBy('id')->firstOrFail();
        $tax = fn (string $code, string $rate, string $taxCategory) => Tax::query()->where('company_id', $company->id)->where('code', $code)->first()
            ?? app(CreateTaxAction::class)->execute(new CreateTaxData(
                companyId: $company->id, name: $code, code: $code, rate: $rate, type: TaxType::Percentage,
                isDefault: false, isActive: true, category: TaxCategory::from($taxCategory),
            ));
        $standard = $tax('WS-VAT15', '15.00', 'standard');
        $exempt = $tax('WS-EXEMPT', '0.00', 'exempt');
        $names = [
            ['Al Marai Full Cream Fresh Milk 1.5 L', 1150],
            ['حليب المراعي كامل الدسم طازج 1 لتر', 690],
            ['Nescafé Gold Blend Instant Coffee Jar 200 g', 4275],
            ['Lurpak Slightly Salted Butter Block 400 g', 2890],
            ['أرز بسمتي هندي فاخر طويل الحبة 5 كجم', 5450],
            ['Barilla Spaghetti No. 5 Durum Wheat Pasta 500 g', 875],
            ['Heinz Tomato Ketchup Squeezy Bottle 570 g', 1325],
            ['Fairy Original Washing Up Liquid Lemon 1.19 L', 1599],
            ['تمر سكري القصيم ممتاز علبة 1 كجم', 3800],
            ['Galaxy Smooth Milk Chocolate Bar 90 g', 650],
            ['Pampers Premium Protection Baby Diapers Size 4 Maxi 9–14 kg Jumbo Pack 76 Count', 11900],
            ["Kellogg's Corn Flakes Original Breakfast Cereal 750 g", 2150],
            ['زيت زيتون بكر ممتاز معصور على البارد 750 مل', 4625],
            ['Tide Automatic Laundry Detergent Powder Original Scent 6 kg', 7350],
            ['Lipton Yellow Label Black Tea 100 Tea Bags', 1875],
            ['Fresh Bananas (loose, per kg)', 799],
            ['طماطم طازجة محلية بالكيلو', 450],
            ['Colgate Total Advanced Whitening Toothpaste 125 ml', 1450],
            ['Almarai Greek Style Natural Yoghurt Low Fat 500 g', 925],
            ['Philips Hue White and Colour Ambiance Smart LED Bulb E27 9 W with Bluetooth, 2-Pack Starter Edition', 24900],
            ['Nido Fortified Full Cream Milk Powder Tin 2.25 kg', 8950],
            ['Red Bull Energy Drink Can 250 ml', 750],
            ['جبنة فيتا بيضاء قليلة الدسم 500 جم', 1700],
            ['Dettol Antibacterial Surface Cleansing Wipes 40 Count', 1395],
            ['Sunflower Seeds Roasted & Salted (bulk, per kg)', 3250],
        ];
        $products = [];

        foreach (array_slice($names, 0, (int) $argument) as $index => [$name, $price]) {
            $number = str_pad((string) ($index + 1), 2, '0', STR_PAD_LEFT);
            $sku = "WS-{$number}";
            $barcode = "62910000000{$number}";
            $standardTax = $index % 2 === 0;
            $existing = Product::query()->where('company_id', $company->id)->where('sku', $sku)->first();

            if ($existing === null) {
                $request = OwnerStoreProductRequest::create('/api/v1/company-owner/products', 'POST', [
                    'name' => $name, 'category_id' => $category->uuid, 'sku' => $sku, 'barcode' => $barcode,
                    'price' => $price, 'tax_mode' => $standardTax ? 'exclusive' : 'inclusive',
                    'tax_id' => ($standardTax ? $standard : $exempt)->uuid, 'track_stock' => false,
                ]);
                $request->setContainer(app())->setRedirector(app('redirect'));
                $request->setUserResolver(fn () => $actor);
                $request->validateResolved();
                $existing = app(CreateProductAction::class)->execute(CreateProductData::fromRequest($request, $context));
            }

            $products[] = ['sku' => $existing->sku, 'barcode' => $existing->barcode, 'name' => $existing->name,
                'uuid' => $existing->uuid, 'price' => $price, 'track_stock' => (bool) $existing->track_stock];
        }

        return ['products' => $products, 'precondition' => true];
    })(),
    'create-plain-products' => (function () use ($argument, $company, $actor): array {
        $context = app(CurrentCompanyResolver::class)->resolve($actor);
        app()->instance(CompanyContext::class, $context);
        $category = Category::query()->where('company_id', $company->id)->orderBy('id')->firstOrFail();
        $tax = Tax::query()->where('company_id', $company->id)->where('code', 'WS-VAT15')->first()
            ?? app(CreateTaxAction::class)->execute(new CreateTaxData(
                companyId: $company->id, name: 'WS-VAT15', code: 'WS-VAT15', rate: '15.00', type: TaxType::Percentage,
                isDefault: false, isActive: true, category: TaxCategory::from('standard'),
            ));
        $names = [
            ['Fresh Milk 1 L', 650], ['Brown Bread', 450], ['Eggs 12 pack', 1250], ['Basmati Rice 2 kg', 2400],
            ['حليب طازج 1 لتر', 650], ['Bananas per kg', 799], ['Tomatoes per kg', 450], ['Sugar 1 kg', 520],
            ['Green Tea 25 bags', 1100], ['Bottled Water 1.5 L', 250], ['تمر سكري', 1900], ['Olive Oil 500 ml', 2850],
            ['Cheddar Cheese', 1675], ['Orange Juice 1 L', 925], ['Pasta 500 g', 600], ['جبنة بيضاء', 1300],
            ['Butter 200 g', 1450], ['Yoghurt 500 g', 575], ['Coffee 250 g', 3200], ['Dish Soap', 899],
            ['Chicken Breast', 3450], ['Lentils 1 kg', 980], ['Honey 250 g', 2100], ['Corn Flakes', 1550],
            ['Paper Towels', 1199],
        ];
        $products = [];

        foreach (array_slice($names, 0, (int) $argument) as $index => [$name, $price]) {
            $number = str_pad((string) ($index + 1), 2, '0', STR_PAD_LEFT);
            $sku = "PL-{$number}";
            $existing = Product::query()->where('company_id', $company->id)->where('sku', $sku)->first();

            if ($existing === null) {
                $request = OwnerStoreProductRequest::create('/api/v1/company-owner/products', 'POST', [
                    'name' => $name, 'category_id' => $category->uuid, 'sku' => $sku, 'barcode' => "62920000000{$number}",
                    'price' => $price, 'tax_mode' => 'exclusive', 'tax_id' => $tax->uuid, 'track_stock' => false,
                ]);
                $request->setContainer(app())->setRedirector(app('redirect'));
                $request->setUserResolver(fn () => $actor);
                $request->validateResolved();
                $existing = app(CreateProductAction::class)->execute(CreateProductData::fromRequest($request, $context));
            }

            $products[] = ['sku' => $existing->sku, 'barcode' => $existing->barcode, 'name' => $existing->name,
                'uuid' => $existing->uuid, 'track_stock' => (bool) $existing->track_stock];
        }

        return ['products' => $products, 'precondition' => true];
    })(),
    'offer-start' => (function () use ($argument, $company, $actor): array {
        if (($company->timezone ?? null) === null) {
            $company->forceFill(['timezone' => 'Asia/Riyadh'])->save();
        }
        $product = Product::query()->where('company_id', $company->id)->where('sku', $argument)->firstOrFail();
        $start = Carbon\CarbonImmutable::now('Asia/Riyadh')->subHour()->format('Y-m-d\\TH:i');
        $offer = app(App\Modules\Offers\Actions\SaveOfferAction::class)->create($company->id, $actor, new App\Modules\Offers\Data\OfferData(
            name: 'Journey 10% off', type: App\Modules\Offers\Enums\OfferType::Percentage, value: 1000, priority: 0,
            appliesToPos: true, appliesToInvoices: false, allProducts: false, startsLocal: $start, endsLocal: null,
            productIds: [$product->id], categoryIds: [],
        ));
        $offer = app(App\Modules\Offers\Actions\ActivateOfferAction::class)->execute($offer, $actor, (int) $offer->revision);

        return ['offer' => $offer->uuid, 'revision' => DB::table('offer_revisions')->where('id', $offer->current_revision_id)->value('uuid'),
            'timezone' => $company->fresh()->timezone, 'starts_local' => $start, 'product' => $product->uuid, 'precondition' => true];
    })(),
    'offer-end' => (function () use ($company, $actor): array {
        $offer = App\Modules\Offers\Models\Offer::query()->where('company_id', $company->id)->where('status', 'active')->orderByDesc('id')->firstOrFail();
        $ended = app(App\Modules\Offers\Actions\EndOfferAction::class)->execute($offer, $actor, (int) $offer->revision);

        return ['offer' => $ended->uuid, 'status' => $ended->status->value,
            'revoked_at' => DB::table('offer_revisions')->where('id', $ended->current_revision_id)->value('revoked_at')];
    })(),
    'offer-report' => (function () use ($company): array {
        $device = DesktopDevice::query()->where('company_id', $company->id)->orderByDesc('id')->firstOrFail();

        return [
            'contracts' => DB::table('desktop_catalog_contracts')->where('desktop_device_id', $device->id)->orderBy('id')->get(['revision', 'offer_revisions'])
                ->map(fn ($row): array => ['revision' => $row->revision, 'offers' => array_keys((array) json_decode((string) ($row->offer_revisions ?? 'null'), true))])->all(),
            'revisions' => DB::table('offer_revisions')->where('company_id', $company->id)->orderBy('id')->get(['uuid', 'revoked_at'])->map(fn ($row): array => (array) $row)->all(),
            'invoices' => DB::table('pos_invoices')->where('desktop_device_id', $device->id)->orderBy('id')->get()->map(fn ($invoice): array => [
                'idempotency_key' => $invoice->idempotency_key,
                'contract_version' => DB::table('desktop_invoice_syncs')->where('pos_invoice_id', $invoice->id)->value('client_contract_version'),
                'sync_records' => DB::table('desktop_invoice_syncs')->where('local_invoice_uuid', $invoice->idempotency_key)->count(),
                'grand' => (int) $invoice->grand_total_amount, 'discount' => (int) $invoice->discount_total_amount,
                'items' => DB::table('pos_invoice_items')->where('pos_invoice_id', $invoice->id)->orderBy('id')
                    ->get(['product_uuid', 'discount_type', 'discount_value', 'discount_amount', 'total_amount', 'offer_snapshot'])
                    ->map(fn ($row): array => [...(array) $row, 'offer_snapshot' => json_decode((string) ($row->offer_snapshot ?? 'null'), true)])->all(),
            ])->all(),
        ];
    })(),
    'mixed-tax-report' => (function () use ($company): array {
        $device = DesktopDevice::query()->where('company_id', $company->id)->orderByDesc('id')->firstOrFail();
        $invoices = DB::table('pos_invoices')->where('desktop_device_id', $device->id)->orderBy('id')->get();

        return [
            'contracts' => DB::table('desktop_catalog_contracts')->where('desktop_device_id', $device->id)->orderBy('id')
                ->pluck('mixed_tax_mode_policy')->all(),
            'invoices' => $invoices->map(fn ($invoice): array => [
                'idempotency_key' => $invoice->idempotency_key,
                'tax_mode' => $invoice->tax_mode,
                'contract_version' => DB::table('desktop_invoice_syncs')->where('pos_invoice_id', $invoice->id)->value('client_contract_version'),
                'offline_sale_authority' => $invoice->offline_sale_authority_id !== null,
                'subtotal' => (int) $invoice->subtotal_amount, 'discount' => (int) $invoice->discount_total_amount,
                'tax' => (int) $invoice->tax_total_amount, 'grand' => (int) $invoice->grand_total_amount,
                // Side effects a replayed upload must never repeat (read-only counts).
                'sync_records' => DB::table('desktop_invoice_syncs')->where('local_invoice_uuid', $invoice->idempotency_key)->count(),
                'stock_movements' => DB::table('stock_movements')->where('pos_invoice_id', $invoice->id)->count(),
                'accounting_journals' => DB::table('accounting_journals')->where('source_type', 'pos_invoice')->where('source_id', $invoice->id)->count(),
                'items' => DB::table('pos_invoice_items')->where('pos_invoice_id', $invoice->id)->orderBy('id')
                    ->get(['product_uuid', 'tax_mode', 'tax_category', 'tax_amount', 'total_amount', 'discount_amount', 'subtotal_amount'])
                    ->map(fn ($row): array => (array) $row)->all(),
                'refunds' => DB::table('pos_refunds')->where('pos_invoice_id', $invoice->id)->orderBy('id')->get()
                    ->map(fn ($refund): array => [
                        'tax' => (int) $refund->tax_total_amount, 'grand' => (int) $refund->grand_total_amount,
                        'items' => DB::table('pos_refund_items')->where('pos_refund_id', $refund->id)->orderBy('id')
                            ->get(['product_uuid', 'tax_mode', 'tax_category', 'quantity', 'tax_amount', 'total_amount'])
                            ->map(fn ($row): array => (array) $row)->all(),
                    ])->all(),
            ])->all(),
        ];
    })(),
    'quick-create-report' => [
        'requests' => DB::table('desktop_entity_create_requests')->where('company_id', $company->id)->orderBy('id')
            ->get(['entity_type', 'request_key', 'client_entity_uuid', 'outcome', 'response_status', 'response_body', 'user_id', 'desktop_device_id'])
            ->map(fn ($row): array => [
                'entity_type' => $row->entity_type,
                'request_key' => $row->request_key,
                'client_entity_uuid' => $row->client_entity_uuid,
                'outcome' => $row->outcome,
                'status' => (int) $row->response_status,
                'code' => json_decode((string) $row->response_body, true)['code'] ?? null,
                'user_email' => DB::table('users')->where('id', $row->user_id)->value('email'),
            ])->all(),
        'bindings' => DB::table('desktop_entity_uuid_bindings')->where('company_id', $company->id)
            ->get(['entity_type', 'client_entity_uuid', 'request_key'])->map(fn ($row): array => (array) $row)->all(),
        'customers' => DB::table('customers')->where('company_id', $company->id)->orderBy('id')->get(['uuid', 'name'])->map(fn ($row): array => (array) $row)->all(),
        'suppliers' => DB::table('suppliers')->where('company_id', $company->id)->orderBy('id')->get(['uuid', 'name'])->map(fn ($row): array => (array) $row)->all(),
        'products' => DB::table('products')->where('company_id', $company->id)->orderBy('id')->get(['uuid', 'sku', 'name'])->map(fn ($row): array => (array) $row)->all(),
        'grants' => DB::table('users')->where('company_id', $company->id)->orderBy('id')->get(['id', 'email'])
            ->mapWithKeys(fn ($user): array => [$user->email => DB::table('model_has_permissions')
                ->join('permissions', 'permissions.id', '=', 'model_has_permissions.permission_id')
                ->where('model_has_permissions.model_id', $user->id)
                ->where('model_has_permissions.model_type', App\Models\User::class)
                ->orderBy('permissions.name')->pluck('permissions.name')->all()])->all(),
    ],
    'devices' => [
        'devices' => DesktopDevice::query()->where('company_id', $company->id)->orderBy('id')->get()
            ->map(fn (DesktopDevice $device): array => [
                'device_uuid' => $device->device_uuid,
                'server_uuid' => $device->uuid,
                'warehouse_assigned' => $device->warehouse_id !== null,
            ])->all(),
    ],
    'allocations' => (function () use ($argument, $company): array {
        $device = DesktopDevice::query()->where('company_id', $company->id)->where('device_uuid', $argument)->firstOrFail();

        return [
            'revision' => (int) DB::table('stock_allocation_lifecycle_audits')->where('desktop_device_id', $device->id)->max('id'),
            'allocations' => DB::table('stock_allocations')->where('desktop_device_id', $device->id)
                ->select('uuid', 'status', 'granted_quantity_milli', 'consumed_quantity_milli', 'lifecycle_generation')
                ->orderBy('id')->get()->all(),
            'requests' => DB::table('stock_allocation_requests')->where('desktop_device_id', $device->id)->count(),
        ];
    })(),
};

fwrite(STDOUT, json_encode($result, JSON_UNESCAPED_SLASHES) . "\n");
exit(0);
