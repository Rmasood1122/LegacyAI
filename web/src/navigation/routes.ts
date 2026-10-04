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
  /**
   * Further operations the card must ALSO be allowed to use (all of them). The session lists permissions without
   * their scope, so a management screen names a managing operation too: reading alone may be an "own records" right.
   */
  alsoRequires?: readonly OperationId[];
  /** The card shown on the home page for this screen. */
  home?: { title: string; text: string; linkText: string };
  /** 'manage' = listed in the second menu (running the company), not among the everyday screens. */
  menu?: 'manage';
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
  // Review tasks of two kinds only (items that disagree, items verified long ago): the same right as the review queue.
  conflicts: { path: '/conflicts', label: 'Conflicts and old items', requiredOperation: 'listReviewTasks' },
  knowledge: {
    path: '/knowledge', label: 'Knowledge', requiredOperation: 'listKnowledgeItems',
    home: { title: 'Knowledge', text: 'Read, write and verify pieces of know-how.', linkText: 'Open knowledge' },
  },
  knowledgeItem: { path: '/knowledge/:itemId', requiredOperation: 'getKnowledgeItem' },
  consent: {
    path: '/consent', label: 'My consent', requiredOperation: 'listMyConsents',
    home: { title: 'My consent', text: 'See what you agreed to share, and withdraw it at any time.', linkText: 'Open my consent' },
  },
  expertQuestions: {
    path: '/questions', label: 'Questions', requiredOperation: 'listExpertQuestions',
    home: { title: 'Questions between colleagues', text: 'Questions sent to you as an expert, and the ones you asked.', linkText: 'Open questions' },
  },
  interviews: {
    path: '/interviews', label: 'Interviews', requiredOperation: 'listInterviews',
    home: { title: 'Interviews', text: 'Answer a few questions about your work, at your own pace.', linkText: 'Open interviews' },
  },
  interview: { path: '/interviews/:interviewId', requiredOperation: 'getInterview' },
  readiness: {
    path: '/readiness', label: 'Readiness test', requiredOperation: 'startReadinessAttempt',
    home: { title: 'Readiness test', text: 'Check what you have learned for a job role.', linkText: 'Take a test' },
  },
  attempt: { path: '/readiness/attempts/:attemptId', requiredOperation: 'getReadinessAttempt' },
  report: { path: '/readiness/reports/:attemptId', requiredOperation: 'getReadinessReport' },
  // Scenario replay: a learner sees what is offered to it and its runs; the people who write and approve scenarios
  // have their own list (the right to read the question bank, which learners do not hold).
  scenarios: {
    path: '/scenarios', label: 'Scenarios', requiredOperation: 'listOfferedScenarios',
    home: { title: 'Scenarios', text: 'Work through a situation step by step, in your own words.', linkText: 'Open scenarios' },
  },
  scenarioRun: { path: '/scenarios/runs/:attemptId', requiredOperation: 'getScenarioAttempt' },
  // one step, for the person who grades it (reached from the review task about that step)
  scenarioGrade: { path: '/scenarios/grade/:answerId', requiredOperation: 'getScenarioAnswer' },
  questionBank: { path: '/readiness/questions', label: 'Test questions', requiredOperation: 'listQuizQuestions', menu: 'manage' },
  scenarioBank: { path: '/scenario-writing', label: 'Scenario writing', requiredOperation: 'listScenarios', menu: 'manage' },
  scenarioEdit: { path: '/scenario-writing/:scenarioId', requiredOperation: 'getScenario' },
  topics: { path: '/topics', label: 'Topics', requiredOperation: 'listTopics', alsoRequires: ['createTopic'], menu: 'manage' },
  gaps: { path: '/gaps', label: 'Job roles and gaps', requiredOperation: 'getGapReport', menu: 'manage' },
  people: { path: '/people', label: 'People', requiredOperation: 'listPeople', alsoRequires: ['createPerson'], menu: 'manage' },
  // Every card may read its OWN radar entry from the API; the screen is for the people who manage people.
  radar: { path: '/retirement-radar', label: 'Retirement radar', requiredOperation: 'getRetirementRadar', alsoRequires: ['setLeavingDate'], menu: 'manage' },
  cards: { path: '/cards', label: 'Cards', requiredOperation: 'listCards', alsoRequires: ['issueCard'], menu: 'manage' },
  card: { path: '/cards/:cardId', requiredOperation: 'getCard' },
  // Experts and Successors hold the consent-reading right for their OWN records (and may read their own person), so
  // neither listConsents nor listPeople tells them apart from the roles that look after the company's consents. The
  // session lists permissions without their scope. The right to read the company's settings is held only by the
  // administering roles (Owner, Admin, Auditor), so it is used as the second condition. The API remains the authority:
  // a card with an own-scope grant gets only its own records from it.
  consentAdmin: { path: '/consents', label: 'Consents', requiredOperation: 'listConsents', alsoRequires: ['getTenantSettings'], menu: 'manage' },
  quality: { path: '/quality', label: 'Answer quality', requiredOperation: 'getQualitySummary', menu: 'manage' },
  activity: { path: '/activity', label: 'Activity', requiredOperation: 'getActivity', menu: 'manage' },
  // The knowledge map: what is linked to what. A node's address holds its kind and id in one part ("topic~<id>").
  graph: { path: '/graph', label: 'Knowledge map', requiredOperation: 'getGraphNeighbourhood' },
  graphNode: { path: '/graph/:node', requiredOperation: 'getGraphNeighbourhood' },
  settings: { path: '/settings', label: 'Settings', requiredOperation: 'getTenantSettings', menu: 'manage' },
  audit: { path: '/audit', label: 'Audit log', requiredOperation: 'listAuditEvents', menu: 'manage' },
  operator: { path: '/operator', label: 'Operator console', requiredOperation: 'listTenants', menu: 'manage' },
} as const satisfies Record<string, RouteDef>;

