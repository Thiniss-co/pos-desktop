# Workspace and Worktree Policy

Applies to every session (Claude, Codex or another agent) that edits this repository.

## Canonical checkout

- `/var/www/html/thinis-pos/pos-desktop` stays on `main` while it serves the running application (`npm run dev:linux`
  against the backend's `composer run dev`). Never switch its branch underneath a running app or session, and never
  develop features in it.

## Reusable editing slots

- Worktrees are allowed only as fixed, reusable editing slots: at most **two per repository**, allocated only when a
  second concurrent session needs one. Reuse an existing slot; never create a new folder per feature, phase, review,
  integration or test run. A third slot needs the user's explicit approval.
- The shared registry `/var/www/html/thinis-pos/WORKSPACES.md` (outside every worktree) records each slot's absolute
  path, branch, owning session and task. Claim a `FREE` slot there before editing and release it there when done. If
  both slots are occupied, wait or coordinate a handoff with the owning session or the user.
- A slot belongs to exactly one editing session at a time. Two sessions never edit or switch branches in the same
  directory; concurrent sessions on this repository use different slots and different branches.
- Before reusing a slot, verify that its previous session released it, that
  `git status --porcelain --untracked-files=all` is empty, that its work is committed on a named branch, and that its
  untracked and ignored data (Playwright evidence under `docs/audits/`, local SQLite files, Electron profiles,
  configuration) is accounted for in the registry.
- Switching a released, clean slot to another branch is allowed and never deletes the previous branch; unmerged
  feature branches stay preserved. Do not merge a feature merely to free a slot.

## Commands and isolation

- Use an explicit absolute working directory in every command (`git -C <slot>`, `cd <slot> && …`) and verify the branch
  (`git -C <slot> symbolic-ref --short HEAD`) before every edit and commit.
- Keep each session's runtime isolated: its own Electron user-data/`XDG_CONFIG_HOME` profile and SQLite files, its own
  backend fixture or disposable backend export, ports, display and caches. Never write to the real profile
  (`~/.config/pos-desktop/`), the canonical `.env`, the backend's normal databases or its `public/hot`.

## Retiring worktrees

- Retire surplus worktrees only after their session released them and their unique code, configuration, databases
  and evidence are preserved; remove one at a time with `git worktree remove <path>` (never `--force`). Removing a
  worktree never deletes its branch. Never use wildcard deletion, `git clean` or `git reset --hard` on a worktree.
