// What a readiness test and a scenario run share while answers are typed and graded. Features may not import each
// other, so the shared parts live here: which answers are not saved yet (handing in cannot be undone, so it waits),
// and the control with which a reviewer sets a score. No data access: the callers save and override.
import { useCallback, useState } from 'react';
import { ConfirmButton } from './index.tsx';

export interface UnsavedPositions {
  /** Places (question or step numbers) whose answer is typed but not saved, in order. Empty = handing in is safe. */
  waitingFor: number[];
  /** Each answer field reports, from one effect, whether it holds unsaved input. */
  markUnsaved(position: number, dirty: boolean): void;
}

/** One record of which answers are not saved yet, kept by the screen and written by each answer field. */
export function useUnsavedPositions(): UnsavedPositions {
  const [unsaved, setUnsaved] = useState<ReadonlySet<number>>(new Set());
  const markUnsaved = useCallback((position: number, dirty: boolean): void => {
    setUnsaved((before) => {
      if (before.has(position) === dirty) return before;
      const next = new Set(before);
      if (dirty) next.add(position); else next.delete(position);
      return next;
    });
  }, []);
  return { waitingFor: [...unsaved].sort((a, b) => a - b), markUnsaved };
}

/**
 * A reviewer sets the final score of one answer. It starts with nothing chosen and asks a second time; choosing a
 * different score after the first click asks again.
 */
export function ScoreOverride({ busy, changed, onSet }: { busy: boolean; changed: boolean; onSet: (score: number, done: () => void) => void }) {
  const [score, setScore] = useState('');
  return (
    <div className="row">
      <label>New score <select className="input" value={score} onChange={(e) => setScore(e.target.value)}>
        <option value="">Choose a score…</option>
        <option value="1">Right (100 %)</option>
        <option value="0.5">Half right (50 %)</option>
        <option value="0">Wrong (0 %)</option>
      </select></label>
      <ConfirmButton variant="primary" label="Set the score" confirmLabel="Yes, change the score" busy={busy} disabled={score === ''} resetKey={score}
        onConfirm={() => onSet(Number(score), () => setScore(''))} />
      {changed && <span className="muted" role="status">Score changed.</span>}
    </div>
  );
}