export type ScreenKey = keyof typeof ROUTES;
/** Screens that show one thing and so need its id. */
export type DetailScreenKey = 'document' | 'knowledgeItem' | 'interview' | 'attempt' | 'report' | 'card' | 'graphNode' | 'scenarioRun' | 'scenarioGrade' | 'scenarioEdit';
export type PlainScreenKey = Exclude<ScreenKey, DetailScreenKey>;
/** A screen to go to: a plain one, or a detail screen together with the id of what it shows. */
export type ScreenTarget = { screen: PlainScreenKey } | { screen: DetailScreenKey; id: string };

/** The kinds of node of the knowledge map (the API's KGraphNodeKind). */
export const GRAPH_NODE_KINDS = ['topic', 'item', 'source', 'job_role'] as const;
export type GraphNodeKind = (typeof GRAPH_NODE_KINDS)[number];
const NODE_KEY_SEPARATOR = '~';

/** A node of the knowledge map in an address: its kind and its own id (for a job role, its name) in one path part. */
export const graphNodeKey = (kind: GraphNodeKind, id: string): string => `${kind}${NODE_KEY_SEPARATOR}${id}`;

/** The reverse of graphNodeKey, or null for anything it could not have made. The two are kept side by side on purpose. */
export function parseGraphNodeKey(key: string): { kind: GraphNodeKind; id: string } | null {
  const at = key.indexOf(NODE_KEY_SEPARATOR);
  if (at <= 0) return null;
  const kind = key.slice(0, at);
  const id = key.slice(at + 1);
  return (GRAPH_NODE_KINDS as readonly string[]).includes(kind) && id !== '' && id.length <= 120 ? { kind: kind as GraphNodeKind, id } : null;
}

export const routeOf = (screen: ScreenKey): RouteDef => ROUTES[screen];

/** Whether a card may open a screen: it needs every operation the screen names. The API stays the authority. */
export function mayOpen(route: RouteDef, can: (operation: OperationId) => boolean): boolean {
  return (route.requiredOperation === undefined || can(route.requiredOperation)) && (route.alsoRequires ?? []).every(can);
}

/** The address of a screen. */
export function screenPath(target: ScreenTarget): string {
  const { path } = ROUTES[target.screen];
  return 'id' in target ? path.replace(/:[A-Za-z]+/, encodeURIComponent(target.id)) : path;
}
