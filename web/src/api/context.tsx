// Hands the API client to the screens' data hooks, and gives them a few small helpers so every
// feature reads and changes data the same way. Features use ONLY these helpers (lint enforces it):
// the cache library and the cache keys stay private to this file.
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query';
import { createContext, useCallback, useContext, type ReactNode } from 'react';
import type { Api, ApiError, CallArgs, ResponseOf } from './client.ts';
import type { OperationId, OperationTypes } from './generated.ts';

const ApiContext = createContext<Api | null>(null);

export function ApiProvider({ api, children }: { api: Api; children: ReactNode }) {
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

/** The client itself. For the session and for this file; features use the hooks below. */
export function useApi(): Api {
  const api = useContext(ApiContext);
  if (api === null) throw new Error('useApi must be used inside <ApiProvider>');
  return api;
}

export interface QueryOptions {
  /** false = do not ask (for example: the card may not use the operation). */
  enabled?: boolean;
}
/** Arguments are required exactly where the operation needs a path or a body, as with `Api.call`. */
type QueryParams<K extends OperationId> = Record<string, never> extends CallArgs<K>
  ? [args?: CallArgs<K>, options?: QueryOptions] : [args: CallArgs<K>, options?: QueryOptions];
/** What a mutation is called with: nothing at all when the operation needs nothing ("void" is what lets `mutate()` take no argument). */
// eslint-disable-next-line @typescript-eslint/no-invalid-void-type
export type MutationArgs<K extends OperationId> = Record<string, never> extends CallArgs<K> ? CallArgs<K> | void : CallArgs<K>;

const callWith = <K extends OperationId>(api: Api, operation: K, args: MutationArgs<K> | undefined): Promise<ResponseOf<K>> =>
  (api.call as (op: K, a?: CallArgs<K>) => Promise<ResponseOf<K>>)(operation, (args ?? undefined) as CallArgs<K> | undefined);

/** Reads one operation. The cache key is the operation name plus its arguments. */
export function useApiQuery<K extends OperationId>(operation: K, ...params: QueryParams<K>): UseQueryResult<ResponseOf<K>, ApiError> {
  const api = useApi();
  const [args, options] = params;
  return useQuery<ResponseOf<K>, ApiError>({
    queryKey: [operation, args ?? null],
    queryFn: () => callWith(api, operation, args),
    enabled: options?.enabled ?? true,
  });
}

/** Re-reads the listed operations (whatever their arguments), so screens show the new state. */
export function useRefresh(): (operations: readonly OperationId[]) => Promise<void> {
  const cache = useQueryClient();
  return useCallback(async (operations) => {
    await Promise.all(operations.map((name) => cache.invalidateQueries({ queryKey: [name] })));
  }, [cache]);
}

/** Changes something, then re-reads the listed operations so the screen shows the new state. */
export function useApiMutation<K extends OperationId>(
  operation: K, refresh: readonly OperationId[] = [],
): UseMutationResult<ResponseOf<K>, ApiError, MutationArgs<K>> {
  const api = useApi();
  const refreshNow = useRefresh();
  return useMutation<ResponseOf<K>, ApiError, MutationArgs<K>>({
    mutationFn: (args) => callWith(api, operation, args),
    onSuccess: () => refreshNow(refresh),
  });
}

interface PageOf<T> { items: T[]; next_cursor: string | null }
/** Operations that return a list one page at a time and accept a cursor for the next page. */
export type PagedOperationId = {
  [K in OperationId]: ResponseOf<K> extends PageOf<unknown>
    ? ([OperationTypes[K]['query']] extends [undefined] ? never : 'cursor' extends keyof NonNullable<OperationTypes[K]['query']> ? K : never)
    : never
}[OperationId];
type ItemOf<K extends OperationId> = ResponseOf<K> extends PageOf<infer T> ? T : never;

/** A list that is honest about being partial: `hasMore` says the API holds more than is loaded. */
export interface ApiList<T> {
  /** undefined until the first page has arrived. */
  items: T[] | undefined;
  isPending: boolean;
  error: ApiError | null;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore(): void;
}

/** Reads a paged list: the first page at once, further pages when `loadMore` is called. */
export function useApiList<K extends PagedOperationId>(operation: K, args?: CallArgs<K>, options: QueryOptions = {}): ApiList<ItemOf<K>> {
  const api = useApi();
  const result = useInfiniteQuery<PageOf<ItemOf<K>>, ApiError>({
    queryKey: [operation, args ?? null, 'pages'],
    initialPageParam: null,
    queryFn: ({ pageParam }) => {
      const query = { ...(args as { query?: Record<string, unknown> } | undefined)?.query, ...(typeof pageParam === 'string' ? { cursor: pageParam } : {}) };
      return callWith(api, operation, { ...args, query } as unknown as CallArgs<K>) as Promise<PageOf<ItemOf<K>>>;
    },
    getNextPageParam: (last) => last.next_cursor,
    enabled: options.enabled ?? true,
  });
  return {
    items: result.data?.pages.flatMap((p) => p.items),
    isPending: result.isPending,
    error: result.error,
    hasMore: result.hasNextPage,
    isLoadingMore: result.isFetchingNextPage,
    loadMore: () => void result.fetchNextPage(),
  };
}
