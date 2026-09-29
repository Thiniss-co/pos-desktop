<?php

declare(strict_types=1);

/**
 * Fixture steps for driving the real Electron app against a disposable Laravel backend seeded with
 * `DesktopMvpSmokeSeeder` (see docs/design/claude-v3/verification/README.md, "GUI sandbox").
 *
 *   php guiFixture.php <backend-root> assign-device <device-uuid>
 *   php guiFixture.php <backend-root> mode-physical-presence
 *   php guiFixture.php <backend-root> mode-allocation <SKU>[,<SKU>...]
 *   php guiFixture.php <backend-root> report <device-uuid>
 *   php guiFixture.php <backend-root> create-owner-product <SKU>
 *   php guiFixture.php <backend-root> receive-stock <SKU>:<quantity>
 *   php guiFixture.php <backend-root> stock <SKU>
 *   php guiFixture.php <backend-root> device <device-uuid>
 *   php guiFixture.php <backend-root> allocations <device-uuid>
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
use App\Modules\Catalog\Actions\CreateProductAction;
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

if (! in_array($operation, ['assign-device', 'mode-physical-presence', 'mode-allocation', 'report', 'create-owner-product', 'receive-stock', 'stock', 'device', 'allocations'], true)) {
    sandboxRefuse('unknown fixture operation');
}

if (in_array($operation, ['create-owner-product', 'stock'], true) && preg_match('/^[A-Z0-9-]{1,40}$/', $argument) !== 1) {
    sandboxRefuse('a SKU is required');
}

if ($operation === 'receive-stock' && preg_match('/^[A-Z0-9-]{1,40}:\d{1,6}(\.\d{1,3})?$/', $argument) !== 1) {
    sandboxRefuse('receive-stock needs <SKU>:<quantity>');
}

if (in_array($operation, ['assign-device', 'report', 'device', 'allocations'], true)
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
            maxOfflineHours: 72,
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
            ];
        }

        return [
            'device_assigned' => $device->warehouse_id !== null && $device->branch_id !== null,
            'invoices' => $invoices,
            'device_invoice_count' => DB::table('pos_invoices')->where('desktop_device_id', $device->id)->count(),
        ];
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
