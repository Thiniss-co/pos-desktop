<script setup lang="ts">
/**
 * POS improvements — records created on this register and what happened to them. "Pending sync"
 * and "Ready to sell" are different states; a refused or blocked record says what to do next, and a
 * sale that depends on it waits (it is never dropped).
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { QuickCreateRecord, QuickCreateStatus } from '@shared/contracts/quickCreate.contract'
import AppButton from '../../../shared/components/common/AppButton.vue'
import AppPanel from '../../../shared/components/common/AppPanel.vue'
import AppStatusChip from '../../../shared/components/feedback/AppStatusChip.vue'
import AppInlineError from '../../../shared/components/feedback/AppInlineError.vue'
import { useQuickCreateStore } from '../store'
import QuickCreateDialog from './QuickCreateDialog.vue'

const { t } = useI18n()
const store = useQuickCreateStore()
const busyKey = ref<string | null>(null)
const problem = ref<string | null>(null)
const correcting = ref<QuickCreateRecord | null>(null)

const visible = computed(() => store.records.filter((record) => record.status !== 'superseded'))

const VARIANT: Record<
  QuickCreateStatus,
  'success' | 'warning' | 'error' | 'information' | 'neutral'
> = {
  pending_sync: 'information',
  waiting_for_creator: 'warning',
  blocked: 'warning',
  refused: 'error',
  conflict: 'error',
  superseded: 'neutral',
  created: 'success',
  awaiting_catalog: 'information',
  ready_to_sell: 'success'
}

async function act(record: QuickCreateRecord, action: 'retry' | 'reassign'): Promise<void> {
  busyKey.value = record.requestKey
  problem.value = null
  try {
    await (action === 'retry' ? store.retry(record.requestKey) : store.reassign(record.requestKey))
  } catch (error) {
    problem.value = (error as { message?: string })?.message ?? t('quickCreate.failed')
  } finally {
    busyKey.value = null
  }
}

function fieldErrors(record: QuickCreateRecord): string[] {
  return Object.values(record.resultFields ?? {})
    .flat()
    .slice(0, 4)
}

onMounted(() => void store.loadRecords())
</script>

<template>
  <AppPanel
    :padded="false"
    :title="t('quickCreate.records.title')"
    data-testid="quick-create-records"
  >
    <p v-if="visible.length === 0" class="px-4 py-5 text-sm text-muted">
      {{ t('quickCreate.records.empty') }}
    </p>
    <ul v-else class="divide-y divide-line">
      <li
        v-for="record in visible"
        :key="record.requestKey"
        class="flex flex-col gap-2 px-4 py-3"
        :data-testid="`quick-create-record-${record.entityUuid}`"
        :data-status="record.status"
      >
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-xs font-semibold tracking-wide text-muted uppercase">
            {{ t(`quickCreate.records.type.${record.entityType}`) }}
          </span>
          <span class="min-w-0 flex-1 truncate font-semibold" dir="auto">{{ record.name }}</span>
          <AppStatusChip :variant="VARIANT[record.status]" size="sm">
            {{ t(`quickCreate.records.status.${record.status}`) }}
          </AppStatusChip>
        </div>
        <p
          v-if="
            ['blocked', 'refused', 'conflict', 'waiting_for_creator', 'awaiting_catalog'].includes(
              record.status
            )
          "
          class="text-sm text-muted"
        >
          {{ t(`quickCreate.records.help.${record.status}`) }}
        </p>
        <ul v-if="fieldErrors(record).length > 0" class="list-disc ps-5 text-sm text-err">
          <li v-for="message in fieldErrors(record)" :key="message">{{ message }}</li>
        </ul>
        <div
          v-if="record.actions.retry || record.actions.reassign || record.actions.resubmit"
          class="flex flex-wrap gap-2"
        >
          <AppButton
            v-if="record.actions.retry"
            variant="secondary"
            size="sm"
            :loading="busyKey === record.requestKey"
            @click="act(record, 'retry')"
            >{{ t('quickCreate.records.retry') }}</AppButton
          >
          <AppButton
            v-if="record.actions.reassign"
            variant="secondary"
            size="sm"
            :loading="busyKey === record.requestKey"
            @click="act(record, 'reassign')"
            >{{ t('quickCreate.records.reassign') }}</AppButton
          >
          <AppButton
            v-if="record.actions.resubmit"
            variant="secondary"
            size="sm"
            @click="correcting = record"
            >{{ t('quickCreate.records.resubmit') }}</AppButton
          >
        </div>
      </li>
    </ul>
    <AppInlineError v-if="problem" class="px-4 pb-3">{{ problem }}</AppInlineError>
    <QuickCreateDialog
      v-if="correcting"
      :open="correcting !== null"
      :kind="correcting.entityType"
      :initial-name="correcting.name"
      :resubmit-key="correcting.requestKey"
      @close="correcting = null"
      @created="correcting = null"
    />
  </AppPanel>
</template>
