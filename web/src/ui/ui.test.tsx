// The two pieces of the design system that guard irreversible steps and one-time secrets.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmButton, OneTimeSecrets } from './index.tsx';

function Revoke({ onRevoke }: { onRevoke: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  return (
    <>
      <label>Reason <input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      <ConfirmButton label="Revoke" confirmLabel="Yes, revoke" disabled={reason.trim() === ''} resetKey={reason} onConfirm={() => onRevoke(reason)} />
    </>
  );
}

describe('ConfirmButton', () => {
  it('does nothing on the first click; the second, differently worded button does it', async () => {
    const user = userEvent.setup();
    const done = vi.fn();
    render(<ConfirmButton label="Delete" confirmLabel="Yes, delete" onConfirm={done} />);
    await user.click(screen.getByRole('button', { name: 'Delete…' }));
    expect(done).not.toHaveBeenCalled();
    // Cancel comes first, so a double click on the first button cannot land on the action
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Cancel', 'Yes, delete']);
    await user.click(screen.getByRole('button', { name: 'Yes, delete' }));
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('withdraws the question when the inputs change or the action becomes impossible', async () => {
    const user = userEvent.setup();
    const revoke = vi.fn();
    render(<Revoke onRevoke={revoke} />);
    const reason = screen.getByLabelText('Reason');
    await user.type(reason, 'lost');
    await user.click(screen.getByRole('button', { name: 'Revoke…' }));
    expect(screen.getByRole('button', { name: 'Yes, revoke' })).toBeTruthy();
    await user.clear(reason);                                                        // armed, then the reason is emptied
    expect(screen.queryByRole('button', { name: 'Yes, revoke' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Revoke…' }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(reason, 'stolen');                                               // typing again does not re-arm by itself
    expect(screen.queryByRole('button', { name: 'Yes, revoke' })).toBeNull();
    expect(revoke).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Revoke…' }));
    await user.click(screen.getByRole('button', { name: 'Yes, revoke' }));
    expect(revoke).toHaveBeenCalledWith('stolen');
  });
});

describe('OneTimeSecrets', () => {
  it('shows new secrets with the warning that they are shown once', () => {
    render(<OneTimeSecrets title="The new card" cardNumber="LGY-0000-0000-0000-0000" sc="123" enrollmentToken="synthetic-token" onDone={() => undefined} />);
    expect(screen.getByText('These are shown only once.')).toBeTruthy();
    expect(screen.getByTestId('secret-sc').textContent).toBe('123');
    expect(screen.getByRole('button', { name: 'I have written these down' })).toBeTruthy();
  });

  it('says so plainly when the API answered a repeated request and did not repeat the secrets', () => {
    render(<OneTimeSecrets title="The new card" cardNumber="LGY-0000-0000-0000-0000" alreadyShown onDone={() => undefined} />);
    expect(screen.getByText(/already carried out, and its secrets were shown then/)).toBeTruthy();
    expect(screen.queryByText('These are shown only once.')).toBeNull();
    expect(screen.queryByText(/No new secret was issued/)).toBeNull();
  });
});
