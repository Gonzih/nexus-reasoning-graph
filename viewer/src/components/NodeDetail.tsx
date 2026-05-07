import { useMemo } from 'react';

const TYPE_LABEL: Record<string, string> = {
  intent:          'Intent',
  web_search:      'Web Search',
  web_fetch:       'Web Fetch',
  file_read:       'File Read',
  bash:            'Bash',
  agent:           'Sub-agent',
  synthesis:       'Synthesis',
  compression_cut: 'Compression Cut',
};

const TYPE_COLOR: Record<string, string> = {
  intent:          '#FFD700',
  web_search:      '#4A90D9',
  web_fetch:       '#20B2AA',
  file_read:       '#3CB371',
  bash:            '#FF8C00',
  agent:           '#9370DB',
  synthesis:       '#FFFFFF',
  compression_cut: '#FF4444',
};

interface NodeDetailProps {
  node: any;
  graphData: any;
  onClose: () => void;
}

export default function NodeDetail({ node, graphData, onClose }: NodeDetailProps) {
  // Compute top influences targeting this node
  const influences = useMemo(() => {
    if (!graphData || !node) return [];
    const { edges, chunks, nodes } = graphData;
    if (!edges || !chunks || !nodes) return [];

    const c2n: Record<string, string> = {};
    chunks.forEach((c: any) => { c2n[c.id] = c.node_id; });

    const nodeById: Record<string, any> = {};
    nodes.forEach((n: any) => { nodeById[n.id] = n; });

    return edges
      .filter((e: any) => e.target_node_id === node.id)
      .map((e: any) => {
        const srcNodeId = c2n[e.source_chunk_id];
        const srcNode = nodeById[srcNodeId];
        return {
          source_chunk_id: e.source_chunk_id,
          source_node: srcNode,
          weight: e.weight,
        };
      })
      .filter((i: any) => i.source_node)
      .sort((a: any, b: any) => b.weight - a.weight)
      .slice(0, 10);
  }, [node, graphData]);

  if (!node) return null;

  const color = TYPE_COLOR[node.type] || '#8b949e';
  const label = TYPE_LABEL[node.type] || node.type;

  return (
    <aside className="detail-panel">
      <div className="panel-header">
        <h3 style={{ color }}>
          {label}
          {node.tool_name && node.tool_name !== node.type
            ? ` · ${node.tool_name}`
            : ''}
        </h3>
        <button className="close-btn" onClick={onClose} aria-label="Close">×</button>
      </div>

      <div className="detail-body">
        <div className="detail-field">
          <label>Sequence</label>
          <div className="value">#{node.sequence}</div>
        </div>

        <div className="detail-field">
          <label>Timestamp</label>
          <div className="value">{node.timestamp ? new Date(node.timestamp).toLocaleString() : '—'}</div>
        </div>

        <div className="detail-field">
          <label>Session ID</label>
          <div className="value" style={{ fontFamily: 'monospace', fontSize: 10 }}>{node.session_id}</div>
        </div>

        <div className="detail-field">
          <label>Chunks</label>
          <div className="value">{node.chunk_count ?? '—'}</div>
        </div>

        <div className="detail-field">
          <label>Content Preview</label>
          <div className="value">{node.content_preview || '(empty)'}</div>
        </div>

        {influences.length > 0 && (
          <div className="detail-field">
            <label>Top Influences ({influences.length})</label>
            <div className="influence-list" style={{ marginTop: 4 }}>
              {influences.map((inf: any, i: number) => (
                <div className="influence-item" key={i}>
                  <span style={{ minWidth: 90, color: TYPE_COLOR[inf.source_node.type] || '#8b949e', fontSize: 10 }}>
                    #{inf.source_node.sequence} {TYPE_LABEL[inf.source_node.type] || inf.source_node.type}
                  </span>
                  <div className="influence-bar-wrap">
                    <div
                      className="influence-bar"
                      style={{ width: `${Math.round(inf.weight * 100)}%` }}
                    />
                  </div>
                  <span className="influence-weight">{inf.weight.toFixed(3)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {node.type !== 'synthesis' && influences.length === 0 && (
          <div style={{ color: '#8b949e', fontSize: 11, marginTop: 4 }}>
            No influence edges yet. Click ⚡ Influences to compute.
          </div>
        )}
      </div>
    </aside>
  );
}
