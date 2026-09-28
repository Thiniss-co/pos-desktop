<script setup lang="ts">
import { computed, onMounted, reactive } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import type { UpdateCompanyUserInput } from '@shared/contracts/company-users.contract'
import AppInlineError from '@renderer/shared/components/feedback/AppInlineError.vue'
import AppLoadingSkeleton from '@renderer/shared/components/feedback/AppLoadingSkeleton.vue'
import AppCheckbox from '@renderer/shared/components/forms/AppCheckbox.vue'
import AppInput from '@renderer/shared/components/forms/AppInput.vue'
import PageContainer from '@renderer/shared/components/layout/PageContainer.vue'
import CompanyUserFormCard from '../components/CompanyUserFormCard.vue'
import { useCompanyUsersStore } from '../store'

const INLINE_FIELDS = ['name', 'email', 'password'] as const

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

/** Server field errors shown under their own input; any other field keeps the list below. */
function fieldError(field: (typeof INLINE_FIELDS)[number]): string | undefined {
  return fieldErrors.value?.[field]?.join(' ') || undefined
}
const otherFieldErrors = computed(() =>
  Object.entries(fieldErrors.value ?? {}).filter(
    ([field]) => !(INLINE_FIELDS as readonly string[]).includes(field)
  )
)

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

function toggleRole(list: string[], value: string, checked: boolean): void {
  const index = list.indexOf(value)
  if (checked && index === -1) {
    list.push(value)
  } else if (!checked && index !== -1) {
    list.splice(index, 1)
  }
}

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

function cancel(): void {
  void router.push({ name: 'company-users' })
}
</script>

<template>
  <PageContainer class="company-user-form-page">
    <CompanyUserFormCard
      :title="t('companyUsers.editTitle')"
      :submit-label="t('companyUsers.saveUser')"
      :cancel-label="t('common.cancel')"
      :busy="isMutating"
      :show-actions="!isLoading && Boolean(access?.canManage) && Boolean(selectedUser)"
      @submit="submit"
      @cancel="cancel"
    >
      <AppLoadingSkeleton v-if="isLoading" :label="t('companyUsers.loadingUser')" />
      <AppInlineError v-else-if="!access?.canManage">
        {{ t('companyUsers.noPermissionEdit') }}
      </AppInlineError>

      <template v-else-if="selectedUser">
        <AppInput
          v-model.trim="form.name"
          :label="t('companyUsers.fullName')"
          required
          autofocus
          maxlength="255"
          autocomplete="name"
          :error="fieldError('name')"
        />
        <AppInput
          v-model.trim="form.email"
          type="email"
          dir="ltr"
          inputmode="email"
          :label="t('auth.email')"
          required
          maxlength="255"
          autocomplete="email"
          :error="fieldError('email')"
        />
        <AppInput
          v-model="form.password"
          type="password"
          dir="ltr"
          :label="t('companyUsers.newPassword')"
          minlength="8"
          maxlength="255"
          autocomplete="new-password"
          :error="fieldError('password')"
        />

        <fieldset class="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0">
          <legend class="mb-1.5 p-0 text-sm font-semibold">
            {{ t('companyUsers.systemRoles') }}
          </legend>
          <AppCheckbox
            v-for="role in assignableRoles?.systemRoles"
            :key="role.key"
            tile
            :label="role.label"
            :disabled="!role.assignable"
            :model-value="form.roles.includes(role.key)"
            @update:model-value="(checked) => toggleRole(form.roles, role.key, checked)"
          />
        </fieldset>

        <fieldset
          v-if="assignableRoles?.companyRoles.length"
          class="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0"
        >
          <legend class="mb-1.5 p-0 text-sm font-semibold">
            {{ t('companyUsers.customRoles') }}
          </legend>
          <AppCheckbox
            v-for="role in assignableRoles?.companyRoles"
            :key="role.uuid"
            tile
            :label="role.name"
            :disabled="!role.isActive"
            :model-value="form.companyRoleIds.includes(role.uuid)"
            @update:model-value="(checked) => toggleRole(form.companyRoleIds, role.uuid, checked)"
          />
        </fieldset>

        <AppInlineError v-if="otherFieldErrors.length > 0">
          <span v-for="[field, messages] in otherFieldErrors" :key="field" class="block">
            {{ field }}: {{ messages.join(' ') }}
          </span>
        </AppInlineError>
      </template>

      <AppInlineError v-if="error && !isLoading">{{ error }}</AppInlineError>
    </CompanyUserFormCard>
  </PageContainer>
</template>
