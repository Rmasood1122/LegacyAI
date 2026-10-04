// Answer quality (feature 22): what the answer log and the readers say, week by week.
// It reports what was recorded. It cannot know whether an answer was true, and it says so.
import { useState } from 'react';
import { ScreenLink } from '../../navigation/ScreenLink.tsx';
import { Badge, Banner, Card, CheckboxField, DataTable, Empty, ErrorNote, Facts, formatDate, humanize, Loading, Page, PartialListNote } from '../../ui/index.tsx';
import { share, totals, useAnswerFeedback, useQualitySummary, WEEKS_SHOWN } from './hooks.ts';

const VERDICT_TONE = { helpful: 'success', unhelpful: 'warning', wrong: 'danger' } as const;

export function QualityScreen() {
  const summary = useQualitySummary();
  const [wrongOnly, setWrongOnly] = useState(true);
  const feedback = useAnswerFeedback({ wrongOnly });
  const s = summary.data;
  const sum = s === undefined ? null : totals(s.weeks);

  return (
    <Page title="Answer quality" intro="Counts from the record of every question, and what readers said about the answers. These numbers show what happened; they cannot show whether an answer was true.">
      {summary.isPending && <Loading what="the numbers" />}
      <ErrorNote error={summary.error} />
      {s !== undefined && sum !== null && (
        <div>
          <Card title="Waiting for a reviewer">
            <Facts items={[
              ['Verified items that disagree with each other', s.waiting_for_review.item_conflicts],
              ['Items verified long ago', s.waiting_for_review.stale_items],
              ['Answers a reader marked wrong', s.waiting_for_review.answers_marked_wrong],
            ]} />
            <p><ScreenLink screen="conflicts">Open conflicts and old items</ScreenLink></p>
          </Card>
          <Card title={`The last ${WEEKS_SHOWN} weeks together`}>
            {sum.questions === 0 ? <Empty>No question was asked in this time.</Empty> : (
              <Facts items={[
                ['Questions answered', share(sum.answered, sum.questions)],
                ['Refused: “I don’t know”', share(sum.dont_know, sum.questions)],
                ['… because the sources disagree', `${sum.dont_know_sources_conflict} (found by comparing values: ${sum.conflicts_found_by_value_check}, reported by the AI model: ${sum.conflicts_found_by_ai_model})`],
                ['… because nothing relevant was found', sum.dont_know_no_relevant_sources],
                ['… because no exact quote backed the answer', sum.dont_know_not_grounded + sum.dont_know_low_confidence],
                ['Passages listed without a written answer', sum.search_only],
                ['Quotes removed because they were not in the source', sum.citations_removed],
                ['Answers that named a source that was not given', sum.answers_naming_an_unknown_source],
                ['Answers that used a source nobody has verified', share(sum.answers_containing_unverified_sources, sum.answered)],
                ['Readers said: helpful / not helpful / wrong', `${sum.feedback_helpful} / ${sum.feedback_unhelpful} / ${sum.feedback_wrong}`],
              ]} />
            )}
            <p className="muted">
            Answers and what readers said about them are kept for {s.kept_for_days} days, then deleted and no longer counted. The current week is
            not over yet, so its numbers are still growing; a week in which nothing was asked is left out.
          </p>
          </Card>
          <h2>Week by week</h2>
          {s.weeks.length === 0 ? <Empty>Nothing was recorded in this time.</Empty> : (
            <DataTable caption="Answer quality by week" columns={['Week starting', 'Questions', 'Answered', 'Refused', 'Sources disagreed', 'Quotes removed', 'Marked wrong']}>
              {s.weeks.map((w) => (
                <tr key={w.week_start}>
                  <td>{w.week_start}</td>
                  <td>{w.questions}</td>
                  <td>{w.answered}</td>
                  <td>{w.dont_know}</td>
                  <td>{w.dont_know_sources_conflict}</td>
                  <td>{w.citations_removed}</td>
                  <td>{w.feedback_wrong}</td>
                </tr>
              ))}
            </DataTable>
          )}
        </div>
      )}
      <h2>What readers said</h2>
      <p className="muted">
        Opinions from every department. The question an answer was for is shown only where its reader chose to share it.
      </p>
      <CheckboxField label="Only answers marked wrong" checked={wrongOnly} onChange={setWrongOnly} />
      {feedback.isPending && <Loading what="readers’ feedback" />}
      <ErrorNote error={feedback.error} />
      {feedback.items !== undefined && (feedback.items.length === 0 ? <Empty>No feedback of this kind yet.</Empty> : (
        <DataTable caption="Readers’ feedback" columns={['When', 'Verdict', 'The question', 'What happened', 'Comment']}>
          {feedback.items.map((f) => (
            <tr key={f.id}>
              <td>{formatDate(f.created_at)}</td>
              <td><Badge tone={VERDICT_TONE[f.verdict]}>{humanize(f.verdict)}</Badge></td>
              <td>{f.question ?? <span className="muted">Not shared by the reader</span>}</td>
              <td>{humanize(f.outcome)}{f.reason !== null ? ` (${humanize(f.reason)})` : ''}{f.contains_unverified_sources ? ' — used an unverified source' : ''}</td>
              <td>{f.comment ?? ''}</td>
            </tr>
          ))}
        </DataTable>
      ))}
      {feedback.hasMore && <PartialListNote shown={feedback.items?.length ?? 0} noun="entries" busy={feedback.isLoadingMore} onLoadMore={feedback.loadMore} />}
      <Banner tone="info" title="What this page cannot tell you">
        Whether an answer was correct. A refusal is counted the same whether it was right to refuse or not, and readers mark only the answers they choose to.
      </Banner>
    </Page>
  );
}
