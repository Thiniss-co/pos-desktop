<script setup lang="ts">
import { onMounted, reactive } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import type { UpdateCompanyUserInput } from '@shared/contracts/company-users.contract'
import { useCompanyUsersStore } from '../store'

const route = useRoute()
const router = useRouter()
const companyUsers = useCompanyUsersStore()
const { access, assignableRoles, error, fieldErrors, isLoading, isMutating, selectedUser } =
  storeToRefs(companyUsers)
const form = reactive({
  name: '',
  email: '',
  password: '',
  roles: [] as string[],
  companyRoleIds: [] as string[]
})
const { t } = useI18n()

onMounted(async () => {
  const uuid = typeof route.params.uuid === 'string' ? route.params.uuid : ''
  await companyUsers.loadAccess()

  if (!access.value?.canManage) {
    return
  }

  await companyUsers.loadAssignableRoles()
  const user = await companyUsers.get(uuid)

  if (!user) {
    return
  }

  form.name = user.name
  form.email = user.email
  form.roles = user.roles.filter((role) =>
    (assignableRoles.value?.systemRoles ?? []).some((assignableRole) => assignableRole.key === role)
  )
  form.companyRoleIds = (assignableRoles.value?.companyRoles ?? [])
    .filter((role) => user.roles.includes(role.name))
    .map((role) => role.uuid)
})

async function submit(): Promise<void> {
  if (!selectedUser.value) {
    return
  }

  const input: UpdateCompanyUserInput = {
    uuid: selectedUser.value.uuid,
    name: form.name,
    email: form.email,
    roles: form.roles as UpdateCompanyUserInput['roles'],
    companyRoleIds: form.companyRoleIds
  }

  if (form.password) {
    input.password = form.password
  }

  const updated = await companyUsers.update(input)

  if (updated) {
    await router.push({ name: 'company-users' })
  }
}
</script>

<template>
  <section class="shell-page company-user-form-page">
    <p class="shell-page__label">{{ t('companyUsers.label') }}</p>
    <h2>{{ t('companyUsers.editTitle') }}</h2>
    <p v-if="isLoading">{{ t('companyUsers.loadingUser') }}</p>
    <p v-else-if="!access?.canManage" class="inline-error" role="alert">
      {{ t('companyUsers.noPermissionEdit') }}
    </p>

    <form v-else-if="selectedUser" class="foundation-form" @submit.prevent="submit">
      <label>
        {{ t('companyUsers.name') }}
        <input v-model.trim="form.name" required maxlength="255" autocomplete="name" />
      </label>
      <label>
        {{ t('auth.email') }}
        <input
          v-model.trim="form.email"
          required
          type="email"
          maxlength="255"
          autocomplete="email"
        />
      </label>
      <label>
        {{ t('companyUsers.newPassword') }}
        <input
          v-model="form.password"
          type="password"
          minlength="8"
          maxlength="255"
          autocomplete="new-password"
        />
      </label>

      <fieldset class="company-user-form-page__roles">
        <legend>{{ t('companyUsers.systemRoles') }}</legend>
        <label v-for="role in assignableRoles?.systemRoles" :key="role.key">
          <input
            v-model="form.roles"
            type="checkbox"
            :value="role.key"
            :disabled="!role.assignable"
          />
          {{ role.label }}
        </label>
      </fieldset>

      <fieldset class="company-user-form-page__roles">
        <legend>{{ t('companyUsers.customRoles') }}</legend>
        <label v-for="role in assignableRoles?.companyRoles" :key="role.uuid">
          <input
            v-model="form.companyRoleIds"
            type="checkbox"
            :value="role.uuid"
            :disabled="!role.isActive"
          />
          {{ role.name }}
        </label>
      </fieldset>

      <p v-if="fieldErrors" class="inline-error" role="alert">
        <span v-for="(messages, field) in fieldErrors" :key="field"
          >{{ field }}: {{ messages.join(' ') }}
        </span>
      </p>
      <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
      <button type="submit" :disabled="isMutating">{{ t('common.saveChanges') }}</button>
    </form>
  </section>
</template>
