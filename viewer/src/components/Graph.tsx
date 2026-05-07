import { useEffect, useRef, useCallback } from 'react';
import * as d3 from 'd3';

// ─── Node visual config ────────────────────────────────────────────────────────
const NODE_COLOR: Record<string, string> = {
  intent:          '#FFD700',
  web_search:      '#4A90D9',
  web_fetch:       '#20B2AA',
  file_read:       '#3CB371',
  bash:            '#FF8C00',
  agent:           '#9370DB',
  synthesis:       '#FFFFFF',
  compression_cut: '#FF4444',
};

const DEFAULT_COLOR = '#8b949e';

const NODE_RADIUS: Record<string, number> = {
  intent:     22,
  synthesis:  18,
  agent:      16,
};
const DEFAULT_RADIUS = 14;

// y-band by type (0 = top)
const Y_BAND: Record<string, number> = {
  intent:     0,
  web_search: 1,
  web_fetch:  1,
  file_read:  1,
  bash:       1,
  agent:      1,
  synthesis:  2,
};

const LEGEND_ITEMS = [
  { type: 'intent',     label: 'Intent (root)' },
  { type: 'web_search', label: 'Web Search' },
  { type: 'web_fetch',  label: 'Web Fetch' },
  { type: 'file_read',  label: 'File Read' },
  { type: 'bash',       label: 'Bash' },
  { type: 'agent',      label: 'Sub-agent' },
  { type: 'synthesis',  label: 'Synthesis' },
];

interface GraphProps {
  graphData: any;
  selectedNode: any;
  onNodeClick: (node: any) => void;
}

