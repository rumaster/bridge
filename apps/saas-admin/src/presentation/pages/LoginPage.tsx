import { ShieldCheck } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";

import type { LoginLocationState } from "../../routing/router";
import { useAuth } from "../../state/auth";
import { Button, Panel } from "../../shared/ui-kit";

export default function LoginPage() {
  const { loginAsDemoAdmin, status } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const state = location.state as LoginLocationState | null;
  const returnTo = state?.from?.pathname ?? "/overview";

  async function handleDemoLogin() {
    await loginAsDemoAdmin();
    navigate(returnTo, { replace: true });
  }

  return (
    <main className="login-page">
      <Panel className="login-panel">
        <div className="login-mark">
          <ShieldCheck aria-hidden="true" size={28} />
        </div>
        <div className="page-heading compact">
          <h1>Вход администратора</h1>
          <p>Демо-доступ открывает каркас разделов организации без изменения данных.</p>
        </div>
        <Button disabled={status === "loading"} onClick={() => void handleDemoLogin()} type="button">
          Войти как демо-администратор
        </Button>
      </Panel>
    </main>
  );
}
