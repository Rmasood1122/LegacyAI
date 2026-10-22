// The company's own sign-in (SSO, feature 16): the Owner connects the company's identity provider (OpenID Connect).
// A sign-in there counts as the strong factor - like a passkey - and never replaces the card or its 3-digit code.
// People link their company account when they set up their card. The client secret is sent to the API once and is
// never shown again.
import { useState, type FormEvent } from 'react';
import { useApiMutation, useApiQuery } from '../../api/context.tsx';
import type { SsoConnection } from '../../api/generated.ts';
import { useSession } from '../../session/session.tsx';
import { Banner, Button, Card, CheckboxField, ConfirmButton, ErrorNote, Facts, formatDate, Loading, Page, TextField } from '../../ui/index.tsx';

const CHANGED = ['getSsoConnection'] as const;

export function SsoScreen() {
  const { can } = useSession();
  const current = useApiQuery('getSsoConnection', undefined);
  const remove = useApiMutation('removeSsoConnection', CHANGED);
  return (
    <Page title="Company sign-in" intro="People can sign in with their company account (for example the one they use for e-mail) instead of a passkey or an app code. They still need their card and its 3-digit code. Each person links their company account once, when they set up their card.">
      {current.isPending && <Loading what="the company sign-in" />}
      <ErrorNote error={current.error} />
      {current.data !== undefined && (
        <>
          <Card title="Register this address at your provider">
            <p className="code" data-testid="redirect-uri">{current.data.redirect_uri}</p>
            <p className="hint">Your provider sends people back to this address after they sign in. Register it exactly as shown.</p>
          </Card>
          {current.data.connection !== null && <Current connection={current.data.connection} />}
          {can('putSsoConnection') && <ConnectionForm existing={current.data.connection} />}
          {current.data.connection !== null && can('removeSsoConnection') && (
            <Card title="Remove the company sign-in">
              <p>Everyone who signs in with their company account has to set up a passkey or an app code again. Their sessions opened with the company account end now.</p>
              <ErrorNote error={remove.error} />
              <ConfirmButton label="Remove the company sign-in" confirmLabel="Yes, remove it for good" resetKey="remove-sso"
                busy={remove.isPending} onConfirm={() => remove.mutate({})} />
            </Card>
          )}
          {/* outside the card above: once removed there is no connection, and the card is gone */}
          {remove.isSuccess && <Banner tone="success">Removed. {remove.data.factors_revoked} linked company account(s) no longer sign anyone in.</Banner>}
        </>
      )}
    </Page>
  );
}

function Current({ connection }: { connection: SsoConnection }) {
  return (
    <Card title={connection.name}>
      <Facts items={[
        ['Provider (issuer)', connection.issuer], ['Client id', connection.client_id],
        ['State', connection.enabled ? 'Switched on' : 'Switched off'], ['Client secret', connection.has_client_secret ? 'Stored (never shown)' : 'Missing'],
        ['Last changed', formatDate(connection.updated_at)],
      ]} />
    </Card>
  );
}

function ConnectionForm({ existing }: { existing: SsoConnection | null }) {
  const save = useApiMutation('putSsoConnection', CHANGED);
  const [name, setName] = useState(existing?.name ?? 'Company sign-in');
  const [issuer, setIssuer] = useState(existing?.issuer ?? 'https://');
  const [clientId, setClientId] = useState(existing?.client_id ?? '');
  const [secret, setSecret] = useState('');
  const [enabled, setEnabled] = useState(existing?.enabled ?? false);
  const ready = name.trim() !== '' && /^https:\/\/[^\s/]+\.[^\s]+$/.test(issuer.trim()) && clientId.trim() !== '' && (existing !== null || secret !== '');
  const onSave = (e: FormEvent): void => {
    e.preventDefault();
    save.mutate({ body: { name: name.trim(), issuer: issuer.trim(), client_id: clientId.trim(), enabled, ...(secret === '' ? {} : { client_secret: secret }) } }, {
      onSuccess: () => setSecret(''),
    });
  };
  return (
    <Card title={existing === null ? 'Connect your provider' : 'Change the connection'}>
      <form onSubmit={onSave} noValidate>
        <TextField label="Name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        <TextField label="Provider (issuer)" value={issuer} disabled={existing !== null} onChange={(e) => setIssuer(e.target.value)}
          hint={existing === null ? 'The OpenID Connect issuer address your provider gives you. It cannot be changed later.' : 'Another provider needs a new connection: remove this one first.'} />
        <TextField label="Client id" value={clientId} onChange={(e) => setClientId(e.target.value)} />
        <TextField label={existing === null ? 'Client secret' : 'New client secret (leave empty to keep the stored one)'} type="password" autoComplete="off"
          value={secret} onChange={(e) => setSecret(e.target.value)} />
        <CheckboxField label="Switched on (people can use it once the factor is allowed in the settings)" checked={enabled} onChange={setEnabled} />
        <ErrorNote error={save.error} />
        {save.isSuccess && <Banner tone="success">Saved.</Banner>}
        <Button type="submit" variant="primary" busy={save.isPending} disabled={!ready}>Save</Button>
      </form>
    </Card>
  );
}
