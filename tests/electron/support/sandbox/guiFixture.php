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
use App\Modules\Catalog\Actions\CreateProductAction;
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

if (! in_array($operation, ['assign-device', 'mode-physical-presence', 'mode-allocation', 'report', 'create-owner-product', 'receive-stock', 'stock', 'device', 'allocations', 'devices', 'set-tracking', 'adjust-stock', 'authorities', 'movements', 'owner-permission', 'company-feature', 'stock-position', 'record-opening-stock'], true)) {
    sandboxRefuse('unknown fixture operation');
}

if (in_array($operation, ['create-owner-product', 'stock'], true) && preg_match('/^[A-Z0-9-]{1,40}$/', $argument) !== 1) {
    sandboxRefuse('a SKU is required');
}

if ($operation === 'mode-physical-presence' && $argument !== ''
    && (preg_match('/^\d{1,2}$/', $argument) !== 1 || (int) $argument < 1 || (int) $argument > 72)) {
    sandboxRefuse('mode-physical-presence takes an optional window in hours (1-72)');
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

if (in_array($operation, ['assign-device', 'report', 'device', 'allocations', 'movements'], true)
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
        $subscription = \App\Modules\Subscriptions\Models\CompanySubscription::query()->where('company_id', $company->id)->orderByDesc('id')->firstOrFail();
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
    'authorities' => [
        'authorities' => DB::table('pos_offline_sale_authorities')->orderBy('id')
            ->get(['uuid', 'warehouse_id', 'issued_at', 'not_after', 'superseded_at'])
            ->map(fn ($row): array => (array) $row)->all(),
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
