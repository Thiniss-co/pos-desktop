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
  // Dev-only design gallery. The `import.meta.env.DEV` check is statically replaced with `false`
  // in a production build, so Vite/Rollup dead-code-eliminates this entire array — including the
  // dynamic import, which is why the component is lazy-loaded rather than statically imported
  // like every route above. See devGallery.exclusion.test.ts for the build-output proof, and
  // guards.ts's `meta.devOnly` bypass for why the startup guard doesn't redirect it away.
  ...(import.meta.env.DEV
    ? [
        {
          path: '/__dev/gallery',
          name: 'dev-gallery',
          component: () => import('@renderer/modules/devGallery/pages/DevGalleryPage.vue'),
          meta: { layout: 'app', devOnly: true }
        }
      ]
    : []),
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: NotFoundPage,
    meta: { layout: 'public' }
  }
]
