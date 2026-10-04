// The list of screens: the addresses and permissions of navigation/routes.ts, each with the
// component that draws it. Adding a screen = one entry in routes.ts and one line here; the menu and
// the routes are built from this list.
import type { ComponentType } from 'react';
import { AuditScreen } from './features/admin/AuditScreen.tsx';
import { ConsentAdminScreen } from './features/admin/ConsentAdminScreen.tsx';
import { SettingsScreen } from './features/admin/SettingsScreen.tsx';
import { AskScreen } from './features/ask/AskScreen.tsx';
import { QuestionsScreen } from './features/ask/QuestionsScreen.tsx';
import { ConsentScreen } from './features/consent/ConsentScreen.tsx';
import { DocumentDetailScreen } from './features/documents/DocumentDetailScreen.tsx';
import { DocumentsScreen } from './features/documents/DocumentsScreen.tsx';
import { HomeScreen } from './features/home/HomeScreen.tsx';
import { InterviewScreen } from './features/interviews/InterviewScreen.tsx';
import { InterviewsScreen } from './features/interviews/InterviewsScreen.tsx';
import { KnowledgeItemScreen } from './features/knowledge/KnowledgeItemScreen.tsx';
import { KnowledgeScreen } from './features/knowledge/KnowledgeScreen.tsx';
import { OperatorScreen } from './features/operator/OperatorScreen.tsx';
import { CardScreen } from './features/people/CardScreen.tsx';
import { CardsScreen } from './features/people/CardsScreen.tsx';
import { PeopleScreen } from './features/people/PeopleScreen.tsx';
import { AttemptScreen } from './features/readiness/AttemptScreen.tsx';
import { QuestionBankScreen } from './features/readiness/QuestionBankScreen.tsx';
import { ReadinessScreen } from './features/readiness/ReadinessScreen.tsx';
import { ReportScreen } from './features/readiness/ReportScreen.tsx';
import { ConflictsScreen } from './features/quality/ConflictsScreen.tsx';
import { QualityScreen } from './features/quality/QualityScreen.tsx';
import { ReviewScreen } from './features/review/ReviewScreen.tsx';
import { GapsScreen } from './features/topics/GapsScreen.tsx';
import { TopicsScreen } from './features/topics/TopicsScreen.tsx';
import { routeOf, type RouteDef, type ScreenKey } from './navigation/routes.ts';

export interface ScreenDef extends RouteDef {
  key: ScreenKey;
  component: ComponentType;
}

/** One component per screen in the registry; the compiler refuses a screen without one. The order is the order of the menus. */
const COMPONENTS: Readonly<Record<ScreenKey, ComponentType>> = {
  home: HomeScreen,
  ask: AskScreen,
  expertQuestions: QuestionsScreen,
  documents: DocumentsScreen,
  document: DocumentDetailScreen,
  knowledge: KnowledgeScreen,
  knowledgeItem: KnowledgeItemScreen,
  review: ReviewScreen,
  conflicts: ConflictsScreen,
  interviews: InterviewsScreen,
  interview: InterviewScreen,
  readiness: ReadinessScreen,
  attempt: AttemptScreen,
  report: ReportScreen,
  consent: ConsentScreen,
  topics: TopicsScreen,
  gaps: GapsScreen,
  questionBank: QuestionBankScreen,
  people: PeopleScreen,
  cards: CardsScreen,
  card: CardScreen,
  consentAdmin: ConsentAdminScreen,
  quality: QualityScreen,
  settings: SettingsScreen,
  audit: AuditScreen,
  operator: OperatorScreen,
};

export const SCREENS: readonly ScreenDef[] = (Object.keys(COMPONENTS) as ScreenKey[]).map((key) => ({ key, ...routeOf(key), component: COMPONENTS[key] }));
