import type { RouteRecordRaw } from 'vue-router'
import AccessBlockedPage from '@renderer/modules/access/pages/AccessBlockedPage.vue'
import ActivationPage from '@renderer/modules/activation/pages/ActivationPage.vue'
import LoginPage from '@renderer/modules/auth/pages/LoginPage.vue'
import InitializingPage from '@renderer/modules/bootstrap/pages/InitializingPage.vue'
import CompanyUserCreatePage from '@renderer/modules/companyUsers/pages/CompanyUserCreatePage.vue'
import CompanyUserEditPage from '@renderer/modules/companyUsers/pages/CompanyUserEditPage.vue'
import CompanyUsersPage from '@renderer/modules/companyUsers/pages/CompanyUsersPage.vue'
import PosPage from '@renderer/modules/pos/pages/PosPage.vue'
import SettingsPage from '@renderer/modules/settings/pages/SettingsPage.vue'
import SyncPage from '@renderer/modules/sync/pages/SyncPage.vue'
import FatalErrorPage from '../startup/FatalErrorPage.vue'
import NotFoundPage from '../startup/NotFoundPage.vue'

export const routes: RouteRecordRaw[] = [
  { path: '/', name: 'root', component: InitializingPage, meta: { layout: 'public' } },
  { path: '/activate', name: 'activation', component: ActivationPage, meta: { layout: 'public' } },
  { path: '/login', name: 'login', component: LoginPage, meta: { layout: 'public' } },
  {
    path: '/bootstrap',
    name: 'bootstrap',
    component: InitializingPage,
    meta: { layout: 'public' }
  },
  {
    path: '/access',
    name: 'access-blocked',
    component: AccessBlockedPage,
    meta: { layout: 'public' }
  },
  { path: '/error', name: 'fatal-error', component: FatalErrorPage, meta: { layout: 'public' } },
  { path: '/pos', name: 'pos', component: PosPage, meta: { layout: 'app' } },
  { path: '/sync', name: 'sync', component: SyncPage, meta: { layout: 'app' } },
  { path: '/settings', name: 'settings', component: SettingsPage, meta: { layout: 'app' } },
  {
    path: '/company-users',
    name: 'company-users',
    component: CompanyUsersPage,
    meta: { layout: 'app' }
  },
  {
    path: '/company-users/create',
    name: 'company-user-create',
    component: CompanyUserCreatePage,
    meta: { layout: 'app' }
  },
  {
    path: '/company-users/:uuid',
    name: 'company-user-edit',
    component: CompanyUserEditPage,
    meta: { layout: 'app' }
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: NotFoundPage,
    meta: { layout: 'public' }
  }
]
