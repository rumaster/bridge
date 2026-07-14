import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Plus, ShieldCheck, UserPlus } from "lucide-react";

import type {
  CreateInvitationRequest,
  Invitation,
  OrganizationUser,
  PatchUserRequest
} from "../../api/client/types";
import { useSaasAdminApi } from "../../state/admin";
import { hasAnyRole, useAuth } from "../../state/auth";
import { Badge, Button, Panel, TextInput } from "../../shared/ui-kit";

type PrimaryRole = "administrator" | "manager";

interface CreateFormState {
  displayName: string;
  email: string;
  telegramUsername: string;
  role: PrimaryRole;
}

interface InviteFormState {
  contactType: "email" | "telegram";
  contactValue: string;
  role: PrimaryRole;
}

const emptyCreateForm: CreateFormState = {
  displayName: "",
  email: "",
  telegramUsername: "",
  role: "manager"
};

const emptyInviteForm: InviteFormState = {
  contactType: "email",
  contactValue: "",
  role: "manager"
};

export default function UsersPage() {
  const { session } = useAuth();
  const api = useSaasAdminApi();
  const canEdit = hasAnyRole(session, ["administrator"]);
  const organizationId = session?.organization.id;
  const selfId = session?.user.id;

  const [users, setUsers] = useState<OrganizationUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [alert, setAlert] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [savingUserId, setSavingUserId] = useState<string | null>(null);
  const [createForm, setCreateForm] = useState<CreateFormState>(emptyCreateForm);
  const [creating, setCreating] = useState(false);
  const [inviteForm, setInviteForm] = useState<InviteFormState>(emptyInviteForm);
  const [inviting, setInviting] = useState(false);
  const [invitation, setInvitation] = useState<Invitation | null>(null);

  const loadUsers = useCallback(async () => {
    if (!organizationId) {
      return;
    }
    setLoading(true);
    try {
      const list = await api.users.listUsers(organizationId);
      setUsers(list);
      setAlert(null);
    } catch (error) {
      setAlert(getProblemMessage(error, "Не удалось загрузить список пользователей."));
    } finally {
      setLoading(false);
    }
  }, [api, organizationId]);

  useEffect(() => {
    if (!session || !canEdit) {
      setLoading(false);
      return;
    }
    void loadUsers();
  }, [session, canEdit, loadUsers]);

  const summary = useMemo(() => {
    const admins = users.filter((user) => user.roleCodes.includes("administrator")).length;
    const managers = users.filter(
      (user) => user.roleCodes.includes("manager") && !user.roleCodes.includes("administrator")
    ).length;
    const blocked = users.filter((user) => user.status === "blocked").length;
    return { total: users.length, admins, managers, blocked };
  }, [users]);

  async function applyPatch(userId: string, request: PatchUserRequest, okMessage: string) {
    setSavingUserId(userId);
    setAlert(null);
    setSuccess(null);
    try {
      const updated = await api.users.patchUser(userId, request);
      setUsers((current) => current.map((user) => (user.id === userId ? updated : user)));
      setSuccess(okMessage);
    } catch (error) {
      setAlert(getProblemMessage(error, "Не удалось сохранить изменения."));
    } finally {
      setSavingUserId(null);
    }
  }

  function handleToggleBlock(user: OrganizationUser) {
    const nextStatus = user.status === "blocked" ? "active" : "blocked";
    void applyPatch(
      user.id,
      { status: nextStatus },
      nextStatus === "blocked"
        ? `«${user.displayName}» заблокирован.`
        : `«${user.displayName}» разблокирован.`
    );
  }

  function handleSetRole(user: OrganizationUser, role: PrimaryRole) {
    if (primaryRole(user) === role) {
      return;
    }
    void applyPatch(
      user.id,
      { roleCodes: [role] },
      `Роль «${user.displayName}» изменена на ${roleLabel(role)}.`
    );
  }

  async function handleCreateUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!organizationId) {
      return;
    }
    if (!createForm.displayName.trim()) {
      setAlert("Укажите имя пользователя.");
      return;
    }
    setCreating(true);
    setAlert(null);
    setSuccess(null);
    try {
      const created = await api.users.createUser(organizationId, {
        displayName: createForm.displayName.trim(),
        email: createForm.email.trim() || undefined,
        telegramUsername: createForm.telegramUsername.trim() || undefined,
        roleCodes: [createForm.role]
      });
      setUsers((current) => [...current, created]);
      setCreateForm(emptyCreateForm);
      setSuccess(`Пользователь «${created.displayName}» создан.`);
    } catch (error) {
      setAlert(getProblemMessage(error, "Не удалось создать пользователя."));
    } finally {
      setCreating(false);
    }
  }

  async function handleInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!organizationId) {
      return;
    }
    if (!inviteForm.contactValue.trim()) {
      setAlert("Укажите email или Telegram для приглашения.");
      return;
    }
    setInviting(true);
    setAlert(null);
    setSuccess(null);
    setInvitation(null);
    try {
      const request: CreateInvitationRequest = {
        organizationId,
        contactType: inviteForm.contactType,
        contactValue: inviteForm.contactValue.trim(),
        roleCode: inviteForm.role
      };
      const result = await api.users.createInvitation(request);
      setInvitation(result);
      setInviteForm(emptyInviteForm);
      setSuccess("Приглашение создано — передайте токен новому участнику.");
    } catch (error) {
      setAlert(getProblemMessage(error, "Не удалось создать приглашение."));
    } finally {
      setInviting(false);
    }
  }

  return (
    <section className="page-section">
      <div className="page-heading">
        <Badge tone="neutral">Доступы</Badge>
        <h1>Пользователи и роли</h1>
        <p>Администратор организации управляет менеджерами: добавление, роли, блокировка.</p>
      </div>

      {!canEdit ? (
        <Panel className="empty-state">
          <Badge tone="warning">Роль</Badge>
          <h2>Раздел доступен только администратору организации</h2>
        </Panel>
      ) : null}

      {alert ? (
        <div className="form-alert" role="alert">
          {alert}
        </div>
      ) : null}
      {success ? <div className="form-success">{success}</div> : null}

      {canEdit ? (
        <>
          <div className="summary-grid m2-summary">
            <Panel className="summary-panel">
              <span className="metric-label">Всего</span>
              <strong>{summary.total}</strong>
            </Panel>
            <Panel className="summary-panel">
              <span className="metric-label">Администраторы</span>
              <strong>{summary.admins}</strong>
            </Panel>
            <Panel className="summary-panel">
              <span className="metric-label">Менеджеры</span>
              <strong>{summary.managers}</strong>
            </Panel>
            <Panel className="summary-panel">
              <span className="metric-label">Заблокированы</span>
              <strong>{summary.blocked}</strong>
            </Panel>
          </div>

          <Panel as="form" className="m2-form" onSubmit={(event) => void handleCreateUser(event)}>
            <div className="panel-heading-row">
              <div>
                <h2>Добавить менеджера</h2>
                <p>Создаёт пользователя организации сразу с активным доступом.</p>
              </div>
              <Button disabled={creating} type="submit">
                <UserPlus aria-hidden="true" size={16} />
                {creating ? "Создаём…" : "Создать"}
              </Button>
            </div>
            <div className="form-grid">
              <TextInput
                id="user-display-name"
                label="Имя"
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setCreateForm((current) => ({ ...current, displayName: value }));
                }}
                placeholder="Иван Петров"
                value={createForm.displayName}
              />
              <TextInput
                id="user-email"
                label="Email (необязательно)"
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setCreateForm((current) => ({ ...current, email: value }));
                }}
                placeholder="manager@example.com"
                value={createForm.email}
              />
              <TextInput
                id="user-telegram"
                label="Telegram (необязательно)"
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setCreateForm((current) => ({ ...current, telegramUsername: value }));
                }}
                placeholder="manager_tg"
                value={createForm.telegramUsername}
              />
              <label className="field">
                <span className="field-label">Роль</span>
                <select
                  aria-label="Роль нового пользователя"
                  onChange={(event) =>
                    setCreateForm((current) => ({
                      ...current,
                      role: event.currentTarget.value as PrimaryRole
                    }))
                  }
                  value={createForm.role}
                >
                  <option value="manager">Менеджер</option>
                  <option value="administrator">Администратор</option>
                </select>
              </label>
            </div>
          </Panel>

          {loading ? <div className="route-loader">Загрузка пользователей...</div> : null}

          <Panel className="user-list-panel">
            <h2>Пользователи организации</h2>
            <div className="table-scroll">
              <table className="user-table">
                <thead>
                  <tr>
                    <th>Имя</th>
                    <th>Контакты</th>
                    <th>Роль</th>
                    <th>Статус</th>
                    <th aria-label="Действия" />
                  </tr>
                </thead>
                <tbody>
                  {users.map((user) => {
                    const isSelf = user.id === selfId;
                    const role = primaryRole(user);
                    const busy = savingUserId === user.id;
                    return (
                      <tr key={user.id} aria-label={user.displayName}>
                        <td>
                          <strong>{user.displayName}</strong>
                          {isSelf ? <span className="muted"> (вы)</span> : null}
                        </td>
                        <td className="muted">
                          {user.email ?? (user.telegramUsername ? `@${user.telegramUsername}` : "—")}
                        </td>
                        <td>
                          <select
                            aria-label={`Роль ${user.displayName}`}
                            className="role-select"
                            disabled={busy || isSelf}
                            onChange={(event) =>
                              handleSetRole(user, event.currentTarget.value as PrimaryRole)
                            }
                            value={role}
                          >
                            <option value="manager">Менеджер</option>
                            <option value="administrator">Администратор</option>
                          </select>
                        </td>
                        <td>
                          <Badge tone={user.status === "active" ? "success" : "warning"}>
                            {user.status === "active" ? "Активен" : "Заблокирован"}
                          </Badge>
                        </td>
                        <td className="row-actions">
                          <Button
                            disabled={busy || isSelf}
                            onClick={() => handleToggleBlock(user)}
                            type="button"
                            variant={user.status === "blocked" ? "secondary" : "danger"}
                          >
                            {user.status === "blocked" ? "Разблокировать" : "Заблокировать"}
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel as="form" className="m2-form" onSubmit={(event) => void handleInvite(event)}>
            <div className="panel-heading-row">
              <div>
                <h2>Пригласить по токену</h2>
                <p>
                  Автодоставка письма/сообщения пока не подключена — после создания скопируйте токен
                  и передайте новому участнику.
                </p>
              </div>
              <Button disabled={inviting} type="submit" variant="secondary">
                <Plus aria-hidden="true" size={16} />
                {inviting ? "Создаём…" : "Создать приглашение"}
              </Button>
            </div>
            <div className="form-grid">
              <label className="field">
                <span className="field-label">Тип контакта</span>
                <select
                  aria-label="Тип контакта приглашения"
                  onChange={(event) =>
                    setInviteForm((current) => ({
                      ...current,
                      contactType: event.currentTarget.value as "email" | "telegram"
                    }))
                  }
                  value={inviteForm.contactType}
                >
                  <option value="email">Email</option>
                  <option value="telegram">Telegram</option>
                </select>
              </label>
              <TextInput
                id="invite-contact"
                label={inviteForm.contactType === "email" ? "Email" : "Telegram username"}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setInviteForm((current) => ({ ...current, contactValue: value }));
                }}
                placeholder={inviteForm.contactType === "email" ? "new@example.com" : "new_manager"}
                value={inviteForm.contactValue}
              />
              <label className="field">
                <span className="field-label">Роль</span>
                <select
                  aria-label="Роль приглашения"
                  onChange={(event) =>
                    setInviteForm((current) => ({
                      ...current,
                      role: event.currentTarget.value as PrimaryRole
                    }))
                  }
                  value={inviteForm.role}
                >
                  <option value="manager">Менеджер</option>
                  <option value="administrator">Администратор</option>
                </select>
              </label>
            </div>
            {invitation ? (
              <div className="invitation-token">
                <ShieldCheck aria-hidden="true" size={16} />
                <div>
                  <span className="muted">
                    Токен приглашения ({invitation.roleCode}) для {invitation.contactValue}:
                  </span>
                  <code>{invitation.token}</code>
                </div>
              </div>
            ) : null}
          </Panel>
        </>
      ) : null}
    </section>
  );
}

function primaryRole(user: OrganizationUser): PrimaryRole {
  return user.roleCodes.includes("administrator") ? "administrator" : "manager";
}

function roleLabel(role: PrimaryRole): string {
  return role === "administrator" ? "Администратор" : "Менеджер";
}

function getProblemMessage(error: unknown, fallback: string): string {
  const withBody = error as { body?: { humanMessage?: string; code?: string } };
  if (withBody.body?.humanMessage) {
    return withBody.body.humanMessage;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}
