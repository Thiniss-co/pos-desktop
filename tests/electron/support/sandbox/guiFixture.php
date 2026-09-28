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
use App\Modules\Catalog\Models\Product;
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

if (! in_array($operation, ['assign-device', 'mode-physical-presence', 'mode-allocation', 'report'], true)) {
    sandboxRefuse('unknown fixture operation');
}

if (in_array($operation, ['assign-device', 'report'], true)
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
};

fwrite(STDOUT, json_encode($result, JSON_UNESCAPED_SLASHES) . "\n");
exit(0);
