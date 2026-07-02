import { FormEvent, useState } from "react";
import { ArrowRight, Send } from "lucide-react";
import { Link } from "react-router-dom";

import type { TelegramLoginStartResponse } from "../../api/client/types";
import { useAuth } from "../../state/auth";
import { Badge, Button, Panel, TextInput } from "../../shared/ui-kit";

export default function LoginPage() {
  const { session, startTelegramLogin, verifyTelegramLogin } = useAuth();
  const [telegramUsername, setTelegramUsername] = useState("manager_demo");
  const [code, setCode] = useState("000000");
  const [challenge, setChallenge] = useState<TelegramLoginStartResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleStart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    try {
      setChallenge(await startTelegramLogin(telegramUsername));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Не удалось запросить код");
    } finally {
      setPending(false);
    }
  }

  async function handleVerify() {
    if (!challenge) {
      return;
    }

    setPending(true);
    setError(null);

    try {
      await verifyTelegramLogin(challenge.requestId, code);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Не удалось выполнить вход");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="login-page">
      <Panel className="login-panel">
        <div className="page-heading compact">
          <Badge tone="neutral">C3.auth mock</Badge>
          <h1>Вход менеджера</h1>
          <p>Заглушка Telegram-входа для проверки shell и будущей интеграции C3.auth.</p>
        </div>

        <form className="login-form" onSubmit={handleStart}>
          <TextInput
            label="Telegram username"
            onChange={(event) => setTelegramUsername(event.target.value)}
            value={telegramUsername}
          />
          <Button disabled={pending} type="submit">
            <Send aria-hidden="true" size={16} />
            Запросить код
          </Button>
        </form>

        {challenge ? (
          <div className="login-challenge">
            <Badge tone="success">Код отправлен в Telegram</Badge>
            <TextInput label="Код подтверждения" onChange={(event) => setCode(event.target.value)} value={code} />
            <Button disabled={pending} onClick={handleVerify} type="button">
              <ArrowRight aria-hidden="true" size={16} />
              Войти
            </Button>
          </div>
        ) : null}

        {session ? <p className="muted">Активная mock-сессия: {session.user.displayName}</p> : null}
        {error ? <p className="error-text">{error}</p> : null}

        <Link className="inline-link" to="/queue">
          Перейти в рабочее место
        </Link>
      </Panel>
    </main>
  );
}
