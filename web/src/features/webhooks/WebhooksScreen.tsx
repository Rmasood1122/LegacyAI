// Outgoing webhooks (feature 28, part B): register an https endpoint (its signing secret is shown once), see the
// endpoints and what happened to their messages, switch one off or on, send a test message, make a new secret,
// remove one. Messages say THAT a knowledge item changed (its id and label), never what it says.
import { useState } from 'react';
import type { WebhookEndpoint, WebhookEndpointWithSecret, WebhookOptions, WebhookTopic } from '../../api/generated.ts';
import { useSession } from '../../session/session.tsx';
import {
  Badge, Banner, Button, Card, CheckboxField, ConfirmButton, DataTable, Empty, ErrorNote, formatDate, Loading, Page, SelectField, sensitivityLabel, ShownOnce,
  TextField,
} from '../../ui/index.tsx';
import {
  DELIVERIES_SHOWN, DELIVERY_TEXT, emptyEndpointForm, ERROR_TEXT, parseEndpointForm, STATUS_TEXT, useCreateWebhook, useRefreshWebhooks, useRemoveWebhook,
  useRotateWebhookSecret, useSendWebhookTest, useUpdateWebhook, useWebhookDeliveries, useWebhookEndpoints, useWebhookOptions, type EndpointForm,
} from './hooks.ts';

export function WebhooksScreen() {
  const { can } = useSession();
  const endpoints = useWebhookEndpoints();
  const options = useWebhookOptions();
  // A secret that was just shown lives HERE, above the list, for the same reason as a new API key: nothing the list
  // does may take it off the screen before the person has copied it.
  const [secret, setSecret] = useState<WebhookEndpointWithSecret | null>(null);
  return (
    <Page title="Webhooks" intro="A webhook tells another system - for example an intranet search - when knowledge is verified, changes or is withdrawn. Each message names the item and its level, never its text: the other system reads the item with an API key if it needs it. Messages are signed, so the receiver can check they came from LegacyAI.">
      {options.data !== undefined && !options.data.delivery_enabled && (
        <Banner tone="warning" title="This server sends no webhooks yet">
          Endpoints can be registered, but nothing is sent until sending is switched on for this server.
        </Banner>
      )}
      {secret !== null && (
        <ShownOnce title={`The signing secret of “${secret.name}”`} label="Signing secret" value={secret.signing_secret} doneLabel="I have copied the secret"
          replayText="It cannot be shown a second time. If nobody copied it, make a new secret." onDone={() => setSecret(null)} />
      )}
      {can('createWebhookEndpoint') && secret === null && (
        <>
          {options.isPending && <Loading what="the events" />}
          <ErrorNote error={options.error} />
          {options.data !== undefined && <NewEndpoint options={options.data} onMade={setSecret} />}
        </>
      )}
      {endpoints.isPending && <Loading what="webhook endpoints" />}
      <ErrorNote error={endpoints.error} />
      {endpoints.data !== undefined && <EndpointList items={endpoints.data.items} topics={options.data?.topics ?? []} onSecret={setSecret} />}
    </Page>
  );
}

function NewEndpoint({ options, onMade }: { options: WebhookOptions; onMade: (made: WebhookEndpointWithSecret) => void }) {
  const create = useCreateWebhook();
  const refresh = useRefreshWebhooks();
  const [form, setForm] = useState<EndpointForm>(emptyEndpointForm);
  const [tried, setTried] = useState(false);
  const parsed = parseEndpointForm(form);
  const problems = !parsed.ok && tried ? parsed.problems : {};
  const toggle = (topic: WebhookTopic, on: boolean): void => {
    const topics = new Set(form.topics);
    if (on) topics.add(topic); else topics.delete(topic);
    setForm({ ...form, topics });
  };
  return (
    <Card title="Register an endpoint">
      <ErrorNote error={create.error} />
      <TextField label="Name" value={form.name} maxLength={100} onChange={(e) => setForm({ ...form, name: e.target.value })}
        hint="What receives the messages, for example the name of the system." error={problems.name ?? null} />
      <TextField label="Address" value={form.url} maxLength={2048} onChange={(e) => setForm({ ...form, url: e.target.value })}
        hint="An https address on the internet, on the standard port. Addresses inside a private network are refused." error={problems.url ?? null} />
      <fieldset>
        <legend>Events to send</legend>
        {options.topics.map((t) => (
          <CheckboxField key={t.topic} label={t.description} checked={form.topics.has(t.topic)} onChange={(on) => toggle(t.topic, on)} />
        ))}
        {problems.topics !== undefined && <p className="field-error" role="alert">{problems.topics}</p>}
      </fieldset>
      <SelectField label="Highest level reported" value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value })}
        hint="Nothing is said about knowledge labelled above this level." error={problems.level ?? null}>
        {[0, 1, 2, 3].map((level) => <option key={level} value={String(level)}>{sensitivityLabel(level)}</option>)}
      </SelectField>
      <Button variant="primary" busy={create.isPending} onClick={() => {
        setTried(true);
        if (!parsed.ok) return;
        create.mutate({ body: parsed.body }, {
          onSuccess: (made) => {
            onMade(made);
            create.reset();
            refresh();
          },
        });
      }}>Register the endpoint</Button>
      <p className="muted">At most {options.limits.max_endpoints} endpoints. A message that fails is tried {options.limits.max_attempts} times over about two days.</p>
    </Card>
  );
}

