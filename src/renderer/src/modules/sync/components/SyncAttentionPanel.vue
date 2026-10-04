<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type {
  SupportIssue,
  SupportIssueKind,
  SyncSupportIssues
} from '@shared/contracts/sync.contract'
import { formatDateTime } from '@renderer/shared/utils/format'
import { useLocaleStore } from '@renderer/modules/preferences/locale.store'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import AppIcon from '@renderer/shared/components/common/AppIcon.vue'
import AppInlineError from '@renderer/shared/components/feedback/AppInlineError.vue'
import AppLoadingSkeleton from '@renderer/shared/components/feedback/AppLoadingSkeleton.vue'
import AppPanel from '@renderer/shared/components/common/AppPanel.vue'
import AppStatusChip from '@renderer/shared/components/feedback/AppStatusChip.vue'
import type { IconName } from '@renderer/shared/components/common/icons.generated'

/**
 * POS reliability — the Sync page's "needs attention" section.
 *
 * Presentation only, over main's read-only projection. It deliberately offers **no** Retry,
 * acknowledge, close or delete action: an identity conflict can never succeed, a pending request
 * is resolved by main's reconciler, a legacy uncertainty stays open forever, and a waiting payment
 * is resolved on the POS screen. The only actions are copying a support reference and opening POS.
 */
defineProps<{
  issues: SyncSupportIssues | null
  loading: boolean
  error: string | null
}>()

const emit = defineEmits<{ 'open-pos': [] }>()

const { t } = useI18n()
const locale = useLocaleStore()
const copyStatus = ref<{ reference: string; ok: boolean } | null>(null)

const KIND_ICON: Record<SupportIssueKind, IconName> = {
  'allocation-identity-conflict': 'gpp_bad',
  'allocation-request-invalid': 'sync_problem',
  'legacy-dispatch-uncertainty': 'help',
  'allocation-request-pending': 'hourglass_top',
  'upload-held-by-predecessor': 'pause_circle',
  'upload-held-by-entity': 'person_off'
}

function when(iso: string | null): string {
  return iso ? formatDateTime(iso, locale.locale) : ''
}

async function copyReference(reference: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(reference)
    copyStatus.value = { reference, ok: true }
  } catch {
    // The reference stays selectable text, so a refused clipboard never blocks support.
    copyStatus.value = { reference, ok: false }
  }
}

function issueKey(issue: SupportIssue): string {
  return `${issue.kind}:${issue.reference}`
}
</script>

