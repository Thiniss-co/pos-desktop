<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import type { CompanyUser } from '@shared/contracts/company-users.contract'
import { useCompanyUsersStore } from '../store'

const companyUsers = useCompanyUsersStore()
const { access, error, isLoading, isMutating, list, query, remainingUsers } =
  storeToRefs(companyUsers)
const search = ref(query.value.search ?? '')

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
    ? `Disable ${user.name}? This prevents sign-in but does not delete the account, device, or business data.`
    : `Enable ${user.name}? This restores sign-in only if the subscription still has capacity.`

  if (window.confirm(description)) {
    void companyUsers.setEnabled({ uuid: user.uuid, enabled: !user.isActive })
  }
}
</script>

<template>
  <section class="shell-page company-users-page">
    <div class="company-users-page__heading">
      <div>
        <p class="shell-page__label">Company users</p>
        <h2>Access is managed online.</h2>
        <p>Disable prevents sign-in. It does not delete a user, their device, or business data.</p>
      </div>
      <RouterLink v-if="access?.canManage" class="button-link" to="/company-users/create">
        Add user
      </RouterLink>
    </div>

    <p v-if="remainingUsers !== null" class="company-users-page__capacity">
      Users remaining on this plan: {{ remainingUsers }}. Disabled users still consume the users
      limit.
    </p>

    <form v-if="access?.canView" class="company-users-page__filters" @submit.prevent="applySearch">
      <label>
        Search
        <input v-model="search" type="search" placeholder="Name or email" />
      </label>
      <label>
        Status
        <select
          :value="query.isActive === undefined ? '' : query.isActive ? 'active' : 'disabled'"
          @change="applyStatus"
        >
          <option value="">All users</option>
          <option value="active">Enabled</option>
          <option value="disabled">Disabled</option>
        </select>
      </label>
      <button type="submit">Search</button>
    </form>

    <p v-if="isLoading" class="company-users-page__state">Loading company users…</p>
    <p v-else-if="error" class="inline-error" role="alert">{{ error }}</p>
    <p v-else-if="!access?.canView" class="company-users-page__state">
      You do not currently have permission to view company users.
    </p>
    <p v-else-if="list?.users.length === 0" class="company-users-page__state">
      No company users match this search.
    </p>

    <div v-else-if="list" class="company-users-page__table-wrap">
      <table class="company-users-page__table">
        <thead>
          <tr>
            <th>User</th>
            <th>Roles</th>
            <th>Status</th>
            <th v-if="access?.canManage">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="user in list.users" :key="user.uuid">
            <td>
              <strong>{{ user.name }}</strong>
              <span>{{ user.email }}</span>
            </td>
            <td>{{ user.roles.join(', ') }}</td>
            <td>{{ user.isActive ? 'Enabled' : 'Disabled' }}</td>
            <td v-if="access?.canManage" class="company-users-page__actions">
              <RouterLink :to="{ name: 'company-user-edit', params: { uuid: user.uuid } }"
                >Edit</RouterLink
              >
              <button type="button" :disabled="isMutating" @click="confirmEnabledChange(user)">
                {{ user.isActive ? 'Disable' : 'Enable' }}
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
          Previous
        </button>
        <span>Page {{ list.page.page }} of {{ list.page.lastPage }}</span>
        <button
          type="button"
          :disabled="isLoading || list.page.page >= list.page.lastPage"
          @click="changePage(list.page.page + 1)"
        >
          Next
        </button>
      </div>
    </div>
  </section>
</template>
