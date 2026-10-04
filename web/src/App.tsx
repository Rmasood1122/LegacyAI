// The frame around every screen: sign-in when nobody is signed in, otherwise the menu (only the
// screens this card may use) and the current screen.
import { useEffect } from 'react';
import { NavLink, Route, Routes } from 'react-router';
import { EnrollScreen } from './features/auth/EnrollScreen.tsx';
import { SignInScreen } from './features/auth/SignInScreen.tsx';
import { dropCardFragment } from './navigation/cardLink.ts';
import { mayOpen } from './navigation/routes.ts';
import { SCREENS } from './screens.tsx';
import { useSession } from './session/session.tsx';
import { Banner, Button, Loading, Page } from './ui/index.tsx';

export function App() {
  const { state } = useSession();
  if (state.status === 'loading') return <main><Loading what="LegacyAI" /></main>;
  if (state.status === 'error') {
    return <main><Banner tone="danger" title="LegacyAI could not be reached">{state.message} Reload the page to try again.</Banner></main>;
  }
  if (state.status === 'signed_out') {
    return (
      <main id="main">
        <Routes>
          <Route path="/set-up" element={<EnrollScreen />} />
          <Route path="*" element={<SignInScreen />} />
        </Routes>
      </main>
    );
  }
  return <SignedIn />;
}

function SignedIn() {
  const { state, can, signOut } = useSession();
  // Someone already signed in who opens a card's QR address: the sign-in screen (which reads the card number and
  // removes it) is not shown, so the number is taken out of the address bar here, once.
  useEffect(() => dropCardFragment(window.location, window.history), []);
  if (state.status !== 'signed_in') return null;
  const allowed = SCREENS.filter((s) => mayOpen(s, can));
  const manage = allowed.filter((s) => s.label !== undefined && s.menu === 'manage');
  return (
    <div className="shell">
      <a className="skip-link" href="#main">Skip to the content</a>
      <header className="topbar">
        <NavLink to="/" className="brand">LegacyAI</NavLink>
        <nav className="nav" aria-label="Main">
          {allowed.filter((s) => s.label !== undefined && s.menu === undefined).map((s) => (
            <NavLink key={s.path} to={s.path} end={s.path === '/'}>{s.label}</NavLink>
          ))}
        </nav>
        <div className="who">
          <span>Card {state.session.card_number_masked}</span>
          <Button onClick={() => void signOut()}>Sign out</Button>
        </div>
      </header>
      {manage.length > 0 && (
        <nav className="nav subnav" aria-label="Manage">
          {manage.map((s) => <NavLink key={s.path} to={s.path}>{s.label}</NavLink>)}
        </nav>
      )}
      <main id="main" tabIndex={-1}>
        {state.session.read_only && (
          <Banner tone="warning" title="This card is read-only">
            Its validity has ended and it is in its grace period. You can read and export, but not change anything. Ask an administrator to renew it.
          </Banner>
        )}
        <Routes>
          {allowed.map((s) => <Route key={s.path} path={s.path} element={<s.component />} />)}
          <Route path="*" element={<NotAvailable />} />
        </Routes>
      </main>
    </div>
  );
}

function NotAvailable() {
  return (
    <Page title="This screen is not available">
      <p>The address does not exist, or this card is not allowed to use it.</p>
      <p><NavLink to="/">Back to the start</NavLink></p>
    </Page>
  );
}