<template>
  <AppPanel
    class="sync-attention"
    :padded="false"
    :title="t('sync.attention.title')"
    :description="t('sync.attention.description')"
    aria-live="polite"
  >
    <div v-if="error" class="px-4 pt-3">
      <AppInlineError>{{ error }}</AppInlineError>
    </div>

    <div v-if="!issues && loading" class="px-4 py-3">
      <AppLoadingSkeleton :label="t('sync.attention.loading')" :lines="2" />
    </div>

    <template v-else-if="issues">
      <!-- Payment waiting on the POS screen: resolution stays in the POS recovery banner. -->
      <section
        v-if="issues.paymentAwaitingDecision"
        class="sync-attention__group sync-attention__payment flex flex-col gap-2 border-b border-line px-4 py-3.5"
        data-group="payment"
      >
        <h3 class="flex items-center gap-2 text-sm font-bold">
          <AppIcon name="point_of_sale" class="text-warn" />
          {{ t('sync.attention.payment.title') }}
        </h3>
        <p class="text-sm text-pretty">{{ t('sync.attention.payment.description') }}</p>
        <p
          v-if="!issues.paymentAwaitingDecision.retryAvailable"
          class="sync-attention__retry-unavailable text-sm font-semibold text-err"
        >
          {{ t('sync.attention.payment.retryUnavailable') }}
        </p>
        <p v-if="issues.paymentAwaitingDecision.legacyDispatchUnknown" class="text-sm text-muted">
          {{ t('sync.attention.payment.legacy') }}
        </p>
        <p v-if="issues.paymentAwaitingDecision.outstandingRequests > 0" class="text-sm text-muted">
          {{
            t('sync.attention.payment.outstanding', {
              count: issues.paymentAwaitingDecision.outstandingRequests
            })
          }}
        </p>
        <dl
          class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-notice bg-subtle p-3 text-xs select-text"
        >
          <dt class="text-muted">{{ t('sync.attention.reference') }}</dt>
          <dd class="sync-attention__reference code justify-self-start">
            {{ issues.paymentAwaitingDecision.reference }}
          </dd>
          <template v-if="issues.paymentAwaitingDecision.traceId">
            <dt class="text-muted">{{ t('sync.attention.traceId') }}</dt>
            <dd class="code justify-self-start break-all">
              {{ issues.paymentAwaitingDecision.traceId }}
            </dd>
          </template>
          <dt class="text-muted">{{ t('sync.attention.occurredAt') }}</dt>
          <dd class="numeric">{{ when(issues.paymentAwaitingDecision.claimedAt) }}</dd>
        </dl>
        <div class="flex flex-wrap gap-2">
          <AppButton
            variant="secondary"
            size="sm"
            icon="point_of_sale"
            data-action="open-pos"
            @click="emit('open-pos')"
          >
            {{ t('sync.attention.payment.openPos') }}
          </AppButton>
          <AppButton
            variant="ghost"
            size="sm"
            icon="content_copy"
            data-action="copy-reference"
            @click="copyReference(issues.paymentAwaitingDecision.reference)"
          >
            {{ t('sync.attention.copy') }}
          </AppButton>
        </div>
      </section>

      <!-- Needs support: integrity conflicts, invalid requests, open legacy uncertainties. -->
      <section
        class="sync-attention__group flex flex-col gap-2 border-b border-line px-4 py-3.5"
        data-group="support"
      >
        <h3 class="flex items-center gap-2 text-sm font-bold">
          <AppIcon name="shield" class="text-err" />
          {{ t('sync.attention.support.title') }}
          <span class="numeric text-muted">({{ issues.needsSupport.length }})</span>
        </h3>
        <p class="text-sm text-muted">{{ t('sync.attention.support.description') }}</p>
        <p v-if="issues.needsSupport.length === 0" class="text-sm text-muted">
          {{ t('sync.attention.support.empty') }}
        </p>
        <ul v-else class="flex flex-col gap-2">
          <li
            v-for="issue in issues.needsSupport"
            :key="issueKey(issue)"
            class="sync-attention__issue flex flex-col gap-1.5 rounded-lg border border-line p-3"
            :data-kind="issue.kind"
          >
            <div class="flex flex-wrap items-center gap-2 text-sm font-semibold">
              <AppIcon :name="KIND_ICON[issue.kind]" class="text-err" />
              <span>{{ t(`sync.attention.kind.${issue.kind}.title`) }}</span>
              <span class="flex-1" />
              <AppStatusChip variant="error" size="sm" :icon="KIND_ICON[issue.kind]">
                {{ t('sync.attention.support.title') }}
              </AppStatusChip>
            </div>
            <p class="text-sm text-pretty">{{ t(`sync.attention.kind.${issue.kind}.body`) }}</p>
            <p v-if="!issue.ownedByCurrentUser" class="text-xs text-muted">
              {{ t('sync.attention.otherCashier') }}
            </p>
            <ul v-if="issue.lines && issue.lines.length > 0" class="text-sm">
              <li v-for="(line, index) in issue.lines" :key="index" class="flex gap-2">
                <span>{{ line.productName ?? t('sync.attention.productUnavailable') }}</span>
                <span class="numeric text-muted">
                  {{ t('sync.attention.quantity', { quantity: line.quantity }) }}
                </span>
              </li>
            </ul>
            <dl
              class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-notice bg-subtle p-3 text-xs select-text"
            >
              <dt class="text-muted">{{ t('sync.attention.reference') }}</dt>
              <dd class="sync-attention__reference code justify-self-start">
                {{ issue.reference }}
              </dd>
              <template v-if="issue.relatedReference">
                <dt class="text-muted">{{ t('sync.attention.heldBehind') }}</dt>
                <dd class="sync-attention__related code justify-self-start">
                  {{ issue.relatedReference }}
                </dd>
              </template>
              <template v-if="issue.traceId">
                <dt class="text-muted">{{ t('sync.attention.traceId') }}</dt>
                <dd class="sync-attention__trace code justify-self-start break-all">
                  {{ issue.traceId }}
                </dd>
              </template>
              <dt class="text-muted">{{ t('sync.attention.occurredAt') }}</dt>
              <dd class="numeric">{{ when(issue.occurredAt) }}</dd>
              <template v-if="issue.updatedAt">
                <dt class="text-muted">{{ t('sync.attention.updatedAt') }}</dt>
                <dd class="numeric">{{ when(issue.updatedAt) }}</dd>
              </template>
            </dl>
            <div>
              <AppButton
                variant="ghost"
                size="sm"
                icon="content_copy"
                data-action="copy-reference"
                @click="copyReference(issue.reference)"
              >
                {{ t('sync.attention.copy') }}
              </AppButton>
            </div>
          </li>
        </ul>
      </section>

      <!-- Pending automatic reconciliation: not an error, and not confirmed either. -->
      <section class="sync-attention__group flex flex-col gap-2 px-4 py-3.5" data-group="automatic">
        <h3 class="flex items-center gap-2 text-sm font-bold">
          <AppIcon name="hourglass_top" class="text-info" />
          {{ t('sync.attention.automatic.title') }}
          <span class="numeric text-muted">({{ issues.automaticReconciliation.length }})</span>
        </h3>
        <p class="text-sm text-muted">{{ t('sync.attention.automatic.description') }}</p>
        <p v-if="issues.automaticReconciliation.length === 0" class="text-sm text-muted">
          {{ t('sync.attention.automatic.empty') }}
        </p>
        <ul v-else class="flex flex-col gap-2">
          <li
            v-for="issue in issues.automaticReconciliation"
            :key="issueKey(issue)"
            class="sync-attention__issue flex flex-col gap-1.5 rounded-lg border border-line p-3"
            :data-kind="issue.kind"
          >
            <div class="flex flex-wrap items-center gap-2 text-sm font-semibold">
              <AppIcon name="hourglass_top" class="text-info" />
              <span>{{ t(`sync.attention.kind.${issue.kind}.title`) }}</span>
            </div>
            <p class="text-sm text-pretty">{{ t(`sync.attention.kind.${issue.kind}.body`) }}</p>
            <p v-if="!issue.ownedByCurrentUser" class="text-xs text-muted">
              {{ t('sync.attention.otherCashier') }}
            </p>
            <ul v-if="issue.lines && issue.lines.length > 0" class="text-sm">
              <li v-for="(line, index) in issue.lines" :key="index" class="flex gap-2">
                <span>{{ line.productName ?? t('sync.attention.productUnavailable') }}</span>
                <span class="numeric text-muted">
                  {{ t('sync.attention.quantity', { quantity: line.quantity }) }}
                </span>
              </li>
            </ul>
            <p class="flex flex-wrap gap-x-4 text-xs text-muted">
              <span v-if="issue.sendCount !== null" class="numeric">
                {{ t('sync.attention.automatic.sendCount', { count: issue.sendCount }) }}
              </span>
              <span v-if="issue.nextAttemptAfter" class="numeric">
                {{
                  t('sync.attention.automatic.nextAttemptAfter', {
                    time: when(issue.nextAttemptAfter)
                  })
                }}
              </span>
            </p>
            <dl
              class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-notice bg-subtle p-3 text-xs select-text"
            >
              <dt class="text-muted">{{ t('sync.attention.reference') }}</dt>
              <dd class="sync-attention__reference code justify-self-start">
                {{ issue.reference }}
              </dd>
              <template v-if="issue.traceId">
                <dt class="text-muted">{{ t('sync.attention.traceId') }}</dt>
                <dd class="code justify-self-start break-all">{{ issue.traceId }}</dd>
              </template>
              <dt class="text-muted">{{ t('sync.attention.occurredAt') }}</dt>
              <dd class="numeric">{{ when(issue.occurredAt) }}</dd>
            </dl>
          </li>
        </ul>
      </section>

      <p
        v-if="
          !issues.paymentAwaitingDecision &&
          issues.needsSupport.length === 0 &&
          issues.automaticReconciliation.length === 0
        "
        class="sync-attention__none flex items-center gap-2.5 border-t border-line px-4 py-4 text-muted"
      >
        <AppIcon name="task_alt" :size="22" class="text-ok" />
        {{ t('sync.attention.none') }}
      </p>
    </template>

    <p v-if="copyStatus" class="sr-only" role="status">
      {{ copyStatus.ok ? t('sync.attention.copied') : t('sync.attention.copyFailed') }}
    </p>
    <p
      v-if="copyStatus && !copyStatus.ok"
      class="sync-attention__copy-failed px-4 pb-3 text-xs text-warn"
    >
      {{ t('sync.attention.copyFailed') }}
    </p>
  </AppPanel>
</template>
