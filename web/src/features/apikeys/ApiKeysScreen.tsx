// API keys for machines (feature 28): make a key (it is shown once), see the keys, revoke one.
// A key can read and ask, nothing else. It never holds more than the card that made it, and it ends for good when
// that card's sign-in or rights change. The screen offers only what the API says this card could put into a key,
// and the API checks everything again.
import { useState } from 'react';
import type { ApiKey, ApiKeyCreated, ApiKeyOptions, ApiKeyPermission } from '../../api/generated.ts';
import { useSession } from '../../session/session.tsx';
import {
  Badge, Banner, Button, Card, CheckboxField, ConfirmButton, DataTable, Empty, ErrorNote, formatDate, Loading, Page, SelectField, sensitivityLabel, ShownOnce,
  TextField,
} from '../../ui/index.tsx';
import {
  emptyForm, highestLevel, KEYS_SHOWN, parseKeyForm, PERMISSION_TEXT, REVOKED_TEXT, STATUS_TEXT, useApiKeyOptions, useApiKeys, useCreateApiKey,
  useRefreshKeys, useRevokeApiKey, type KeyForm,
} from './hooks.ts';

export function ApiKeysScreen() {
  const { can } = useSession();
  const mayMake = can('createApiKey');
  const keys = useApiKeys();
  const options = useApiKeyOptions({ enabled: mayMake });
  // The key that was just made lives HERE, above the list: making a key re-reads the list, and nothing that the
  // list does (loading, failing, re-drawing) may take the key off the screen before the person has copied it.
  const [made, setMade] = useState<ApiKeyCreated | null>(null);
  return (
    <Page title="API keys" intro="A key lets another system read knowledge and ask questions without a person signing in. It is for use between servers, never in a web page. It can never do more than the card that makes it, and it ends for good when that card’s code, sign-in or roles change, or the card is suspended, revoked, locked or replaced.">
      {made !== null && (
        <ShownOnce title={`The key “${made.name}” was made`} label="Key" value={made.api_key} doneLabel="I have copied the key"
          replayText="It cannot be shown a second time. If nobody copied it, revoke it and make a new one." onDone={() => setMade(null)} />
      )}
      {mayMake && made === null && (
        <>
          {options.isPending && <Loading what="what a key may carry" />}
          <ErrorNote error={options.error} />
          {options.data !== undefined && <NewKey options={options.data} onMade={setMade} />}
        </>
      )}
      {keys.isPending && <Loading what="API keys" />}
      <ErrorNote error={keys.error} />
      {keys.data !== undefined && <KeyList items={keys.data.items} more={keys.data.next_cursor !== null} />}
    </Page>
  );
}

