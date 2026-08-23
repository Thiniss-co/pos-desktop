import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { PublicAppError } from '@shared/contracts/api.contract'
import type {
  CompanyUser,
  CreateCompanyUserInput,
  ListUsersInput,
  SetEnabledInput,
  SetRolesInput,
  UpdateCompanyUserInput
} from '@shared/contracts/company-users.contract'
import { CompanyUsersService } from './service'
import type {
  CompanyUserDetailState,
  CompanyUsersAccessState,
  CompanyUsersDisplayState,
  CompanyUsersQuery,
  CompanyUsersRoleState
} from './types'
import { handleSessionTransition } from '@renderer/app/session/sessionTransition'
import { parsePublicAppError } from '@renderer/shared/utils/parsePublicAppError'
import { i18n } from '@renderer/i18n'
import { localizeAppError } from '@renderer/shared/utils/localizeAppError'

const deniedCodes = new Set(['PERMISSION_DENIED', 'FEATURE_NOT_ENABLED'])

/**
 * Company-user management has action-specific guidance (e.g. whether a write was saved) that the
 * shared error catalog does not carry. Prefer a `companyUsers.errors.<CODE>` / `.transport` key
 * when one exists, then fall back to the shared localizeAppError resolution. Re-evaluated inside
 * a computed so it re-localizes on a language switch, the same as the shared resolver.
 */
function localizeCompanyUsersError(error: PublicAppError): string {
  if (error.backendCode) {
    const moduleKey = 'companyUsers.errors.' + error.backendCode

    if (i18n.global.te(moduleKey)) {
      return String(i18n.global.t(moduleKey))
    }
  }

  if (error.category === 'transport' && i18n.global.te('companyUsers.errors.transport')) {
    return String(i18n.global.t('companyUsers.errors.transport'))
  }

  return localizeAppError(error, i18n.global.t, i18n.global.te)
}

export const useCompanyUsersStore = defineStore('companyUsers', () => {
  const access = ref<CompanyUsersAccessState>(null)
  const list = ref<CompanyUsersDisplayState>(null)
  const selectedUser = ref<CompanyUserDetailState>(null)
  const assignableRoles = ref<CompanyUsersRoleState>(null)
  const query = ref<CompanyUsersQuery>({ page: 1, perPage: 25 })
  const errorDetail = ref<PublicAppError | null>(null)
  const errorFallbackKey = ref<string | null>(null)
  const error = computed<string | null>(() => {
    if (errorDetail.value) {
      return localizeCompanyUsersError(errorDetail.value)
    }

    if (errorFallbackKey.value) {
      return String(i18n.global.t(errorFallbackKey.value))
    }

    return null
  })
  const fieldErrors = ref<Record<string, string[]> | null>(null)
  const isLoading = ref(false)
  const isMutating = ref(false)

  const remainingUsers = computed(() => {
    const currentAccess = access.value

    if (!currentAccess || currentAccess.userLimit === null || !list.value) {
      return null
    }

    return Math.max(currentAccess.userLimit - list.value.page.total, 0)
  })

  function clearError(): void {
    errorDetail.value = null
    errorFallbackKey.value = null
  }

  function clearRemoteAccessWhenDenied(cause: PublicAppError): void {
    if (cause.backendCode && deniedCodes.has(cause.backendCode)) {
      access.value = {
        canView: false,
        canManage: false,
        userLimit: access.value?.userLimit ?? null
      }
      list.value = null
      selectedUser.value = null
      assignableRoles.value = null
    }
  }

  function setError(cause: unknown): void {
    fieldErrors.value = null

    const publicError = parsePublicAppError(cause)

    if (publicError) {
      void handleSessionTransition(publicError)
      clearRemoteAccessWhenDenied(publicError)
      errorDetail.value = publicError
      errorFallbackKey.value = null
      fieldErrors.value = publicError.fieldErrors ?? null
      return
    }

    errorDetail.value = null
    errorFallbackKey.value = 'companyUsers.unavailable'
  }

  async function loadAccess(service = new CompanyUsersService()): Promise<void> {
    try {
      access.value = await service.getAccess()
    } catch (cause) {
      access.value = { canView: false, canManage: false, userLimit: null }
      setError(cause)
    }
  }

  async function refresh(
    input: Partial<ListUsersInput> = {},
    service = new CompanyUsersService()
  ): Promise<void> {
    if (isLoading.value) {
      return
    }

    isLoading.value = true
    clearError()
    query.value = { ...query.value, ...input }

    try {
      list.value = await service.list(query.value)
    } catch (cause) {
      setError(cause)
    } finally {
      isLoading.value = false
    }
  }

  async function initialize(service = new CompanyUsersService()): Promise<void> {
    await loadAccess(service)

    if (access.value?.canView) {
      await refresh({}, service)
    }
  }

  async function get(
    uuid: string,
    service = new CompanyUsersService()
  ): Promise<CompanyUser | null> {
    isLoading.value = true
    clearError()

    try {
      selectedUser.value = await service.get(uuid)
      return selectedUser.value
    } catch (cause) {
      setError(cause)
      return null
    } finally {
      isLoading.value = false
    }
  }

  async function loadAssignableRoles(service = new CompanyUsersService()): Promise<void> {
    try {
      assignableRoles.value = await service.listAssignableRoles()
    } catch (cause) {
      setError(cause)
    }
  }

  async function mutate(
    operation: (service: CompanyUsersService) => Promise<CompanyUser>,
    service = new CompanyUsersService()
  ): Promise<CompanyUser | null> {
    if (isMutating.value) {
      return null
    }

    isMutating.value = true
    clearError()
    fieldErrors.value = null

    try {
      const user = await operation(service)
      selectedUser.value = user
      await refresh({}, service)
      return user
    } catch (cause) {
      setError(cause)
      return null
    } finally {
      isMutating.value = false
    }
  }

  function create(
    input: CreateCompanyUserInput,
    service = new CompanyUsersService()
  ): Promise<CompanyUser | null> {
    return mutate((gateway) => gateway.create(input), service)
  }

  function update(
    input: UpdateCompanyUserInput,
    service = new CompanyUsersService()
  ): Promise<CompanyUser | null> {
    return mutate((gateway) => gateway.update(input), service)
  }

  function setRoles(
    input: SetRolesInput,
    service = new CompanyUsersService()
  ): Promise<CompanyUser | null> {
    return mutate((gateway) => gateway.setRoles(input), service)
  }

  function setEnabled(
    input: SetEnabledInput,
    service = new CompanyUsersService()
  ): Promise<CompanyUser | null> {
    return mutate((gateway) => gateway.setEnabled(input), service)
  }

  return {
    access,
    list,
    selectedUser,
    assignableRoles,
    query,
    error,
    fieldErrors,
    isLoading,
    isMutating,
    remainingUsers,
    loadAccess,
    refresh,
    initialize,
    get,
    loadAssignableRoles,
    create,
    update,
    setRoles,
    setEnabled
  }
})
