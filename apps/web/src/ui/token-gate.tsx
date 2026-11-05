// Asks for the server's access token (APP_AUTH_TOKEN) when the API answers 401, stores it in
// localStorage "agentco.token" and reloads. Off loopback (Docker / LAN / VPS) the server requires it.
import { useEffect, useRef, useState } from "react";
import { readToken, saveToken, setUnauthorizedHandler } from "../api";
import { Button, Field, Modal } from "./kit";

export function TokenGate() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [hadToken] = useState(() => readToken() !== null);
  // Background polling also gets 401s: once dismissed, stay closed until the page is reloaded.
  const dismissed = useRef(false);
  useEffect(() => setUnauthorizedHandler(() => !dismissed.current && setOpen(true)), []);
  const close = () => {
    dismissed.current = true;
    setOpen(false);
  };
  if (!open) return null;
  const submit = () => {
    const token = value.trim();
    if (!token) return;
    saveToken(token);
    location.reload();
  };
  return (
    <Modal
      title="Access token required"
      onClose={close}
      width={460}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={!value.trim()}>
            Save and reload
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <p className="muted" style={{ marginTop: 0 }}>
          {hadToken ? "The saved token was rejected. " : ""}This AgentCo server is reachable from the network, so it needs the
          value of <code>APP_AUTH_TOKEN</code> from its <code>.env</code>. It is stored in this browser only.
        </p>
        <Field label="Token">
          <input type="password" autoComplete="off" spellCheck={false} value={value} onChange={(e) => setValue(e.target.value)} data-autofocus />
        </Field>
      </form>
    </Modal>
  );
}
