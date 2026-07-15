import { Building2, LogIn, Send, ShieldCheck } from "lucide-react";
import { FormEvent, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

import type { LoginOrganizationChoice } from "../../api/client/types";
import type { LoginLocationState } from "../../routing/router";
import { getApiErrorCode, getApiErrorDiagnostics, getApiErrorMessage } from "../../shared/api-error";
import { useAuth } from "../../state/auth";
import { Button, Panel, TextInput } from "../../shared/ui-kit";

type LoginStep = "username" | "code" | "organization";

export default function LoginPage() {
  const { startTelegramLogin, status, verifyTelegramLogin } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const state = location.state as LoginLocationState | null;
  const returnTo = state?.from?.pathname ?? "/";
  const [step, setStep] = useState<LoginStep>("username");
  const [telegramUsername, setTelegramUsername] = useState("");
  const [code, setCode] = useState("");
  const [expiresInSeconds, setExpiresInSeconds] = useState<number | null>(null);
  const [organizations, setOrganizations] = useState<LoginOrganizationChoice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleStartLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const login = await startTelegramLogin({ telegramUsername });
      setTelegramUsername(login.telegramUsername);
      setExpiresInSeconds(login.expiresInSeconds);
      setStep("code");
    } catch (nextError) {
      setError(getApiErrorMessage(nextError, "Не удалось выполнить вход."));
    } finally {
      setSubmitting(false);
    }
  }

  async function submitCode(organizationId?: string) {
    setSubmitting(true);
    setError(null);

    try {
      await verifyTelegramLogin({ code, organizationId, telegramUsername });
      navigate(returnTo, { replace: true });
    } catch (nextError) {
      // Код верен, но аккаунт администрирует несколько организаций: бэкенд не
      // расходует код и возвращает список — показываем выбор.
      if (getApiErrorCode(nextError) === "ORGANIZATION_SELECTION_REQUIRED") {
        setOrganizations(readOrganizationChoices(nextError));
        setStep("organization");
        return;
      }

      setError(getApiErrorMessage(nextError, "Не удалось выполнить вход."));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleVerifyLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submitCode();
  }

  return (
    <main className="login-page">
      <Panel className="login-panel">
        <div className="login-mark">
          <ShieldCheck aria-hidden="true" size={28} />
        </div>
        <div className="page-heading compact">
          <h1>Вход администратора</h1>
          <p>Telegram-вход создаёт серверную сессию администратора организации.</p>
        </div>

        {error ? (
          <div className="form-alert" role="alert">
            {error}
          </div>
        ) : null}

        {step === "organization" ? (
          <div className="stack-form">
            <div className="inline-status">
              Ваш Telegram-аккаунт администрирует несколько организаций. Выберите, куда войти.
            </div>
            {organizations.map((organization) => (
              <Button
                disabled={submitting}
                key={organization.id}
                onClick={() => void submitCode(organization.id)}
                type="button"
                variant="secondary"
              >
                <Building2 aria-hidden="true" size={16} />
                {organization.name}
              </Button>
            ))}
          </div>
        ) : null}

        {step === "username" ? (
          <form className="stack-form" onSubmit={(event) => void handleStartLogin(event)}>
            <TextInput
              autoComplete="username"
              label="Telegram-имя"
              onChange={(event) => setTelegramUsername(event.currentTarget.value)}
              pattern="^@?[A-Za-z0-9_]{5,32}$"
              placeholder="@admin_demo"
              required
              value={telegramUsername}
            />
            <Button disabled={status === "loading" || submitting} type="submit">
              <Send aria-hidden="true" size={16} />
              Отправить код
            </Button>
          </form>
        ) : null}

        {step === "code" ? (
          <form className="stack-form" onSubmit={(event) => void handleVerifyLogin(event)}>
            <div className="inline-status">
              Код отправлен в Telegram
              {expiresInSeconds ? `, срок действия ${Math.round(expiresInSeconds / 60)} мин.` : ""}
            </div>
            <TextInput
              autoComplete="one-time-code"
              inputMode="numeric"
              label="Одноразовый код"
              maxLength={6}
              onChange={(event) => setCode(event.currentTarget.value)}
              pattern="^[0-9]{6}$"
              required
              value={code}
            />
            <div className="form-actions">
              <Button disabled={submitting} type="submit">
                <LogIn aria-hidden="true" size={16} />
                Войти
              </Button>
              <Button
                disabled={submitting}
                onClick={() => {
                  setStep("username");
                  setCode("");
                  setError(null);
                }}
                type="button"
                variant="secondary"
              >
                Изменить имя
              </Button>
            </div>
          </form>
        ) : null}

        <p className="login-alt-action">
          Нет организации? <Link to="/register">Зарегистрировать</Link>
        </p>
      </Panel>
    </main>
  );
}

function readOrganizationChoices(error: unknown): LoginOrganizationChoice[] {
  const organizations = getApiErrorDiagnostics(error)?.organizations;

  return Array.isArray(organizations) ? (organizations as LoginOrganizationChoice[]) : [];
}
