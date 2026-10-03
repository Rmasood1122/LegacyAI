// Home: what this card may do, and what is waiting for it. The cards come from the screen registry,
// so a screen added there appears here too.
import { useApiQuery } from '../../api/context.tsx';
import { mayOpen, ROUTES, type PlainScreenKey, type RouteDef } from '../../navigation/routes.ts';
import { ScreenLink } from '../../navigation/ScreenLink.tsx';
import { useSession } from '../../session/session.tsx';
import { Banner, Card, formatDate, humanize, Page } from '../../ui/index.tsx';

const HOME_CARDS = (Object.entries(ROUTES) as Array<[PlainScreenKey, RouteDef]>).filter(([, route]) => route.home !== undefined);

export function HomeScreen() {
  const { state, can } = useSession();
  const tasks = useApiQuery('listReviewTasks', { query: { status: 'open', limit: 50 } }, { enabled: can('listReviewTasks') });
  const questions = useApiQuery('listExpertQuestions', { query: { box: 'addressed', limit: 50 } }, { enabled: can('listExpertQuestions') });
  if (state.status !== 'signed_in') return null;
  const { session } = state;
  const openTasks = tasks.data?.items.length ?? 0;
  const waitingQuestions = questions.data?.items.filter((q) => q.status === 'open').length ?? 0;
  const cards = HOME_CARDS.filter(([, route]) => mayOpen(route, can));
  const reviewCount = tasks.isPending ? 'Counting…' : openTasks === 0 ? 'Nothing is waiting.' : `${openTasks}${tasks.data?.next_cursor ? '+' : ''} open ${openTasks === 1 ? 'task' : 'tasks'}.`;

  return (
    <Page title="Welcome" intro={`Signed in with card ${session.card_number_masked} (${session.roles.map(humanize).join(', ') || 'no role'}).`}>
      {new Date(session.renewal_due).getTime() < Date.now() && !session.read_only && (
        <Banner tone="warning" title="This card should be renewed soon">It is valid until {formatDate(session.expires_at)}.</Banner>
      )}
      {cards.length === 0 && <Banner tone="info" title="Nothing to do here yet">This card has no rights for knowledge work. Ask an administrator if that is not what you expected.</Banner>}
      <div className="grid">
        {cards.map(([key, route]) => (
          <Card key={key} title={route.home?.title}>
            <p>{key === 'review' ? reviewCount : route.home?.text}</p>
            <p><ScreenLink screen={key}>{route.home?.linkText}</ScreenLink></p>
          </Card>
        ))}
        {can('listExpertQuestions') && (waitingQuestions > 0 || Boolean(questions.data?.next_cursor)) && (
          <Card title="Questions for you">
            <p>{questions.data?.next_cursor ? `At least ${waitingQuestions}` : waitingQuestions} {waitingQuestions === 1 && !questions.data?.next_cursor ? 'colleague is' : 'colleagues are'} waiting for your answer.</p>
          </Card>
        )}
      </div>
    </Page>
  );
}
