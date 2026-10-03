// The list of screens: the addresses and permissions of navigation/routes.ts, each with the
// component that draws it. Adding a screen = one entry in routes.ts and one line here; the menu and
// the routes are built from this list.
import type { ComponentType } from 'react';
import { AskScreen } from './features/ask/AskScreen.tsx';
import { ConsentScreen } from './features/consent/ConsentScreen.tsx';
import { DocumentDetailScreen } from './features/documents/DocumentDetailScreen.tsx';
import { DocumentsScreen } from './features/documents/DocumentsScreen.tsx';
import { HomeScreen } from './features/home/HomeScreen.tsx';
import { KnowledgeItemScreen } from './features/knowledge/KnowledgeItemScreen.tsx';
import { KnowledgeScreen } from './features/knowledge/KnowledgeScreen.tsx';
import { ReviewScreen } from './features/review/ReviewScreen.tsx';
import { routeOf, type RouteDef, type ScreenKey } from './navigation/routes.ts';

export interface ScreenDef extends RouteDef {
  key: ScreenKey;
  component: ComponentType;
}

/** One component per screen in the registry; the compiler refuses a screen without one. */
const COMPONENTS: Readonly<Record<ScreenKey, ComponentType>> = {
  home: HomeScreen,
  ask: AskScreen,
  documents: DocumentsScreen,
  document: DocumentDetailScreen,
  knowledge: KnowledgeScreen,
  knowledgeItem: KnowledgeItemScreen,
  review: ReviewScreen,
  consent: ConsentScreen,
};

export const SCREENS: readonly ScreenDef[] = (Object.keys(COMPONENTS) as ScreenKey[]).map((key) => ({ key, ...routeOf(key), component: COMPONENTS[key] }));
