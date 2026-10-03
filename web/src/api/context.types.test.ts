// The hooks must keep the argument rules of the contract. This is checked by the COMPILER
// (`npm run typecheck`): every line marked @ts-expect-error has to be an error, or tsc fails; every
// unmarked line has to compile. The function is never called.
import { expect, it } from 'vitest';
import { useApiList, useApiMutation, useApiQuery } from './context.tsx';

export function argumentRules(): void {
  // an operation with a path cannot be read without it
  // @ts-expect-error getSource needs { path: { source_id } }
  useApiQuery('getSource');
  // @ts-expect-error the path must carry the right name
  useApiQuery('getSource', { path: { item_id: 'x' } });
  useApiQuery('getSource', { path: { source_id: 'x' } });
  useApiQuery('getSource', { path: { source_id: 'x' } }, { enabled: false });
  // an operation that needs nothing can be read with nothing
  useApiQuery('listMyConsents');
  useApiQuery('listSources', { query: { limit: 10 } });

  // only a file upload takes a content type
  // @ts-expect-error getSource has no file body
  useApiQuery('getSource', { path: { source_id: 'x' }, contentType: 'text/plain' });

  // only lists that can be continued are paged lists
  // @ts-expect-error getSource is not a list
  useApiList('getSource');
  // @ts-expect-error listMyConsents accepts no cursor
  useApiList('listMyConsents');
  useApiList('listSources', { query: { limit: 10 } });

  // a change that needs a path cannot be made without it; one that needs nothing takes nothing
  const verify = useApiMutation('verifyKnowledgeItem');
  // @ts-expect-error verifyKnowledgeItem needs { path: { item_id } }
  verify.mutate();
  verify.mutate({ path: { item_id: 'x' } });
  const logout = useApiMutation('logout');
  logout.mutate();
}

it('the argument rules above are checked by the compiler, not at run time', () => {
  expect(typeof argumentRules).toBe('function');
});