export default function Graph({ graphData, selectedNode, onNodeClick }: GraphProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const simRef = useRef<any>(null);

  // Build chunk-id → node-id lookup from graphData.chunks
  const chunkToNode = useCallback((chunks: any[]) => {
    const map: Record<string, string> = {};
    (chunks || []).forEach((c: any) => { map[c.id] = c.node_id; });
    return map;
  }, []);

  useEffect(() => {
    if (!svgRef.current || !graphData) return;
    const { nodes, edges, compression_cuts, chunks } = graphData;
    if (!nodes || !nodes.length) return;

    const container = svgRef.current.parentElement!;
    const W = container.clientWidth  || 900;
    const H = container.clientHeight || 600;

    // ── Clean up previous simulation ────────────────────────────────────────
    if (simRef.current) {
      simRef.current.stop();
    }

    const svg = d3.select(svgRef.current)
      .attr('width',  W)
      .attr('height', H);

    svg.selectAll('*').remove();

    // ── Arrow marker ─────────────────────────────────────────────────────────
    const defs = svg.append('defs');
    defs.append('marker')
      .attr('id', 'arrow')
      .attr('viewBox', '0 -5 10 10')
      .attr('refX',  14)
      .attr('refY',   0)
      .attr('markerWidth',  6)
      .attr('markerHeight', 6)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-5L10,0L0,5')
      .attr('fill', '#4a5568');

    // ── Zoom layer ────────────────────────────────────────────────────────────
    const g = svg.append('g').attr('class', 'zoom-layer');
    svg.call(
      d3.zoom<SVGSVGElement, unknown>()
        .scaleExtent([0.1, 6])
        .on('zoom', ev => g.attr('transform', ev.transform))
    );

    // ── Compute band heights ──────────────────────────────────────────────────
    const bandH = H / 3.5;
    const bandY = (band: number) => bandH * 0.8 + band * bandH;

    // ── Prepare sim nodes ─────────────────────────────────────────────────────
    const simNodes = nodes.map((n: any) => ({
      ...n,
      x: W / 2 + (Math.random() - 0.5) * 200,
      y: bandY(Y_BAND[n.type] ?? 1),
      r: NODE_RADIUS[n.type] ?? DEFAULT_RADIUS,
      color: NODE_COLOR[n.type] ?? DEFAULT_COLOR,
    }));

    const nodeById: Record<string, any> = Object.fromEntries(simNodes.map((n: any) => [n.id, n]));

    // ── Aggregate influence edges: chunk→node becomes node→node ──────────────
    const c2n = chunkToNode(chunks);
    const edgeAgg: Record<string, number> = {}; // "src|tgt" → max weight

    for (const e of (edges || [])) {
      const srcNodeId = c2n[e.source_chunk_id];
      if (!srcNodeId || !nodeById[srcNodeId] || !nodeById[e.target_node_id]) continue;
      if (srcNodeId === e.target_node_id) continue;
      const key = `${srcNodeId}|${e.target_node_id}`;
      edgeAgg[key] = Math.max(edgeAgg[key] || 0, e.weight);
    }

    const simLinks = Object.entries(edgeAgg).map(([key, weight]) => {
      const [sourceId, targetId] = key.split('|');
      return {
        source: sourceId,
        target: targetId,
        weight,
      };
    });

    // ── Structural links: intent → tool nodes (lightweight) ──────────────────
    const intentNode = simNodes.find((n: any) => n.type === 'intent');
    const structLinks = intentNode
      ? simNodes
          .filter((n: any) => n.type !== 'intent' && n.type !== 'synthesis')
          .map((n: any) => ({ source: intentNode.id, target: n.id, weight: 0, structural: true }))
      : [];

    const allLinks = [...structLinks, ...simLinks];

    // ── D3 force simulation ───────────────────────────────────────────────────
    const sim = d3.forceSimulation(simNodes)
      .force('link', d3.forceLink(allLinks)
        .id((d: any) => d.id)
        .strength((d: any) => d.structural ? 0.15 : 0.3 * d.weight)
        .distance((d: any) => d.structural ? 120 : 80 + (1 - d.weight) * 100)
      )
      .force('charge', d3.forceManyBody().strength(-220))
      .force('center', d3.forceCenter(W / 2, H / 2).strength(0.05))
      .force('y', d3.forceY((d: any) => bandY(Y_BAND[d.type] ?? 1)).strength(0.5))
      .force('x', d3.forceX(W / 2).strength(0.04))
      .force('collide', d3.forceCollide((d: any) => d.r + 8).strength(0.7))
      .alphaDecay(0.028);

    simRef.current = sim;

    // ── Compression-cut lines (horizontal dashes) ────────────────────────────
    const cutGroup = g.append('g').attr('class', 'cuts');
    if (compression_cuts && compression_cuts.length) {
      compression_cuts.forEach((seq: number) => {
        const refNode = simNodes.find((n: any) => n.sequence === seq) || simNodes[seq - 1];
        if (!refNode) return;
        cutGroup.append('line')
          .attr('class', 'cut-line')
          .attr('x1', -W).attr('x2', W * 2)
          .attr('y1', refNode.y).attr('y2', refNode.y)
          .attr('stroke', '#FF4444')
          .attr('stroke-width', 1.5)
          .attr('stroke-dasharray', '8,4')
          .attr('opacity', 0.6);
      });
    }

    // ── Influence edge lines ──────────────────────────────────────────────────
    const linkGroup = g.append('g').attr('class', 'links');
    const linkEl = linkGroup
      .selectAll('line')
      .data(allLinks)
      .join('line')
      .attr('stroke', (d: any) => d.structural ? '#2d333b' : '#4a5568')
      .attr('stroke-width', (d: any) => d.structural ? 0.8 : Math.max(0.5, d.weight * 4))
      .attr('stroke-dasharray', (d: any) => d.structural ? '4,3' : null)
      .attr('marker-end', (d: any) => d.structural ? null : 'url(#arrow)')
      .attr('opacity', (d: any) => d.structural ? 0.5 : 0.75);

    // ── Node circles ──────────────────────────────────────────────────────────
    const nodeGroup = g.append('g').attr('class', 'nodes');
    const nodeEl = nodeGroup
      .selectAll('g.node')
      .data(simNodes)
      .join('g')
      .attr('class', 'node')
      .style('cursor', 'pointer')
      .call(
        d3.drag<any, any>()
          .on('start', (ev, d) => {
            if (!ev.active) sim.alphaTarget(0.3).restart();
            d.fx = d.x;
            d.fy = d.y;
          })
          .on('drag', (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
          .on('end', (ev, d) => {
            if (!ev.active) sim.alphaTarget(0);
            d.fx = null;
            d.fy = null;
          })
      )
      .on('click', (_ev: any, d: any) => onNodeClick(d));

    // Circle
    nodeEl.append('circle')
      .attr('r', (d: any) => d.r)
      .attr('fill', (d: any) => d.color)
      .attr('fill-opacity', 0.15)
      .attr('stroke', (d: any) => d.color)
      .attr('stroke-width', (d: any) => selectedNode?.id === d.id ? 3 : 1.5);

    // Label
    nodeEl.append('text')
      .text((d: any) => {
        const label = d.tool_name || d.type;
        return label.length > 14 ? label.slice(0, 13) + '…' : label;
      })
      .attr('text-anchor', 'middle')
      .attr('dy', (d: any) => d.r + 13)
      .attr('font-size', 10)
      .attr('fill', (d: any) => d.color)
      .attr('pointer-events', 'none');

    // Sequence badge
    nodeEl.append('text')
      .text((d: any) => d.sequence)
      .attr('text-anchor', 'middle')
      .attr('dy', '0.35em')
      .attr('font-size', 9)
      .attr('fill', (d: any) => d.color)
      .attr('fill-opacity', 0.8)
      .attr('pointer-events', 'none');

    // ── Simulation tick ───────────────────────────────────────────────────────
    sim.on('tick', () => {
      linkEl
        .attr('x1', (d: any) => d.source.x)
        .attr('y1', (d: any) => d.source.y)
        .attr('x2', (d: any) => d.target.x)
        .attr('y2', (d: any) => d.target.y);

      nodeEl.attr('transform', (d: any) => `translate(${d.x},${d.y})`);

      // Update cut lines to follow node y positions (rough)
      cutGroup.selectAll('.cut-line').each(function (_, i) {
        const seq = compression_cuts[i];
        const ref = simNodes.find((n: any) => n.sequence === seq);
        if (ref) {
          d3.select(this).attr('y1', ref.y).attr('y2', ref.y);
        }
      });
    });

    return () => {
      sim.stop();
    };
  }, [graphData, selectedNode, onNodeClick, chunkToNode]);

  return (
    <>
      <svg ref={svgRef} />
      <Legend />
    </>
  );
}

function Legend() {
  return (
    <div className="legend">
      {LEGEND_ITEMS.map(({ type, label }) => (
        <div className="legend-item" key={type}>
          <div className="legend-dot" style={{ background: NODE_COLOR[type] }} />
          <span>{label}</span>
        </div>
      ))}
      <div className="legend-item" style={{ marginTop: 4 }}>
        <div style={{ width: 20, height: 2, borderTop: '2px dashed #FF4444', flexShrink: 0 }} />
        <span>Context compression cut</span>
      </div>
    </div>
  );
}
