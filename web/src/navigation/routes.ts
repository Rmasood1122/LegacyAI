// Every screen's address, and the API operation a card must be allowed to use to see it.
// This is the ONE place an address is written down: the menu, the routes, the home page and every
// link between screens are built from it (screens.tsx adds the components).
import type { OperationId } from '../api/generated.ts';

export interface RouteDef {
  /** Address pattern; a detail screen has one ":name" part. */
  path: string;
  /** Shown in the menu. Screens without a label are reached from another screen. */
  label?: string;
  /** The card needs the permission of this operation; undefined = every signed-in card. */
  requiredOperation?: OperationId;
  /** The card shown on the home page for this screen. */
  home?: { title: string; text: string; linkText: string };
}

export const ROUTES = {
  home: { path: '/', label: 'Home' },
  ask: {
    path: '/ask', label: 'Ask', requiredOperation: 'askKnowledge',
    home: { title: 'Ask a question', text: 'Get an answer from your company’s documents and verified knowledge, with its sources.', linkText: 'Ask' },
  },
  review: {
    path: '/review', label: 'Review queue', requiredOperation: 'listReviewTasks',
    home: { title: 'Waiting for review', text: 'Tasks you are allowed to handle, most urgent first.', linkText: 'Open the review queue' },
  },
  documents: {
    path: '/documents', label: 'Documents', requiredOperation: 'listSources',
    home: { title: 'Documents', text: 'Add a document so its content can be found and cited.', linkText: 'Open documents' },
  },
  document: { path: '/documents/:sourceId', requiredOperation: 'getSource' },
  knowledge: {
    path: '/knowledge', label: 'Knowledge', requiredOperation: 'listKnowledgeItems',
    home: { title: 'Knowledge', text: 'Read, write and verify pieces of know-how.', linkText: 'Open knowledge' },
  },
  knowledgeItem: { path: '/knowledge/:itemId', requiredOperation: 'getKnowledgeItem' },
  consent: {
    path: '/consent', label: 'My consent', requiredOperation: 'listMyConsents',
    home: { title: 'My consent', text: 'See what you agreed to share, and withdraw it at any time.', linkText: 'Open my consent' },
  },
} as const satisfies Record<string, RouteDef>;

export type ScreenKey = keyof typeof ROUTES;
/** Screens that show one thing and so need its id. */
export type DetailScreenKey = 'document' | 'knowledgeItem';
export type PlainScreenKey = Exclude<ScreenKey, DetailScreenKey>;
/** A screen to go to: a plain one, or a detail screen together with the id of what it shows. */
export type ScreenTarget = { screen: PlainScreenKey } | { screen: DetailScreenKey; id: string };

export const routeOf = (screen: ScreenKey): RouteDef => ROUTES[screen];

/** The address of a screen. */
export function screenPath(target: ScreenTarget): string {
  const { path } = ROUTES[target.screen];
  return 'id' in target ? path.replace(/:[A-Za-z]+/, encodeURIComponent(target.id)) : path;
}
