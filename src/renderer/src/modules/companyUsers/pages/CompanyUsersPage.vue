<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import type { CompanyUser } from '@shared/contracts/company-users.contract'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import AppConfirmDialog from '@renderer/shared/components/common/AppConfirmDialog.vue'
import AppTable from '@renderer/shared/components/common/AppTable.vue'
import AppEmptyState from '@renderer/shared/components/feedback/AppEmptyState.vue'
import AppInlineError from '@renderer/shared/components/feedback/AppInlineError.vue'
import AppLoadingSkeleton from '@renderer/shared/components/feedback/AppLoadingSkeleton.vue'
import AppStatusChip from '@renderer/shared/components/feedback/AppStatusChip.vue'
import AppInput from '@renderer/shared/components/forms/AppInput.vue'
import AppSelect from '@renderer/shared/components/forms/AppSelect.vue'
import PageHeader from '@renderer/shared/components/layout/PageHeader.vue'
import { useCompanyUsersStore } from '../store'

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

function changePage(page: number): void {
  void companyUsers.refresh({ page })
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
  <section class="company-users-page">
    <PageHeader :eyebrow="t('companyUsers.label')" :title="t('companyUsers.listTitle')">
      <template v-if="access?.canManage" #actions>
        <RouterLink class="company-users-page__add-link" to="/company-users/create">
          {{ t('companyUsers.addUser') }}
        </RouterLink>
      </template>
    </PageHeader>
    <p class="company-users-page__description">{{ t('companyUsers.listDescription') }}</p>

    <p v-if="remainingUsers !== null" class="company-users-page__capacity">
      {{ t('companyUsers.usersRemaining', { count: remainingUsers }) }}
    </p>

    <form v-if="access?.canView" class="company-users-page__filters" @submit.prevent="applySearch">
      <AppInput
        v-model="search"
        type="search"
        :label="t('companyUsers.searchLabel')"
        :placeholder="t('companyUsers.searchPlaceholder')"
      />
      <AppSelect
        v-model="statusFilter"
        :label="t('companyUsers.status')"
        :options="statusOptions"
        @update:model-value="applyStatus"
      />
      <AppButton type="submit" variant="secondary">{{ t('common.search') }}</AppButton>
    </form>

    <AppLoadingSkeleton v-if="isLoading" :label="t('companyUsers.loading')" />
    <AppInlineError v-else-if="error">{{ error }}</AppInlineError>
    <AppEmptyState v-else-if="!access?.canView" :title="t('companyUsers.noPermissionView')" />
    <AppEmptyState v-else-if="list?.users.length === 0" :title="t('companyUsers.noResults')" />

    <div v-else-if="list" class="company-users-page__results">
      <AppTable>
        <thead>
          <tr>
            <th>{{ t('companyUsers.user') }}</th>
            <th>{{ t('companyUsers.roles') }}</th>
            <th>{{ t('companyUsers.status') }}</th>
            <th v-if="access?.canManage">{{ t('companyUsers.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="user in list.users" :key="user.uuid">
            <td>
              <div class="company-users-page__identity">
                <strong>{{ user.name }}</strong>
                <span>{{ user.email }}</span>
              </div>
            </td>
            <td>{{ user.roles.join(', ') }}</td>
            <td>
              <AppStatusChip :variant="user.isActive ? 'success' : 'neutral'">
                {{ user.isActive ? t('common.enabled') : t('common.disabled') }}
              </AppStatusChip>
            </td>
            <td v-if="access?.canManage">
              <div class="company-users-page__actions">
                <RouterLink :to="{ name: 'company-user-edit', params: { uuid: user.uuid } }">
                  {{ t('common.edit') }}
                </RouterLink>
                <AppButton
                  variant="ghost"
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

      <div v-if="list.page.lastPage > 1" class="company-users-page__pagination">
        <AppButton
          variant="ghost"
          :disabled="isLoading || list.page.page <= 1"
          @click="changePage(list.page.page - 1)"
        >
          {{ t('common.previous') }}
        </AppButton>
        <span class="numeric">
          {{ t('companyUsers.pageOf', { page: list.page.page, total: list.page.lastPage }) }}
        </span>
        <AppButton
          variant="ghost"
          :disabled="isLoading || list.page.page >= list.page.lastPage"
          @click="changePage(list.page.page + 1)"
        >
          {{ t('common.next') }}
        </AppButton>
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
  </section>
</template>

<style scoped>
.company-users-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.company-users-page__description {
  color: var(--color-on-surface-variant);
}

.company-users-page__add-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: var(--size-target-min);
  padding-inline: var(--space-5);
  border-radius: var(--radius-sm);
  background: var(--color-primary);
  color: var(--color-on-primary);
  text-decoration: none;
  font-weight: 600;
}

.company-users-page__add-link:hover {
  opacity: 0.92;
}

.company-users-page__capacity {
  font-size: var(--text-body-sm-size);
  color: var(--color-text-muted);
}

.company-users-page__filters {
  display: flex;
  align-items: flex-end;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.company-users-page__identity {
  display: flex;
  flex-direction: column;
}

.company-users-page__identity span {
  font-size: var(--text-body-sm-size);
  color: var(--color-text-muted);
}

.company-users-page__actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.company-users-page__results {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.company-users-page__pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
}
</style>
