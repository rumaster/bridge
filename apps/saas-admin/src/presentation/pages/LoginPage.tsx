import { LogIn, Send, ShieldCheck } from "lucide-react";
import { FormEvent, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import type { ProblemDetails } from "../../api/client/types";
import type { LoginLocationState } from "../../routing/router";
import { useAuth } from "../../state/auth";
import { Button, Panel, TextInput } from "../../shared/ui-kit";

type LoginStep = "username" | "code";

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
      setError(getErrorMessage(nextError));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleVerifyLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      await verifyTelegramLogin({
        telegramUsername,
        code
      });
      navigate(returnTo, { replace: true });
    } catch (nextError) {
      setError(getErrorMessage(nextError));
    } finally {
      setSubmitting(false);
    }
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
        ) : (
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
        )}
      </Panel>
    </main>
  );
}

function getErrorMessage(error: unknown) {
  if (isProblemError(error)) {
    return error.body.detail;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Не удалось выполнить вход.";
}

function isProblemError(error: unknown): error is { body: ProblemDetails } {
  return (
    typeof error === "object" &&
    error !== null &&
    "body" in error &&
    typeof (error as { body?: unknown }).body === "object" &&
    (error as { body?: { detail?: unknown } }).body !== null &&
    typeof (error as { body: { detail?: unknown } }).body.detail === "string"
  );
}
