// The small design system: presentational pieces only. No data access here (enforced by lint).
// Every control has a visible label and a visible keyboard focus (styles/base.css).
import { useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

export function Page({ title, intro, actions, children }: { title: string; intro?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="page" aria-labelledby="page-title">
      <header className="page-head">
        <div>
          <h1 id="page-title">{title}</h1>
          {intro !== undefined && <p className="muted">{intro}</p>}
        </div>
        {actions !== undefined && <div className="row">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="card">
      {title !== undefined && <h2>{title}</h2>}
      {children}
    </div>
  );
}

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> & { variant?: 'primary' | 'secondary' | 'danger'; busy?: boolean };
export function Button({ variant = 'secondary', busy = false, disabled, children, type = 'button', ...rest }: ButtonProps) {
  return (
    <button type={type} className={`button button-${variant}`} disabled={disabled === true || busy} aria-busy={busy} {...rest}>
      {children}
    </button>
  );
}

interface FieldBase {
  label: string;
  hint?: string;
  error?: string | null;
}
function FieldFrame({ id, label, hint, error, children }: FieldBase & { id: string; children: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {hint !== undefined && <p id={`${id}-hint`} className="hint">{hint}</p>}
      {children}
      {error !== undefined && error !== null && <p id={`${id}-error`} className="field-error" role="alert">{error}</p>}
    </div>
  );
}
const described = (id: string, hint?: string, error?: string | null): string | undefined => {
  const ids = [hint !== undefined ? `${id}-hint` : null, error ? `${id}-error` : null].filter((x): x is string => x !== null);
  return ids.length > 0 ? ids.join(' ') : undefined;
};

// The id (it ties the label to the control) and the class (the styling) belong to the component.
type Own<T> = Omit<T, 'id' | 'className'>;

export function TextField({ label, hint, error, ...rest }: FieldBase & Own<InputHTMLAttributes<HTMLInputElement>>) {
  const id = useId();
  return (
    <FieldFrame id={id} label={label} hint={hint} error={error}>
      <input id={id} className="input" aria-describedby={described(id, hint, error)} aria-invalid={error ? true : undefined} {...rest} />
    </FieldFrame>
  );
}

export function TextArea({ label, hint, error, ...rest }: FieldBase & Own<TextareaHTMLAttributes<HTMLTextAreaElement>>) {
  const id = useId();
  return (
    <FieldFrame id={id} label={label} hint={hint} error={error}>
      <textarea id={id} className="input" aria-describedby={described(id, hint, error)} aria-invalid={error ? true : undefined} {...rest} />
    </FieldFrame>
  );
}

export function SelectField({ label, hint, error, children, ...rest }: FieldBase & Own<SelectHTMLAttributes<HTMLSelectElement>>) {
  const id = useId();
  return (
    <FieldFrame id={id} label={label} hint={hint} error={error}>
      <select id={id} className="input" aria-describedby={described(id, hint, error)} {...rest}>{children}</select>
    </FieldFrame>
  );
}

export type Tone = 'info' | 'success' | 'warning' | 'danger';
export type BadgeTone = Tone | 'neutral';
/** A message. Problems are announced to screen readers at once; the rest politely. */
export function Banner({ tone = 'info', title, children }: { tone?: Tone; title?: string; children?: ReactNode }) {
  return (
    <div className={`banner banner-${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      {title !== undefined && <strong>{title}</strong>}
      {children !== undefined && <div>{children}</div>}
    </div>
  );
}

export function Badge({ tone = 'info', children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Loading({ what }: { what: string }) {
  return <p className="muted" role="status">Loading {what}…</p>;
}

/**
 * Says plainly that a list is cut short. With `onLoadMore` it offers the next part; without it
 * (the API gives no way to ask for more) it only says so.
 */
export function PartialListNote({ shown, noun, onLoadMore, busy = false }: { shown: number; noun: string; onLoadMore?: () => void; busy?: boolean }) {
  return (
    <div className="row" role="status">
      <span className="muted">Only the first {shown} {noun} are shown. There are more.</span>
      {onLoadMore !== undefined && <Button busy={busy} onClick={onLoadMore}>Show more {noun}</Button>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

/** Shows an API error in plain words, with the request id an operator can look up. */
export function ErrorNote({ error }: { error: { message: string; requestId?: string | null; fieldErrors?: ReadonlyArray<{ path: string; message: string }> } | null | undefined }) {
  if (error === null || error === undefined) return null;
  return (
    <Banner tone="danger" title={error.message}>
      {error.fieldErrors !== undefined && error.fieldErrors.length > 0 && (
        <ul>{error.fieldErrors.map((f) => <li key={`${f.path}:${f.message}`}>{f.path}: {f.message}</li>)}</ul>
      )}
      {error.requestId ? <p className="hint">Reference: {error.requestId}</p> : null}
    </Banner>
  );
}

export function DataTable({ caption, columns, children }: { caption: string; columns: string[]; children: ReactNode }) {
  return (
    <div className="table-wrap">
      <table>
        <caption className="visually-hidden">{caption}</caption>
        <thead><tr>{columns.map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

const DATE = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
export function formatDate(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : DATE.format(d);
}

export const SENSITIVITY_LABELS = ['Public inside the company', 'Internal', 'Restricted', 'Confidential'] as const;
export function sensitivityLabel(level: number): string {
  return SENSITIVITY_LABELS[level] ?? `Level ${level}`;
}

/** "in_review" -> "In review", "PERSON" -> "Person". */
export function humanize(code: string): string {
  const text = code.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return text === '' ? '—' : text.charAt(0).toUpperCase() + text.slice(1);
}
