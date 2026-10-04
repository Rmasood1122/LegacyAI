// Retirement radar: who leaves within two years, soonest first, and what the system holds from each.
import { ScreenLink } from '../../navigation/ScreenLink.tsx';
import { Badge, Banner, DataTable, Empty, ErrorNote, Loading, Page, PartialListNote } from '../../ui/index.tsx';
import { leavingStageText, leavingStageTone, monthsText, useRetirementRadar } from './hooks.ts';

/** Shown where the card may not read that kind of thing: not a zero, which would read as "nothing captured". */
const NOT_SHOWN = <span className="muted" title="You may not read this">–</span>;

export function RadarScreen() {
  const radar = useRetirementRadar();
  const items = radar.items ?? [];
  return (
    <Page title="Retirement radar"
      intro="People with a planned leaving date in the next 24 months. Use the time: invite them to an interview and check the gap report of their job roles."
      actions={<ScreenLink screen="people">People</ScreenLink>}>
      <Banner tone="info" title="What this list does and does not show">
        It counts the verified items each person contributed and the interviews they completed - among those you may read yourself;
        a dash means you may not read that kind of thing at all. It does not say which topics are still uncaptured: the gap report of a
        job role shows that. A leaving date is set on the People screen and is seen only by the people who manage
        people, and by the person.
      </Banner>
      {radar.isPending && <Loading what="the radar" />}
      <ErrorNote error={radar.error} />
      {radar.items !== undefined && (items.length === 0 ? <Empty>Nobody has a leaving date in the next 24 months.</Empty> : (
        <DataTable caption="People who leave within 24 months" columns={['Name', 'Leaves on', 'Time left', 'Job roles', 'Verified items', 'Interviews done']}>
          {items.map((p) => (
            <tr key={p.person_id}>
              <td>{p.display_name}</td>
              <td>{p.leaving_on}</td>
              <td><Badge tone={leavingStageTone(p.stage)}>{leavingStageText(p.stage)}</Badge> <span className="muted">{monthsText(p.months_left)}</span></td>
              <td>{p.job_roles === null ? NOT_SHOWN : p.job_roles.length === 0 ? <span className="muted">none recorded</span> : p.job_roles.join(', ')}</td>
              <td>{p.verified_items ?? NOT_SHOWN}</td>
              <td>{p.interviews_completed ?? NOT_SHOWN}</td>
            </tr>
          ))}
        </DataTable>
      ))}
      {radar.hasMore && <PartialListNote shown={items.length} noun="people" busy={radar.isLoadingMore} onLoadMore={radar.loadMore} />}
      <p><ScreenLink screen="gaps">Open the gap report of a job role</ScreenLink></p>
    </Page>
  );
}
