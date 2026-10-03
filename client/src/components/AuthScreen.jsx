import { useEffect, useState } from 'react';
import { useStore } from '../state/store.js';

function Field({ label, type = 'text', value, onChange, autoComplete, autoFocus, hint }) {
  return (
    <label className="auth-field">
      <span>{label}</span>
      <input type={type} value={value} autoComplete={autoComplete} autoFocus={autoFocus} spellCheck={false}
        onChange={(e) => onChange(e.target.value)} />
      {hint && <small>{hint}</small>}
    </label>
  );
}

/** Sign-in, sign-up and first-run setup. */
export function AuthScreen() {
  const auth = useStore((s) => s.auth);
  const st = useStore.getState();
  const [mode, setMode] = useState(auth.phase === 'setup' ? 'setup' : 'login');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [setupCode, setSetupCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(auth.error || null);
  useEffect(() => { setError(auth.error || null); }, [auth.error]);

  if (auth.phase === 'loading') {
    return <div className="auth-wrap"><div className="auth-card"><div className="spinner" /></div></div>;
  }
  if (auth.phase === 'offline') {
    return (
      <div className="auth-wrap">
        <div className="auth-card">
          <Brand />
          <p className="auth-error">Can't reach the GreanTeaDawy server ({auth.error}). Retrying…</p>
          <p className="muted">Make sure it is running: <code>npm start</code> or <code>npm run dev</code>.</p>
        </div>
      </div>
    );
  }

  const isSetup = auth.phase === 'setup';
  const current = isSetup ? 'setup' : mode;

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    if ((current === 'setup' || current === 'register') && password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    setBusy(true);
    try {
      if (current === 'setup') await st.setupAdmin({ username, password, displayName, setupCode });
      else if (current === 'register') await st.signUp({ username, password, displayName });
      else await st.signIn({ username, password });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit} onKeyDown={(e) => e.stopPropagation()}>
        <Brand />
        {current === 'setup' && (
          <>
            <h2>Welcome! Create the admin account</h2>
            <p className="muted">This first account manages the studio: users, sign-up and MCP access. Your projects stay private to your account.</p>
          </>
        )}
        {current === 'login' && <h2>Sign in to your studio</h2>}
        {current === 'register' && <h2>Create your account</h2>}
        {current === 'setup' && auth.setupCodeRequired && (
          <Field label="Setup code" value={setupCode} onChange={setSetupCode} autoComplete="one-time-code" autoFocus
            hint="Printed in the server log when it starts — proves you run this server." />
        )}
        {(current === 'setup' || current === 'register') && (
          <Field label="Display name" value={displayName} onChange={setDisplayName} autoComplete="name" autoFocus={!auth.setupCodeRequired} />
        )}
        <Field label="Username" value={username} onChange={setUsername} autoComplete="username" autoFocus={current === 'login'}
          hint={current !== 'login' ? '3–32 characters: letters, digits, _ . -' : undefined} />
        <Field label="Password" type="password" value={password} onChange={setPassword}
          autoComplete={current === 'login' ? 'current-password' : 'new-password'} hint={current !== 'login' ? 'At least 8 characters' : undefined} />
        {(current === 'setup' || current === 'register') && (
          <Field label="Confirm password" type="password" value={confirm} onChange={setConfirm} autoComplete="new-password" />
        )}
        {error && <p className="auth-error" role="alert">{error}</p>}
        <button className="btn primary auth-submit" type="submit" disabled={busy || !username || !password}>
          {busy ? 'Please wait…' : current === 'setup' ? 'Create admin & open studio' : current === 'register' ? 'Create account' : 'Sign in'}
        </button>
        {!isSetup && auth.allowRegistration && (
          <p className="auth-switch">
            {mode === 'login'
              ? <>New here? <button type="button" className="link" onClick={() => { setMode('register'); setError(null); }}>Create an account</button></>
              : <>Already have an account? <button type="button" className="link" onClick={() => { setMode('login'); setError(null); }}>Sign in</button></>}
          </p>
        )}
        {!isSetup && !auth.allowRegistration && <p className="auth-switch muted">Need an account? Ask your studio admin.</p>}
      </form>
    </div>
  );
}

function Brand() {
  return (
    <div className="auth-brand">
      <span className="logo-mark">◆</span>
      <div>
        <div className="auth-title">GreanTeaDawy</div>
        <div className="auth-sub">Make beats in your browser — with Claude as your co-producer</div>
      </div>
    </div>
  );
}
