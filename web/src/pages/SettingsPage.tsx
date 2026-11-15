import { useEffect, useState, type FormEvent } from 'react';
import { api, type Settings } from '../api.ts';
import { ErrorNote, PageHeader } from '../components/common.tsx';
import { useLoad } from '../hooks.ts';

export function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" />
      <div className="sections">
        <Secrets />
        <GitIdentity />
      </div>
    </>
  );
}

function Secrets() {
  const secrets = useLoad(api.secrets);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string>();

  const add = (event: FormEvent) => {
    event.preventDefault();
    api.setSecret(name, value).then(
      () => (setName(''), setValue(''), setError(undefined), secrets.reload()),
      (reason: Error) => setError(reason.message),
    );
  };
  const remove = (secret: string) => window.confirm(`Delete the secret ${secret}?`) && api.deleteSecret(secret).then(secrets.reload);

  return (
    <section className="card">
      <h2>Secrets</h2>
      <p className="muted">
        Stored encrypted. Values can be replaced but never read back, and they are never part of a formula. Commonly needed: <code>CLAUDE_CODE_OAUTH_TOKEN</code> or <code>ANTHROPIC_API_KEY</code>, <code>GITHUB_TOKEN</code>,{' '}
        <code>CLICKUP_TOKEN</code>.
      </p>
      <ErrorNote message={error ?? secrets.error} />
      <div className="list-editor">
        {secrets.data?.map((secret) => (
          <div className="list-row" key={secret}>
            <code className="grow">{secret}</code>
            <button className="ghost" onClick={() => setName(secret)}>
              Replace
            </button>
            <button className="ghost danger" onClick={() => remove(secret)}>
              Delete
            </button>
          </div>
        ))}
      </div>
      <form className="list-row" onSubmit={add}>
        <input placeholder="NAME" value={name} onChange={(event) => setName(event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))} />
        <input placeholder="value" type="password" autoComplete="new-password" value={value} onChange={(event) => setValue(event.target.value)} />
        <button className="primary" disabled={!name || !value}>
          Save secret
        </button>
      </form>
    </section>
  );
}

function GitIdentity() {
  const loaded = useLoad(api.settings);
  const [settings, setSettings] = useState<Settings>();
  const [notice, setNotice] = useState('');
  useEffect(() => setSettings(loaded.data), [loaded.data]);
  if (!settings) return null;

  const setGit = (changes: Partial<Settings['git']>) => (setSettings({ ...settings, git: { ...settings.git, ...changes } }), setNotice(''));
  const save = (event: FormEvent) => {
    event.preventDefault();
    api.saveSettings(settings).then(() => setNotice('Saved'), (reason: Error) => setNotice(reason.message));
  };

  return (
    <form className="card" onSubmit={save}>
      <h2>Commit author</h2>
      <p className="muted">Used by the pull request block when it commits. Leave empty to use the name and no-reply address of the GitHub token's owner.</p>
      <div className="field-pair">
        <label className="field">
          <span>Name</span>
          <input value={settings.git.name} onChange={(event) => setGit({ name: event.target.value })} />
        </label>
        <label className="field">
          <span>Email</span>
          <input type="email" value={settings.git.email} onChange={(event) => setGit({ email: event.target.value })} />
        </label>
      </div>
      <div className="actions">
        <button className="primary">Save</button>
        <span className="muted">{notice}</span>
      </div>
    </form>
  );
}
