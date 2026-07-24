# Company User Management Contract

This online-only desktop capability is mounted inside the protected desktop namespace. It never
creates SQLite user records or sync-queue entries. The main process sends the device-bound request
directly and the renderer retains only sanitized, in-memory display state.

## Authorization and lifecycle

- All routes require a desktop bearer token and `X-Device-UUID`.
- `users.view` controls the list/read affordance; `users.manage` controls create, edit, role, and
  enable/disable actions. The UI gate is only an affordance: Laravel is authoritative.
- `roles.manage` is not required to assign server-returned company roles; desktop role CRUD is out
  of scope.
- A disabled user is not deleted. Their account, device assignments, and business data remain.
  Disabled users still consume the `users` plan limit.
- The API accepts system-role keys `company_admin`, `manager`, and `cashier`; platform
  `super_admin` is never accepted or returned as assignable.

## Reused routes

| Method | Desktop path | Request |
| --- | --- | --- |
| `GET` | `/api/v1/desktop/company/users` | `search`, `filter[is_active]`, `filter[role]`, `page`, `per_page` |
| `GET` | `/api/v1/desktop/company/users/{uuid}` | — |
| `POST` | `/api/v1/desktop/company/users` | `name`, `email`, `password`, `roles[]`, `company_role_ids[]` |
| `PUT` | `/api/v1/desktop/company/users/{uuid}` | editable fields; setting roles sends the complete `roles` + `company_role_ids` set |
| `POST` | `/api/v1/desktop/company/users/{uuid}/activate` | — |
| `POST` | `/api/v1/desktop/company/users/{uuid}/deactivate` | — |
| `GET` | `/api/v1/desktop/company/assignable-roles` | — |

The user resource is mapped in main before it crosses preload:

```ts
{
  uuid: string
  name: string
  email: string
  isActive: boolean
  roles: string[]
  createdAt: string | null
  updatedAt: string | null
}
```

Raw `company_id` and any other backend-only fields are deliberately dropped. The paginated list
uses the response envelope `meta.current_page`, `meta.per_page`, `meta.total`, and
`meta.last_page`.

`GET /company/assignable-roles` returns the only role choices the desktop may display:

```ts
{
  system_roles: Array<{ key: 'company_admin' | 'manager' | 'cashier'; label: string; assignable: boolean }>
  company_roles: Array<{ uuid: string; name: string; is_active: boolean }>
}
```

## Error handling

- `COMPANY_LIMIT_REACHED` is a 422 plan-cap response. The desktop shows a safe no-change message.
- `COMPANY_LAST_ADMIN` protects the last active Company Admin from disable/demotion; recovery is
  through a web Super Admin.
- `PERMISSION_DENIED` and `FEATURE_NOT_ENABLED` remove local management controls without clearing
  the device, local business data, or session.
- Transport failures show “offline; no changes were saved” and are never queued.
