// The offline pack kept on this device, for the screens.
import { useCallback, useEffect, useState } from 'react';
import { useOfflineStore } from '../../offline/context.tsx';
import type { Opened } from '../../offline/store.ts';
import type { SessionState } from '../../session/session.tsx';

/** The kept pack, opened (or why not); undefined while it is being read. `failed` = the browser's storage failed. */
export function useOpenedPack(): { opened: Opened | undefined; failed: boolean; reload: () => void } {
  const store = useOfflineStore();
  const [opened, setOpened] = useState<Opened | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [round, setRound] = useState(0);
  useEffect(() => {
    let current = true;
    store.open().then(
      (o) => {
        if (current) {
          setOpened(o);
          setFailed(false);
        }
      },
      () => {
        if (current) {
          setOpened({ state: 'none' });
          setFailed(true);
        }
      },
    );
    return () => {
      current = false;
    };
  }, [store, round]);
  const reload = useCallback(() => setRound((r) => r + 1), []);
  return { opened, failed, reload };
}

/**
 * A pack belongs to the card that took it. Whenever the API answers, the pack is removed if nobody is signed in or
 * another card is; it stays only while the API cannot be reached (that is what it is for) or the same card is signed in.
 */
export function useOfflineGuard(state: SessionState): void {
  const store = useOfflineStore();
  const cardId = state.status === 'signed_in' ? state.session.card_id : null;
  const answered = state.status === 'signed_in' || state.status === 'signed_out';
  useEffect(() => {
    if (answered) store.keepOnlyFor(cardId).catch(() => undefined);
  }, [store, answered, cardId]);
}
