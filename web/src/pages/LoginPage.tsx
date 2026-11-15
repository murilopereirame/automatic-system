import { useState, type FormEvent } from 'react';
import { api } from '../api.ts';

export function LoginPage({ onSignedIn }: { onSignedIn: () => void }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    api.login(token).then(onSignedIn, (reason: Error) => setError(reason.message));
  };

  return (
    <form className="login card" onSubmit={submit}>
      <h1>Auto Worker</h1>
      <label>
        Access token
        <input type="password" value={token} onChange={(event) => setToken(event.target.value)} autoFocus />
      </label>
      <p className="hint">The value of AUTOWORKER_TOKEN. If none was set, the server printed one at startup.</p>
      {error && <p className="error">{error}</p>}
      <button className="primary" disabled={!token}>
        Sign in
      </button>
    </form>
  );
}