function NewKey({ options, onMade }: { options: ApiKeyOptions; onMade: (made: ApiKeyCreated) => void }) {
  const create = useCreateApiKey();
  const refreshKeys = useRefreshKeys();
  const { grantable, limits } = options;
  const [form, setForm] = useState<KeyForm>(() => emptyForm(limits));
  const [tried, setTried] = useState(false);
  const parsed = parseKeyForm(form, options);
  const problems = !parsed.ok && tried ? parsed.problems : {};
  const top = highestLevel(form.scope, grantable);
  const toggle = (permission: ApiKeyPermission, on: boolean): void => {
    const scope = new Set(form.scope);
    if (on) scope.add(permission); else scope.delete(permission);
    // a level that the new choice no longer allows falls back to the highest that it does
    setForm({ ...form, scope, level: String(Math.min(Number(form.level), highestLevel(scope, grantable))) });
  };
  if (grantable.length === 0) return <Banner tone="info" title="Your card holds nothing a key may carry">A key can only be given what its maker may do.</Banner>;
  return (
    <Card title="Make a key">
      <ErrorNote error={create.error} />
      <TextField label="Name" value={form.name} maxLength={100} onChange={(e) => setForm({ ...form, name: e.target.value })}
        hint="What the key is for, for example the name of the system that uses it." error={problems.name ?? null} />
      <fieldset>
        <legend>What the key may do</legend>
        {grantable.map((g) => (
          <CheckboxField key={g.permission} label={PERMISSION_TEXT[g.permission]} checked={form.scope.has(g.permission)} onChange={(on) => toggle(g.permission, on)} />
        ))}
        {problems.scope !== undefined && <p className="field-error" role="alert">{problems.scope}</p>}
      </fieldset>
      <SelectField label="Highest level the key reads" value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value })}
        hint="The key reads nothing labelled above this level, whatever you may read yourself." error={problems.level ?? null}>
        {[0, 1, 2, 3].filter((level) => level <= top).map((level) => <option key={level} value={String(level)}>{sensitivityLabel(level)}</option>)}
      </SelectField>
      <TextField label="Valid for (days)" inputMode="numeric" value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })}
        hint={`Every key expires. At most ${limits.max_expires_in_days} days.`} error={problems.days ?? null} />
      <TextField label="Questions per hour" inputMode="numeric" value={form.asks} onChange={(e) => setForm({ ...form, asks: e.target.value })}
        hint={`How often the key may ask a question in one hour (at most ${limits.max_asks_per_hour}). Questions use the company’s AI budget, which people share with the key. Every key is also limited to ${limits.requests_per_minute} requests a minute.`}
        error={problems.asks ?? null} />
      <TextField label="Only from these networks (optional)" value={form.networks} onChange={(e) => setForm({ ...form, networks: e.target.value })}
        hint="Network addresses such as 203.0.113.0/24, separated by spaces. Empty = from anywhere." error={problems.networks ?? null} />
      <Button variant="primary" busy={create.isPending} onClick={() => {
        setTried(true);
        if (!parsed.ok) return;
        create.mutate({ body: parsed.body }, {
          onSuccess: (key) => {
            onMade(key);       // handed to the screen first, which keeps it while the list is read again
            create.reset();    // not kept in the request's own result
            refreshKeys();
          },
        });
      }}>Make the key</Button>
    </Card>
  );
}

function KeyList({ items, more }: { items: readonly ApiKey[]; more: boolean }) {
  const { can } = useSession();
  const revoke = useRevokeApiKey();
  return (
    <div>
      <h2>Keys of the company</h2>
      <ErrorNote error={revoke.error} />
      {items.length === 0 ? <Empty>No key has been made yet.</Empty> : (
        <DataTable caption="API keys" columns={['Name', 'Ends in', 'May do', 'Up to level', 'Questions per hour', 'State', 'Expires', 'Last used', '']}>
          {items.map((k) => (
            <tr key={k.id}>
              <td>{k.name}</td>
              <td>…{k.secret_hint}</td>
              <td>{k.scope.map((p) => PERMISSION_TEXT[p]).join('; ')}{k.allowed_cidrs !== null ? ` (only from ${k.allowed_cidrs.join(', ')})` : ''}</td>
              <td>{sensitivityLabel(k.max_sensitivity)}</td>
              <td>{k.asks_per_hour}</td>
              <td>
                <Badge tone={STATUS_TEXT[k.status].tone}>{STATUS_TEXT[k.status].text}</Badge>
                {k.status === 'revoked' && k.revoked_reason !== null && <span className="muted"> ({REVOKED_TEXT[k.revoked_reason]})</span>}
              </td>
              <td>{formatDate(k.expires_at)}</td>
              <td>{k.last_used_at === null ? 'Never' : formatDate(k.last_used_at)}</td>
              <td>
                {can('revokeApiKey') && k.status !== 'revoked' && (
                  <ConfirmButton label={`Revoke ${k.name}`} confirmLabel="Yes, revoke it for good" resetKey={k.id}
                    busy={revoke.isPending && revoke.variables?.path.api_key_id === k.id} onConfirm={() => revoke.mutate({ path: { api_key_id: k.id } })} />
                )}
              </td>
            </tr>
          ))}
        </DataTable>
      )}
      {more && <p className="muted">Only the newest {KEYS_SHOWN} keys are shown.</p>}
    </div>
  );
}
