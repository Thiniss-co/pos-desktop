<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import type { CompanyUser } from '@shared/contracts/company-users.contract'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import AppConfirmDialog from '@renderer/shared/components/common/AppConfirmDialog.vue'
import AppIcon from '@renderer/shared/components/common/AppIcon.vue'
import AppTable from '@renderer/shared/components/common/AppTable.vue'
import AppEmptyState from '@renderer/shared/components/feedback/AppEmptyState.vue'
import AppInlineError from '@renderer/shared/components/feedback/AppInlineError.vue'
import AppLoadingSkeleton from '@renderer/shared/components/feedback/AppLoadingSkeleton.vue'
import AppProgress from '@renderer/shared/components/feedback/AppProgress.vue'
import AppStatusChip from '@renderer/shared/components/feedback/AppStatusChip.vue'
import AppInput from '@renderer/shared/components/forms/AppInput.vue'
import AppSegmented from '@renderer/shared/components/forms/AppSegmented.vue'
import PageContainer from '@renderer/shared/components/layout/PageContainer.vue'
import PageHeader from '@renderer/shared/components/layout/PageHeader.vue'
import { useCompanyUsersStore } from '../store'

const router = useRouter()
const companyUsers = useCompanyUsersStore()
const { access, error, isLoading, isMutating, list, query, remainingUsers } =
  storeToRefs(companyUsers)
const search = ref(query.value.search ?? '')
const statusFilter = ref(
  query.value.isActive === undefined ? '' : query.value.isActive ? 'active' : 'disabled'
)
const { t } = useI18n()

const statusOptions = computed(() => [
  { value: '', label: t('companyUsers.allUsers') },
  { value: 'active', label: t('common.enabled') },
  { value: 'disabled', label: t('common.disabled') }
])

const pendingUser = ref<CompanyUser | null>(null)

/**
 * Seat usage straight from the store's `remainingUsers` (plan `userLimit` minus the listed total).
 * The listed total only equals the company's user count when no search or status filter narrows
 * the list, so the card is shown for the unfiltered list only.
 */
const seats = computed(() => {
  const limit = access.value?.userLimit ?? null
  const isUnfiltered =
    !query.value.search && query.value.isActive === undefined && query.value.role === undefined
  if (limit === null || remainingUsers.value === null || !isUnfiltered) {
    return null
  }
  const used = list.value?.page.total ?? 0
  return {
    used,
    limit,
    percent: limit === 0 ? 100 : Math.min(100, Math.round((used / limit) * 100)),
    full: remainingUsers.value === 0
  }
})

const range = computed(() => {
  const page = list.value?.page
  if (!page || page.total === 0) {
    return null
  }
  const from = (page.page - 1) * page.perPage + 1
  const to = Math.min(page.page * page.perPage, page.total)
  return t('companyUsers.range', {
    from: from,
    to: to,
    total: page.total
  })
})

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((word) => word.charAt(0))
    .join('')
    .slice(0, 2)
    .toUpperCase()
}

onMounted(() => {
  void companyUsers.initialize()
})

function applySearch(): void {
  void companyUsers.refresh({ search: search.value || undefined, page: 1 })
}

function applyStatus(): void {
  void companyUsers.refresh({
    isActive: statusFilter.value === '' ? undefined : statusFilter.value === 'active',
    page: 1
  })
}

function onStatusChange(value: string): void {
  statusFilter.value = value
  applyStatus()
}

function changePage(page: number): void {
  void companyUsers.refresh({ page })
}

function openCreate(): void {
  void router.push('/company-users/create')
}

function openEdit(user: CompanyUser): void {
  void router.push({ name: 'company-user-edit', params: { uuid: user.uuid } })
}

function requestEnabledChange(user: CompanyUser): void {
  pendingUser.value = user
}

async function confirmEnabledChange(): Promise<void> {
  if (!pendingUser.value) {
    return
  }

  await companyUsers.setEnabled({
    uuid: pendingUser.value.uuid,
    enabled: !pendingUser.value.isActive
  })
  pendingUser.value = null
}
</script>

