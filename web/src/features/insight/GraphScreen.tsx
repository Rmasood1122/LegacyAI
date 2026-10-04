// The knowledge map (feature 30) as lists you can walk: a topic, an item, a document or a job role, and what it
// is linked to. Only links that already exist are shown; nothing is guessed, and people are not part of it.
import { useParams } from 'react-router';
import { ScreenLink } from '../../navigation/ScreenLink.tsx';
import { useSession } from '../../session/session.tsx';
import { Badge, Banner, Button, Card, Empty, ErrorNote, humanize, Loading, Page } from '../../ui/index.tsx';
import { saveAsFile } from '../../ui/files.ts';
import { GROUP_TEXT, KIND_TEXT, nodeKey, parseNodeKey, useGraphExport, useNeighbourhood, useStartItems, useStartTopics, type NodeKind } from './hooks.ts';

const NodeLink = ({ kind, id, label }: { kind: NodeKind; id: string; label: string }) => (
  <ScreenLink screen="graphNode" id={nodeKey(kind, id)}>{label || 'Untitled'}</ScreenLink>
);

export function GraphStartScreen() {
  const { can } = useSession();
  const topics = useStartTopics({ enabled: can('listTopics') });
  const items = useStartItems({ enabled: can('listKnowledgeItems') });
  const whole = useGraphExport();

  const save = (): void => whole.mutate(undefined as never, {
    onSuccess: (graph) => saveAsFile('legacyai-knowledge-graph.json', 'application/json', JSON.stringify(graph, null, 2)),
  });

  return (
    <Page title="Knowledge map" intro="How topics, knowledge items, documents and job roles are linked. Pick one to see what it is linked to. Only links that already exist are shown; nothing is guessed.">
      <Card title="Start from a topic">
        {!can('listTopics') && <p className="muted">This card may not list topics. Start from an item instead.</p>}
        {topics.isPending && can('listTopics') && <Loading what="topics" />}
        <ErrorNote error={topics.error} />
        {topics.data !== undefined && (topics.data.items.length === 0 ? <Empty>No topics yet.</Empty> : (
          <ul className="plain-list">
            {topics.data.items.map((t) => <li key={t.id}><NodeLink kind="topic" id={t.id} label={t.name} /></li>)}
          </ul>
        ))}
        {topics.data?.next_cursor != null && <p className="muted">Only the first {topics.data.items.length} topics are listed here.</p>}
      </Card>
      <Card title="Start from a knowledge item">
        {items.isPending && can('listKnowledgeItems') && <Loading what="items" />}
        <ErrorNote error={items.error} />
        {items.data !== undefined && (items.data.items.length === 0 ? <Empty>No items yet.</Empty> : (
          <ul className="plain-list">
            {items.data.items.map((i) => <li key={i.id}><NodeLink kind="item" id={i.id} label={i.title} /></li>)}
          </ul>
        ))}
        {items.data?.next_cursor != null && <p className="muted">Only the first {items.data.items.length} items are listed here.</p>}
      </Card>
      {can('exportKnowledgeGraph') && (
        <Card title="Take the whole map with you">
          <p>
            Everything this card may read, as one file in an open, documented format (JSON: nodes and links). This is an export: it is written to
            the audit log, and it can be done a few times an hour.
          </p>
          <ErrorNote error={whole.error} />
          {whole.data?.truncated === true && (
            <Banner tone="warning">
              The map is larger than one file may hold (at most {whole.data.limits.nodes_per_kind} of each kind and {whole.data.limits.edges} links);
              the file is cut short and says so.
            </Banner>
          )}
          <Button busy={whole.isPending} onClick={save}>Save the map as a file</Button>
        </Card>
      )}
    </Page>
  );
}

export function GraphNodeScreen() {
  const { node = '' } = useParams();
  const parsed = parseNodeKey(node);
  if (parsed === null) {
    return (
      <Page title="Knowledge map" actions={<ScreenLink screen="graph">Back to the start</ScreenLink>}>
        <Banner tone="warning" title="This address does not name anything on the map" />
      </Page>
    );
  }
  return <Neighbourhood key={node} kind={parsed.kind} id={parsed.id} />;
}

function Neighbourhood({ kind, id }: { kind: NodeKind; id: string }) {
  const around = useNeighbourhood(kind, id);
  const data = around.data;
  return (
    <Page title="Knowledge map" actions={<ScreenLink screen="graph">Back to the start</ScreenLink>}>
      {around.isPending && <Loading what="the links" />}
      {around.error?.status === 404
        ? <Banner tone="warning" title="Not found">It does not exist, or this card may not read it.</Banner>
        : <ErrorNote error={around.error} />}
      {data !== undefined && (
        <div>
          <Card>
            <p className="muted">{KIND_TEXT[data.node.kind]}</p>
            <h2>{data.node.label || 'Untitled'} {data.node.status !== null && <Badge tone="neutral">{humanize(data.node.status)}</Badge>}</h2>
            {data.node.kind === 'item' && <p><ScreenLink screen="knowledgeItem" id={data.node.id}>Open this item</ScreenLink></p>}
            {data.node.kind === 'source' && <p><ScreenLink screen="document" id={data.node.id}>Open this document</ScreenLink></p>}
          </Card>
          {data.neighbours.map((g) => (
            <Card key={g.group} title={GROUP_TEXT[g.group]}>
              {g.nodes.length === 0 ? <Empty>None that this card may read.</Empty> : (
                <ul className="plain-list">
                  {g.nodes.map(({ node: n, origin }) => (
                    <li key={nodeKey(n.kind, n.id)}>
                      <NodeLink kind={n.kind} id={n.id} label={n.label} />
                      {n.status !== null && <> <Badge tone="neutral">{humanize(n.status)}</Badge></>}
                      {origin === 'similarity' && <span className="muted"> (linked automatically)</span>}
                    </li>
                  ))}
                </ul>
              )}
              {g.truncated && <p className="muted">Only the first {data.limit_per_group} are listed; there are more, which this screen cannot show.</p>}
            </Card>
          ))}
          <p className="muted">
            Only what this card may read is listed; something hidden from this card looks the same as something that does not exist. Links come from
            what was recorded: topics set on an item, the passages an item quotes, the topics of a job role, and conflicts found between verified items.
          </p>
        </div>
      )}
    </Page>
  );
}
