import React from 'react';
import {
  ListChecks,
  Wrench,
  Files,
  Timer,
  Gauge,
  CheckCircle2,
  XCircle,
  Clock
} from 'lucide-react';

export interface PlanStep {
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}
export interface ToolFeedEntry {
  name: string;
  ok?: boolean;
}
export interface IterStat {
  index: number;
  durationMs: number;
  /** P3.4: prompt-eval timing from Ollama (prompt-cache observability) */
  promptEvalMs?: number;
  promptEvalTokens?: number;
}

interface LiveDashboardProps {
  planSteps: PlanStep[];
  toolFeed: ToolFeedEntry[];
  filesTouched: string[];
  iterStats: IterStat[];
  contextUsage: { usedTokens: number; budgetTokens: number } | null;
}

function Panel({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-slate-950/80 border border-slate-800 p-4">
      <h4 className="text-xs font-semibold text-slate-300 flex items-center gap-1.5 mb-2.5">
        {icon}
        {title}
      </h4>
      {children}
    </div>
  );
}

/**
 * P2.3 Live agent dashboard: structured, streaming panels — current plan with
 * step statuses, tool-call feed, files touched, per-iteration latency, and the
 * context budget meter. All data comes from structured loop events.
 */
export const LiveDashboard: React.FC<LiveDashboardProps> = ({
  planSteps,
  toolFeed,
  filesTouched,
  iterStats,
  contextUsage
}) => {
  if (!planSteps.length && !toolFeed.length && !filesTouched.length && !iterStats.length) return null;

  const done = planSteps.filter((s) => s.status === 'completed').length;
  const maxMs = Math.max(1, ...iterStats.map((s) => s.durationMs));

  return (
    <div className="mb-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
      {/* Plan & step statuses */}
      <Panel icon={<ListChecks className="w-3.5 h-3.5 text-emerald-400" />} title={`Plan (${done}/${planSteps.length} done)`}>
        {planSteps.length === 0 ? (
          <p className="text-[11px] text-slate-500">No plan submitted yet.</p>
        ) : (
          <ol className="space-y-1.5">
            {planSteps.map((s, i) => (
              <li key={i} className="flex items-start gap-2 text-[11px] leading-snug">
                {s.status === 'completed' ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-px" />
                ) : s.status === 'in_progress' ? (
                  <Clock className="w-3.5 h-3.5 text-cyan-400 animate-pulse shrink-0 mt-px" />
                ) : (
                  <span className="w-3.5 h-3.5 shrink-0 rounded-full border border-slate-600 mt-px" />
                )}
                <span className={s.status === 'completed' ? 'text-slate-500 line-through' : 'text-slate-200'}>
                  {s.text}
                </span>
              </li>
            ))}
          </ol>
        )}
      </Panel>

      {/* Tool call feed */}
      <Panel icon={<Wrench className="w-3.5 h-3.5 text-cyan-400" />} title={`Tool calls (${toolFeed.length})`}>
        {toolFeed.length === 0 ? (
          <p className="text-[11px] text-slate-500">Waiting for tool activity…</p>
        ) : (
          <ul className="space-y-1 font-mono text-[11px] max-h-36 overflow-y-auto">
            {[...toolFeed].reverse().map((t, i) => (
              <li key={i} className="flex items-center gap-1.5">
                {t.ok === undefined ? null : t.ok ? (
                  <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                ) : (
                  <XCircle className="w-3 h-3 text-rose-400" />
                )}
                <span className="text-slate-300">{t.name}</span>
                {t.ok === undefined && <span className="text-slate-600 animate-pulse">…</span>}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* Files touched */}
      <Panel icon={<Files className="w-3.5 h-3.5 text-indigo-400" />} title={`Files touched (${filesTouched.length})`}>
        {filesTouched.length === 0 ? (
          <p className="text-[11px] text-slate-500">No edits yet.</p>
        ) : (
          <ul className="font-mono text-[11px] space-y-1 max-h-36 overflow-y-auto text-slate-300">
            {filesTouched.map((f) => (
              <li key={f} className="truncate">{f}</li>
            ))}
          </ul>
        )}
      </Panel>

      {/* Per-iteration latency */}
      <Panel icon={<Timer className="w-3.5 h-3.5 text-amber-400" />} title={`Iteration latency (${iterStats.length})`}>
        {iterStats.length === 0 ? (
          <p className="text-[11px] text-slate-500">No completed iterations yet.</p>
        ) : (
          <div className="flex items-end gap-1 h-14">
            {iterStats.map((s) => (
              <div key={s.index} className="flex-1 flex flex-col items-center justify-end group relative">
                <span className="absolute -top-4 hidden group-hover:block text-[10px] font-mono text-slate-400 whitespace-nowrap">
                  {(s.durationMs / 1000).toFixed(1)}s{s.promptEvalMs != null ? ` · prompt-eval ${(s.promptEvalMs / 1000).toFixed(1)}s${s.promptEvalTokens ? ` (${s.promptEvalTokens} tok)` : ''}` : ''}
                </span>
                <div
                  className="w-full rounded-t bg-gradient-to-t from-amber-500/60 to-amber-300"
                  style={{ height: `${Math.max(6, (s.durationMs / maxMs) * 100)}%` }}
                />
              </div>
            ))}
          </div>
        )}
      </Panel>

      {/* Context usage meter */}
      <Panel icon={<Gauge className="w-3.5 h-3.5 text-cyan-400" />} title="Context budget">
        {!contextUsage || contextUsage.budgetTokens <= 0 ? (
          <p className="text-[11px] text-slate-500">No context data yet.</p>
        ) : (() => {
          const pct = Math.min(100, (contextUsage.usedTokens / contextUsage.budgetTokens) * 100);
          const barColor = pct >= 75 ? 'bg-rose-500' : pct >= 50 ? 'bg-amber-400' : 'bg-emerald-500';
          return (
            <>
              <div className="flex justify-between text-[11px] font-mono text-slate-400 mb-1.5">
                <span>~{Math.round(contextUsage.usedTokens / 100) / 10}k tokens</span>
                <span>{Math.round(pct)}% of {Math.round(contextUsage.budgetTokens / 1000)}k</span>
              </div>
              <div className="h-2 rounded-full bg-slate-800 overflow-hidden">
                <div className={`h-full rounded-full transition-all duration-500 ${barColor}`} style={{ width: `${pct}%` }} />
              </div>
            </>
          );
        })()}
      </Panel>
    </div>
  );
};
