<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import type { CompanyUser } from '@shared/contracts/company-users.contract'
import { useCompanyUsersStore } from '../store'

const companyUsers = useCompanyUsersStore()
const { access, error, isLoading, isMutating, list, query, remainingUsers } =
  storeToRefs(companyUsers)
const search = ref(query.value.search ?? '')
const { t } = useI18n()

onMounted(() => {
  void companyUsers.initialize()
})

function applySearch(): void {
  void companyUsers.refresh({ search: search.value || undefined, page: 1 })
}

function applyStatus(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  void companyUsers.refresh({
    isActive: value === '' ? undefined : value === 'active',
    page: 1
  })
}

function changePage(page: number): void {
  void companyUsers.refresh({ page })
}

function confirmEnabledChange(user: CompanyUser): void {
  const description = user.isActive
    ? t('companyUsers.confirmDisable', { name: user.name })
    : t('companyUsers.confirmEnable', { name: user.name })

  if (window.confirm(description)) {
    void companyUsers.setEnabled({ uuid: user.uuid, enabled: !user.isActive })
  }
}
</script>

<template>
  <section class="shell-page company-users-page">
    <div class="company-users-page__heading">
      <div>
        <p class="shell-page__label">{{ t('companyUsers.label') }}</p>
        <h2>{{ t('companyUsers.listTitle') }}</h2>
        <p>{{ t('companyUsers.listDescription') }}</p>
      </div>
      <RouterLink v-if="access?.canManage" class="button-link" to="/company-users/create">
        {{ t('companyUsers.addUser') }}
      </RouterLink>
    </div>

    <p v-if="remainingUsers !== null" class="company-users-page__capacity">
      {{ t('companyUsers.usersRemaining', { count: remainingUsers }) }}
    </p>

    <form v-if="access?.canView" class="company-users-page__filters" @submit.prevent="applySearch">
      <label>
        {{ t('companyUsers.searchLabel') }}
        <input v-model="search" type="search" :placeholder="t('companyUsers.searchPlaceholder')" />
      </label>
      <label>
        {{ t('companyUsers.status') }}
        <select
          :value="query.isActive === undefined ? '' : query.isActive ? 'active' : 'disabled'"
          @change="applyStatus"
        >
          <option value="">{{ t('companyUsers.allUsers') }}</option>
          <option value="active">{{ t('common.enabled') }}</option>
          <option value="disabled">{{ t('common.disabled') }}</option>
        </select>
      </label>
      <button type="submit">{{ t('common.search') }}</button>
    </form>

    <p v-if="isLoading" class="company-users-page__state">{{ t('companyUsers.loading') }}</p>
    <p v-else-if="error" class="inline-error" role="alert">{{ error }}</p>
    <p v-else-if="!access?.canView" class="company-users-page__state">
      {{ t('companyUsers.noPermissionView') }}
    </p>
    <p v-else-if="list?.users.length === 0" class="company-users-page__state">
      {{ t('companyUsers.noResults') }}
    </p>

    <div v-else-if="list" class="company-users-page__table-wrap">
      <table class="company-users-page__table">
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
              <strong>{{ user.name }}</strong>
              <span>{{ user.email }}</span>
            </td>
            <td>{{ user.roles.join(', ') }}</td>
            <td>{{ user.isActive ? t('common.enabled') : t('common.disabled') }}</td>
            <td v-if="access?.canManage" class="company-users-page__actions">
              <RouterLink :to="{ name: 'company-user-edit', params: { uuid: user.uuid } }">{{
                t('common.edit')
              }}</RouterLink>
              <button type="button" :disabled="isMutating" @click="confirmEnabledChange(user)">
                {{ user.isActive ? t('common.disable') : t('common.enable') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>

      <div v-if="list.page.lastPage > 1" class="company-users-page__pagination">
        <button
          type="button"
          :disabled="isLoading || list.page.page <= 1"
          @click="changePage(list.page.page - 1)"
        >
          {{ t('common.previous') }}
        </button>
        <span>{{
          t('companyUsers.pageOf', { page: list.page.page, total: list.page.lastPage })
        }}</span>
        <button
          type="button"
          :disabled="isLoading || list.page.page >= list.page.lastPage"
          @click="changePage(list.page.page + 1)"
        >
          {{ t('common.next') }}
        </button>
      </div>
    </div>
  </section>
</template>