<template>
  <PageContainer class="company-users-page">
    <PageHeader
      :title="t('companyUsers.pageTitle')"
      :description="t('companyUsers.pageDescription')"
    >
      <template v-if="access?.canManage" #actions>
        <AppButton
          variant="primary"
          icon="person_add"
          class="company-users-page__add-link"
          @click="openCreate"
        >
          {{ t('companyUsers.addUser') }}
        </AppButton>
      </template>
    </PageHeader>

    <div
      v-if="seats"
      class="flex flex-col gap-2 rounded-lg border border-line bg-surf px-4 py-3.5"
      data-testid="company-users-seats"
    >
      <div class="flex flex-wrap justify-between gap-2.5 text-sm">
        <span class="numeric font-bold">
          {{
            t('companyUsers.seatsUsed', {
              used: seats.used,
              limit: seats.limit
            })
          }}
        </span>
        <span class="text-muted">{{ t('companyUsers.seatsNote') }}</span>
      </div>
      <AppProgress
        :value="seats.percent"
        :label="
          t('companyUsers.seatsUsed', {
            used: seats.used,
            limit: seats.limit
          })
        "
      />
      <p
        v-if="seats.full"
        role="status"
        class="flex items-center gap-2 text-sm font-semibold text-warn"
      >
        <AppIcon name="warning" :size="18" />
        {{ t('companyUsers.seatsFull') }}
      </p>
    </div>

    <div v-if="access?.canView" class="flex flex-wrap items-center gap-3">
      <form
        class="flex min-w-0 flex-[1_1_280px] items-end gap-2"
        role="search"
        @submit.prevent="applySearch"
      >
        <AppInput
          v-model="search"
          class="flex-1"
          type="search"
          hide-label
          :label="t('companyUsers.searchLabel')"
          :placeholder="t('companyUsers.searchPlaceholder')"
        />
        <AppButton type="submit" variant="secondary" icon="search">{{
          t('common.search')
        }}</AppButton>
      </form>
      <AppSegmented
        :model-value="statusFilter"
        layout="chip"
        hide-label
        :label="t('companyUsers.statusFilterLabel')"
        :options="statusOptions"
        @update:model-value="onStatusChange"
      />
    </div>

    <AppLoadingSkeleton v-if="isLoading" :label="t('companyUsers.loading')" />
    <AppInlineError v-else-if="error">{{ error }}</AppInlineError>
    <div v-else-if="!access?.canView" class="rounded-lg border border-line bg-surf">
      <AppEmptyState icon="lock" :title="t('companyUsers.noPermissionView')" />
    </div>
    <div v-else-if="list?.users.length === 0" class="rounded-lg border border-line bg-surf">
      <AppEmptyState
        icon="search_off"
        :title="t('companyUsers.noResults')"
        :description="t('companyUsers.noResultsHint')"
      />
    </div>

    <div
      v-else-if="list"
      class="company-users-page__results overflow-hidden rounded-lg border border-line bg-surf shadow-panel"
    >
      <AppTable :framed="false" :label="t('companyUsers.pageTitle')">
        <thead>
          <tr>
            <th>{{ t('companyUsers.user') }}</th>
            <th>{{ t('companyUsers.roles') }}</th>
            <th>{{ t('companyUsers.status') }}</th>
            <th v-if="access?.canManage" class="text-end!">{{ t('companyUsers.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="user in list.users" :key="user.uuid">
            <td>
              <div class="flex min-w-0 items-center gap-2.5">
                <span
                  aria-hidden="true"
                  class="flex size-9 flex-none items-center justify-center rounded-full bg-cat-0 text-xs font-bold text-cat-ink-0"
                >
                  {{ initials(user.name) }}
                </span>
                <span class="min-w-0">
                  <span class="block font-semibold">{{ user.name }}</span>
                  <span
                    dir="ltr"
                    class="block text-start text-xs break-all text-muted [unicode-bidi:plaintext]"
                  >
                    {{ user.email }}
                  </span>
                </span>
              </div>
            </td>
            <td>
              <div class="flex flex-wrap gap-1">
                <span
                  v-for="role in user.roles"
                  :key="role"
                  class="inline-flex min-h-6 items-center rounded-full border border-line bg-subtle px-2 text-xs font-semibold"
                >
                  {{ role }}
                </span>
              </div>
            </td>
            <td>
              <AppStatusChip
                :variant="user.isActive ? 'success' : 'neutral'"
                :icon="user.isActive ? 'check_circle' : 'block'"
                size="sm"
              >
                {{ user.isActive ? t('common.enabled') : t('common.disabled') }}
              </AppStatusChip>
            </td>
            <td v-if="access?.canManage">
              <div class="flex justify-end gap-1.5">
                <AppButton variant="secondary" size="sm" @click="openEdit(user)">
                  {{ t('common.edit') }}
                </AppButton>
                <AppButton
                  :variant="user.isActive ? 'danger-outline' : 'secondary'"
                  size="sm"
                  :disabled="isMutating"
                  @click="requestEnabledChange(user)"
                >
                  {{ user.isActive ? t('common.disable') : t('common.enable') }}
                </AppButton>
              </div>
            </td>
          </tr>
        </tbody>
      </AppTable>

      <div
        class="numeric flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-2.5 text-xs text-muted"
      >
        <span>{{ range }}</span>
        <div class="flex items-center gap-2">
          <AppButton
            v-if="list.page.lastPage > 1"
            variant="ghost"
            size="sm"
            icon="chevron_left"
            mirror-icon
            :disabled="isLoading || list.page.page <= 1"
            @click="changePage(list.page.page - 1)"
          >
            {{ t('common.previous') }}
          </AppButton>
          <span>
            {{ t('companyUsers.pageOf', { page: list.page.page, total: list.page.lastPage }) }}
          </span>
          <AppButton
            v-if="list.page.lastPage > 1"
            variant="ghost"
            size="sm"
            icon-end="chevron_right"
            mirror-icon
            :disabled="isLoading || list.page.page >= list.page.lastPage"
            @click="changePage(list.page.page + 1)"
          >
            {{ t('common.next') }}
          </AppButton>
        </div>
      </div>
    </div>

    <AppConfirmDialog
      :open="pendingUser !== null"
      :title="
        pendingUser?.isActive
          ? t('companyUsers.confirmDisableTitle')
          : t('companyUsers.confirmEnableTitle')
      "
      :message="
        pendingUser
          ? pendingUser.isActive
            ? t('companyUsers.confirmDisable', { name: pendingUser.name })
            : t('companyUsers.confirmEnable', { name: pendingUser.name })
          : ''
      "
      :confirm-label="pendingUser?.isActive ? t('common.disable') : t('common.enable')"
      :cancel-label="t('common.cancel')"
      :variant="pendingUser?.isActive ? 'danger' : 'primary'"
      :loading="isMutating"
      @confirm="confirmEnabledChange"
      @cancel="pendingUser = null"
    />
  </PageContainer>
</template>
