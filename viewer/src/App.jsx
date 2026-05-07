import { useState, useEffect, useCallback } from 'react';
import Graph from './components/Graph.jsx';
import NodeDetail from './components/NodeDetail.jsx';

const POLL_INTERVAL = 2000;

export default function App() {
  const [sessions, setSessions] = useState([]);
  const [selectedSession, setSelectedSession] = useState('');
  const [graphData, setGraphData] = useState(null);
  const [selectedNode, setSelectedNode] = useState(null);
  const [error, setError] = useState('');

  // Load session list
  const loadSessions = useCallback(async () => {
    try {
      const res = await fetch('/sessions');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSessions(data);
      if (!selectedSession && data.length > 0) {
        setSelectedSession(data[0].id);
      }
    } catch (err) {
      setError(`Cannot reach service: ${err.message}`);
    }
  }, [selectedSession]);

  // Load graph data for selected session
  const loadGraph = useCallback(async () => {
    if (!selectedSession) return;
    try {
      const res = await fetch(`/graph/${selectedSession}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setGraphData(data);
      setError('');
    } catch (err) {
      setError(`Graph fetch failed: ${err.message}`);
    }
  }, [selectedSession]);

  // Initial load
  useEffect(() => {
    loadSessions();
  }, []);

  // Poll for updates
  useEffect(() => {
    if (!selectedSession) return;
    loadGraph();
    const id = setInterval(loadGraph, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [selectedSession, loadGraph]);

  // Refresh sessions list periodically
  useEffect(() => {
    const id = setInterval(loadSessions, 5000);
    return () => clearInterval(id);
  }, [loadSessions]);

  const handleComputeInfluences = async () => {
    if (!selectedSession) return;
    try {
      await fetch(`/compute_influences/${selectedSession}`, { method: 'POST' });
      await loadGraph();
    } catch (err) {
      setError(err.message);
    }
  };

  const nodeCount = graphData?.nodes?.length ?? 0;
  const edgeCount = graphData?.edges?.length ?? 0;

  return (
    <div className="app">
      <header className="header">
        <span className="dot" title="Polling active" />
        <h1>Nexus Provenance</h1>

        <select
          className="session-select"
          value={selectedSession}
          onChange={(e) => { setSelectedSession(e.target.value); setSelectedNode(null); }}
        >
          {sessions.length === 0 && <option value="">— no sessions yet —</option>}
          {sessions.map(s => (
            <option key={s.id} value={s.id}>
              {s.id.slice(0, 8)}… · {new Date(s.updated_at).toLocaleTimeString()}
            </option>
          ))}
        </select>

        <button className="btn" onClick={loadSessions}>↻ Sessions</button>
        <button className="btn" onClick={handleComputeInfluences} title="Compute influence edges for synthesis nodes">
          ⚡ Influences
        </button>

        <span className="pill" style={{ marginLeft: 'auto', color: '#8b949e', borderColor: '#30363d' }}>
          {nodeCount} nodes · {edgeCount} edges
        </span>

        {error && (
          <span className="pill" style={{ color: '#f85149', borderColor: '#f85149' }} title={error}>
            ⚠ {error.slice(0, 40)}
          </span>
        )}
      </header>

      <main className="main">
        <div className="graph-area">
          {(!graphData || nodeCount === 0) ? (
            <div className="empty-state">
              <h2>No data yet</h2>
              <p>
                Start a Claude Code session with the hooks configured.<br />
                Nodes will appear here as Claude processes your request.
              </p>
              <p style={{ marginTop: 8, color: '#58a6ff', fontSize: 11 }}>
                POST to /node or add the hooks snippet from settings.snippet.json
              </p>
            </div>
          ) : (
            <Graph
              graphData={graphData}
              selectedNode={selectedNode}
              onNodeClick={setSelectedNode}
            />
          )}
        </div>

        {selectedNode && (
          <NodeDetail
            node={selectedNode}
            graphData={graphData}
            onClose={() => setSelectedNode(null)}
          />
        )}
      </main>
    </div>
  );
}
