<script setup lang="ts">
import { onMounted, reactive } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import type { CreateCompanyUserInput } from '@shared/contracts/company-users.contract'
import { useCompanyUsersStore } from '../store'

const router = useRouter()
const companyUsers = useCompanyUsersStore()
const { access, assignableRoles, error, fieldErrors, isMutating, remainingUsers } =
  storeToRefs(companyUsers)
const form = reactive<CreateCompanyUserInput>({
  name: '',
  email: '',
  password: '',
  roles: [],
  companyRoleIds: []
})
const { t } = useI18n()

onMounted(async () => {
  await companyUsers.loadAccess()

  if (access.value?.canManage) {
    await companyUsers.loadAssignableRoles()
  }
})

async function submit(): Promise<void> {
  const created = await companyUsers.create({ ...form })

  if (created) {
    await router.push({ name: 'company-users' })
  }
}
</script>

<template>
  <section class="shell-page company-user-form-page">
    <p class="shell-page__label">{{ t('companyUsers.label') }}</p>
    <h2>{{ t('companyUsers.createTitle') }}</h2>
    <p v-if="remainingUsers !== null">
      {{ t('companyUsers.remainingBeforeChange', { count: remainingUsers }) }}
    </p>
    <p v-if="!access?.canManage" class="inline-error" role="alert">
      {{ t('companyUsers.noPermissionAdd') }}
    </p>

    <form v-else class="foundation-form" @submit.prevent="submit">
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
        {{ t('companyUsers.temporaryPassword') }}
        <input
          v-model="form.password"
          required
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
      <button type="submit" :disabled="isMutating">{{ t('companyUsers.createUser') }}</button>
    </form>
  </section>
</template>