function EndpointList({ items, topics, onSecret }: {
  items: readonly WebhookEndpoint[]; topics: WebhookOptions['topics']; onSecret: (s: WebhookEndpointWithSecret) => void;
}) {
  const { can } = useSession();
  const update = useUpdateWebhook();
  const remove = useRemoveWebhook();
  const test = useSendWebhookTest();
  const rotate = useRotateWebhookSecret();
  const refresh = useRefreshWebhooks();
  const [open, setOpen] = useState<string | null>(null);
  const topicText = (t: WebhookTopic): string => topics.find((x) => x.topic === t)?.description ?? t;
  const busy = (m: { isPending: boolean; variables?: { path: { webhook_id: string } } }, id: string): boolean => m.isPending && m.variables?.path.webhook_id === id;
  return (
    <div>
      <h2>Endpoints of the company</h2>
      {[update, remove, test, rotate].map((m, i) => <ErrorNote key={i} error={m.error} />)}
      {test.isSuccess && <Banner tone="info">The test message is queued; it is sent with the next delivery run.</Banner>}
      {items.length === 0 ? <Empty>No endpoint has been registered yet.</Empty> : (
        <DataTable caption="Webhook endpoints" columns={['Name', 'Address', 'Events', 'Up to level', 'State', 'Last delivered', 'Secret ends in', '']}>
          {items.map((e) => (
            <tr key={e.id}>
              <td>{e.name}</td>
              <td>{e.url}</td>
              <td>{e.topics.map(topicText).join('; ')}</td>
              <td>{sensitivityLabel(e.max_sensitivity)}</td>
              <td>
                <Badge tone={STATUS_TEXT[e.status].tone}>{STATUS_TEXT[e.status].text}</Badge>
                {e.consecutive_failures > 0 && <span className="muted"> ({e.consecutive_failures} failed in a row)</span>}
              </td>
              <td>{e.last_success_at === null ? 'Never' : formatDate(e.last_success_at)}</td>
              <td>…{e.secret_hint}</td>
              <td>
                <Button onClick={() => setOpen(open === e.id ? null : e.id)}>{open === e.id ? `Hide messages of ${e.name}` : `Messages of ${e.name}`}</Button>
                {can('updateWebhookEndpoint') && (
                  <Button busy={busy(update, e.id)} onClick={() => update.mutate({ path: { webhook_id: e.id }, body: { enabled: e.status !== 'active' } })}>
                    {e.status === 'active' ? `Switch off ${e.name}` : `Switch on ${e.name}`}
                  </Button>
                )}
                {can('sendWebhookTest') && e.status === 'active' && (
                  <Button busy={busy(test, e.id)} onClick={() => test.mutate({ path: { webhook_id: e.id } })}>{`Send a test message to ${e.name}`}</Button>
                )}
                {can('rotateWebhookSecret') && (
                  <ConfirmButton label={`New secret for ${e.name}`} confirmLabel="Yes, the old secret stops at once" variant="primary" resetKey={`r${e.id}`}
                    busy={busy(rotate, e.id)} onConfirm={() => rotate.mutate({ path: { webhook_id: e.id } }, {
                      onSuccess: (made) => {
                        onSecret(made);
                        rotate.reset();
                        refresh();
                      },
                    })} />
                )}
                {can('removeWebhookEndpoint') && (
                  <ConfirmButton label={`Remove ${e.name}`} confirmLabel="Yes, remove it for good" resetKey={e.id}
                    busy={busy(remove, e.id)} onConfirm={() => remove.mutate({ path: { webhook_id: e.id } })} />
                )}
              </td>
            </tr>
          ))}
        </DataTable>
      )}
      {open !== null && <Deliveries id={open} name={items.find((e) => e.id === open)?.name ?? ''} />}
    </div>
  );
}

function Deliveries({ id, name }: { id: string; name: string }) {
  const deliveries = useWebhookDeliveries(id);
  return (
    <Card title={`Messages to ${name}`}>
      {deliveries.isPending && <Loading what="messages" />}
      <ErrorNote error={deliveries.error} />
      {deliveries.data !== undefined && (deliveries.data.items.length === 0 ? <Empty>No message yet.</Empty> : (
        <DataTable caption={`Messages to ${name}`} columns={['Event', 'State', 'Attempts', 'Last attempt', 'Next attempt']}>
          {deliveries.data.items.map((d) => (
            <tr key={d.id}>
              <td>{d.topic}</td>
              <td>
                {DELIVERY_TEXT[d.status]}
                {d.last_error !== null && d.status !== 'delivered' && (
                  <span className="muted"> ({ERROR_TEXT[d.last_error]}{d.last_status_code !== null ? `, status ${d.last_status_code}` : ''})</span>
                )}
              </td>
              <td>{d.attempts}</td>
              <td>{d.last_attempt_at === null ? '-' : formatDate(d.last_attempt_at)}</td>
              <td>{d.next_attempt_at === null ? '-' : formatDate(d.next_attempt_at)}</td>
            </tr>
          ))}
        </DataTable>
      ))}
      {deliveries.data?.next_cursor != null && <p className="muted">Only the newest {DELIVERIES_SHOWN} messages are shown.</p>}
    </Card>
  );
}
