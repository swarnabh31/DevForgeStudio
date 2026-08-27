import React, { useCallback, useEffect, useState } from 'react';
import { BarChart3, RefreshCw, CheckCircle2, Timer, FileEdit, Wrench } from 'lucide-react';

/**
 * P4.2: local-only run telemetry dashboard. Reads aggregates from
 * GET /api/stats/runs (backed by .opencode/logs/runs.jsonl). No cloud.
 */

interface RunStats {
  totals: {
    runs: number;
    completed: number;
    completionRate: number | null;
    editRuns: number;
    avgDurationMs: number | null;
    avgIterations: number | null;
    totalFilesChanged: number;
  };
  toolUsage: Array<{ name: string; calls: number; fails: number }>;
  byMode: Record<string, number>;
  runs: Array<{
    runId: string;
    sessionId: string;
    startedAt: string;
    durationMs: number;
    iterations: number;
    taskMode?: string;
    modelId: string;
    filesChangedCount: number;
    toolCalls: number;
    error?: string;
  }>;
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

export const StatsDashboard: React.FC = () => {
  const [stats, setStats] = useState<RunStats | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    setLoading(true);
    fetch('/api/stats/runs?limit=200')
      .then((r) => r.json())
      .then((d) => setStats(d.success ? d : null))
      .catch(() => setStats(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(refresh, [refresh]);

  const t = stats?.totals;

  return (
    <div className="p-6 space-y-4 max-w-5xl mx-auto text-slate-100">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <BarChart3 className="w-5 h-5 text-emerald-400" />
          Run Statistics <span className="text-xs font-normal text-slate-500">(local only)</span>
        </h2>
        <button
          onClick={refresh}
          className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs flex items-center gap-1.5"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {stats && t && (
        <>
          {/* Totals cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card label="Runs" value={String(t.runs)} icon={<BarChart3 className="w-4 h-4 text-emerald-400" />} />
            <Card
              label="Completion"
              value={t.completionRate == null ? '—' : `${t.completionRate}%`}
              sub={`${t.completed}/${t.runs}`}
              icon={<CheckCircle2 className="w-4 h-4 text-emerald-400" />}
            />
            <Card
              label="Avg duration"
              value={t.avgDurationMs == null ? '—' : fmtDuration(t.avgDurationMs)}
              sub={t.avgIterations == null ? undefined : `${t.avgIterations} iters avg`}
              icon={<Timer className="w-4 h-4 text-amber-400" />}
            />
            <Card
              label="Files changed"
              value={String(t.totalFilesChanged)}
              sub={`${t.editRuns} editing runs`}
              icon={<FileEdit className="w-4 h-4 text-cyan-400" />}
            />
          </div>

          {/* Tool usage */}
          {stats.toolUsage.length > 0 && (
            <Section title="Tool usage">
              <div className="space-y-1.5">
                {stats.toolUsage.slice(0, 8).map((tool) => {
                  const max = stats.toolUsage[0].calls || 1;
                  return (
                    <div key={tool.name} className="flex items-center gap-2 text-[11px] font-mono">
                      <span className="w-32 truncate text-slate-300"><Wrench className="inline w-3 h-3 mr-1 text-slate-500" />{tool.name}</span>
                      <div className="flex-1 h-2 rounded bg-slate-800 overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-r from-emerald-600 to-emerald-400"
                          style={{ width: `${(tool.calls / max) * 100}%` }}
                        />
                      </div>
                      <span className="text-slate-400 w-24 text-right">
                        {tool.calls} calls{tool.fails ? ` · ${tool.fails} fail` : ''}
                      </span>
                    </div>
                  );
                })}
              </div>
            </Section>
          )}

          {/* Recent runs table */}
          {stats.runs.length > 0 ? (
            <Section title="Recent runs">
              <div className="overflow-x-auto">
                <table className="w-full text-[11px] font-mono">
                  <thead>
                    <tr className="text-slate-500 border-b border-slate-800 text-left">
                      <th className="py-1.5 pr-3">When</th>
                      <th className="pr-3">Mode</th>
                      <th className="pr-3">Duration</th>
                      <th className="pr-3">Iters</th>
                      <th className="pr-3">Edits</th>
                      <th className="pr-3">Tools</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.runs.map((r) => (
                      <tr key={r.runId} className="border-b border-slate-900 hover:bg-slate-900/50">
                        <td className="py-1.5 pr-3 text-slate-400">{new Date(r.startedAt).toLocaleString()}</td>
                        <td className="pr-3 text-indigo-300">{r.taskMode || 'general'}</td>
                        <td className="pr-3">{fmtDuration(r.durationMs)}</td>
                        <td className="pr-3">{r.iterations}</td>
                        <td className="pr-3">{r.filesChangedCount}</td>
                        <td className="pr-3">{r.toolCalls}</td>
                        <td>{r.error ? <span className="text-rose-400">error</span> : <span className="text-emerald-400">ok</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          ) : (
            <p className="text-xs text-slate-500">No runs logged yet — start an agent task and come back.</p>
          )}
        </>
      )}

      {!stats && !loading && (
        <p className="text-xs text-slate-500">Statistics unavailable (no local run log found).</p>
      )}
    </div>
  );
};

function Card({ label, value, sub, icon }: { label: string; value: string; sub?: string; icon: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-slate-950/80 border border-slate-800 p-4">
      <div className="flex items-center gap-1.5 text-[11px] text-slate-400 mb-1">
        {icon}
        {label}
      </div>
      <div className="text-xl font-bold">{value}</div>
      {sub && <div className="text-[10px] text-slate-500 mt-0.5">{sub}</div>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-slate-950/80 border border-slate-800 p-4">
      <h4 className="text-xs font-semibold text-slate-300 mb-2.5">{title}</h4>
      {children}
    </div>
  );
}

