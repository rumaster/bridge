import { ArrowLeft, Building2, CheckCircle2, ExternalLink, Send } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import type { RegistrationStatus } from "../../api/client/types";
import { getApiErrorMessage } from "../../shared/api-error";
import { useAuth } from "../../state/auth";
import { Button, Panel, TextInput } from "../../shared/ui-kit";

/**
 * Регистрация администратора новой организации.
 *
 * Шаг «telegram» существует из-за ограничения Telegram Bot API: бот не может
 * написать пользователю первым, поэтому код нельзя отправить сразу после формы.
 * Пользователь открывает deep-link и жмёт Start — только тогда бот узнаёт его
 * chat_id и присылает код. Страница опрашивает статус заявки, пока код не уйдёт.
 *
 * Организация создаётся только на шаге verify; незавершённая заявка удаляется
 * через сутки.
 */
type RegisterStep = "form" | "telegram" | "code";

const STATUS_POLL_INTERVAL_MS = 3_000;

export default function RegisterPage() {
  const { getRegistrationStatus, startRegistration, verifyRegistration } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState<RegisterStep>("form");
  const [telegramUsername, setTelegramUsername] = useState("");
  const [email, setEmail] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [requestId, setRequestId] = useState<string | null>(null);
  const [deepLink, setDeepLink] = useState<string | null>(null);
  const [status, setStatus] = useState<RegistrationStatus>("pending");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Пока заявка ждёт /start, опрашиваем статус: код отправляет бот, а не форма.
  useEffect(() => {
    if (step !== "telegram" || !requestId) {
      return undefined;
    }

    let active = true;
    const intervalId = window.setInterval(() => {
      void getRegistrationStatus(requestId)
        .then((next) => {
          if (!active) {
            return;
          }

          setStatus(next.status);
          if (next.status === "code_sent") {
            setStep("code");
          }
          if (next.note) {
            setError(deliveryNoteMessage(next.note));
          }
        })
        .catch(() => {
          // Сетевой сбой опроса не должен рвать поток: следующий тик повторит.
        });
    }, STATUS_POLL_INTERVAL_MS);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [getRegistrationStatus, requestId, step]);

  async function handleStartRegistration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const started = await startRegistration({ email, organizationName, telegramUsername });
      setRequestId(started.requestId);
      setDeepLink(started.deepLink);
      setStatus(started.status);
      setStep("telegram");

      if (!started.deepLink) {
        setError(
          "Telegram-бот не настроен на сервере, поэтому код отправить некуда. Обратитесь к администратору платформы."
        );
      }
    } catch (nextError) {
      setError(getApiErrorMessage(nextError, "Не удалось начать регистрацию."));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleVerify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!requestId) {
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      await verifyRegistration({ code, requestId });
      navigate("/", { replace: true });
    } catch (nextError) {
      setError(getApiErrorMessage(nextError, "Не удалось подтвердить код."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-page">
      <Panel className="login-panel">
        <div className="login-mark">
          <Building2 aria-hidden="true" size={28} />
        </div>
        <div className="page-heading compact">
          <h1>Регистрация организации</h1>
          <p>
            Создайте организацию и станьте её администратором. Подтверждение приходит в Telegram.
          </p>
        </div>

        {error ? (
          <div className="form-alert" role="alert">
            {error}
          </div>
        ) : null}

        {step === "form" ? (
          <form className="stack-form" onSubmit={(event) => void handleStartRegistration(event)}>
            <TextInput
              autoComplete="username"
              label="Telegram-имя"
              onChange={(event) => setTelegramUsername(event.currentTarget.value)}
              pattern="^@?[A-Za-z0-9_]{5,32}$"
              placeholder="@new_admin"
              required
              value={telegramUsername}
            />
            <TextInput
              autoComplete="email"
              label="Email"
              onChange={(event) => setEmail(event.currentTarget.value)}
              placeholder="admin@example.com"
              required
              type="email"
              value={email}
            />
            <TextInput
              label="Название организации"
              maxLength={200}
              onChange={(event) => setOrganizationName(event.currentTarget.value)}
              placeholder="Acme Support"
              required
              value={organizationName}
            />
            <Button disabled={submitting} type="submit">
              <Send aria-hidden="true" size={16} />
              Продолжить
            </Button>
          </form>
        ) : null}

        {step === "telegram" ? (
          <div className="stack-form">
            <div className="inline-status">
              {status === "code_sent"
                ? "Код отправлен в Telegram."
                : "Откройте бота и нажмите Start — после этого он пришлёт код подтверждения."}
            </div>
            {deepLink ? (
              // Обычный <a>, а не Button asLink: Button ведёт через react-router
              // Link, т.е. внутренним роутом, а t.me — внешний адрес.
              <a
                className="button primary"
                href={deepLink}
                rel="noreferrer"
                target="_blank"
              >
                <ExternalLink aria-hidden="true" size={16} />
                Открыть бота в Telegram
              </a>
            ) : null}
            <div className="inline-status">
              Нажмите Start под именем @{telegramUsername.replace(/^@/, "")} — код придёт только
              на этот аккаунт. Ожидаем подтверждения...
            </div>
            <div className="form-actions">
              <Button
                disabled={submitting}
                onClick={() => {
                  setStep("form");
                  setError(null);
                }}
                type="button"
                variant="secondary"
              >
                <ArrowLeft aria-hidden="true" size={16} />
                Изменить данные
              </Button>
            </div>
          </div>
        ) : null}

        {step === "code" ? (
          <form className="stack-form" onSubmit={(event) => void handleVerify(event)}>
            <div className="inline-status">Код отправлен в Telegram, он действует 5 минут.</div>
            <TextInput
              autoComplete="one-time-code"
              inputMode="numeric"
              label="Код подтверждения"
              maxLength={6}
              onChange={(event) => setCode(event.currentTarget.value)}
              pattern="^[0-9]{6}$"
              required
              value={code}
            />
            <Button disabled={submitting} type="submit">
              <CheckCircle2 aria-hidden="true" size={16} />
              Создать организацию
            </Button>
          </form>
        ) : null}

        <p className="login-alt-action">
          Уже есть аккаунт? <Link to="/login">Войти</Link>
        </p>
      </Panel>
    </main>
  );
}

function deliveryNoteMessage(note: string): string {
  if (note === "telegram_bot_not_configured") {
    return "Telegram-бот не настроен на сервере: код отправить не удалось.";
  }

  return "Не удалось доставить код в Telegram. Убедитесь, что вы не заблокировали бота, и нажмите Start ещё раз.";
}
