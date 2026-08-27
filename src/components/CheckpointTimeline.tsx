import React, { useCallback, useEffect, useState } from 'react';
import {
  History,
  ChevronDown,
  ChevronRight,
  RotateCcw,
  RefreshCw,
  FileDiff,
  Clock
} from 'lucide-react';
import { DiffView, FilePatchInfo } from './DiffView';

interface Checkpoint {
  dir: string;
  name: string;
  createdAt: string;
}

interface CheckpointTimelineProps {
  sessionId: string;
  /** Called after a successful revert so parents can refresh workspace state */
  onReverted?: (restoredCount: number) => void;
}

interface BackupListResponse {
  backups: Checkpoint[];
}

/**
 * P2.1: vertical timeline of per-run checkpoints (pre-edit snapshots).
 * Expand a step to view the whole-step unified diff vs current disk and
 * revert the entire step back to this checkpoint.
 */
export const CheckpointTimeline: React.FC<CheckpointTimelineProps> = ({ sessionId, onReverted }) => {
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [patchesByCp, setPatchesByCp] = useState<Record<string, FilePatchInfo[]>>({});
  const [reverting, setReverting] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadCheckpoints = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/workspace/backups?sessionId=${encodeURIComponent(sessionId)}`);
      const data: BackupListResponse = await res.json();
      setCheckpoints(data.backups || []);
    } catch {
      setCheckpoints([]);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    loadCheckpoints();
  }, [loadCheckpoints]);

  const toggleExpand = async (name: string) => {
    if (expanded === name) {
      setExpanded(null);
      return;
    }
    setExpanded(name);
    if (!patchesByCp[name]) {
      try {
        const res = await fetch(
          `/api/workspace/checkpoint-diff?sessionId=${encodeURIComponent(sessionId)}&backupName=${encodeURIComponent(name)}`
        );
        const data = await res.json();
        setPatchesByCp((prev) => ({ ...prev, [name]: data.patches || [] }));
      } catch {
        setPatchesByCp((prev) => ({ ...prev, [name]: [] }));
      }
    }
  };

  const revertStep = async (backupName: string) => {
    if (!window.confirm(`Restore all files captured in checkpoint "${backupName}"?\nCurrent versions of those files will be overwritten.`)) return;
    setReverting(backupName);
    try {
      const res = await fetch('/api/workspace/revert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, backupName })
      });
      const data = await res.json();
      if (data.success) {
        setNotice(`Restored ${data.restored?.length ?? 0} file(s) from ${backupName}`);
        onReverted?.(data.restored?.length ?? 0);
        // Diffs changed — invalidate cached patches
        setPatchesByCp({});
      } else {
        setNotice(data.error || 'Revert failed');
      }
    } catch (err: any) {
      setNotice(String(err?.message || err));
    } finally {
      setReverting(null);
    }
  };

  const formatStamp = (cp: Checkpoint): string => {
    // name format: <ISO-ish stamp>__<sessionId>
    const stamp = cp.createdAt || cp.name.split('__')[0];
    const iso = stamp.replace(/-(\d{2})-(\d{2})T/, '-$1-$2T').replace(/(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/, '$1-$2-$3T$4:$5:$6');
    const d = new Date(iso);
    if (!isNaN(d.getTime())) return d.toLocaleString();
    return stamp;
  };

  const sessionOf = (cp: Checkpoint): string => cp.name.split('__')[1] || '';

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-xl text-slate-100 h-full overflow-y-auto">
      <div className="flex items-center justify-between pb-3 mb-4 border-b border-slate-800">
        <div>
          <h3 className="font-bold text-base flex items-center gap-2 text-white">
            <History className="w-5 h-5 text-emerald-400" />
            Checkpoint Timeline
          </h3>
          <p className="text-xs text-slate-400 mt-0.5">
            Every agent edit batch is snapshotted before overwrite. Review diffs or roll a step back.
          </p>
        </div>
        <button
          onClick={loadCheckpoints}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs transition-colors"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {notice && (
        <div className="mb-3 px-3 py-2 rounded-md bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-300">
          {notice}
        </div>
      )}

      {!loading && checkpoints.length === 0 && (
        <div className="text-sm text-slate-500 py-8 text-center">
          No checkpoints yet — they are created automatically when the agent first overwrites a file.
        </div>
      )}

      {/* Vertical timeline */}
      <div className="relative pl-6">
        <div className="absolute left-[9px] top-2 bottom-2 w-px bg-slate-800" />
        {checkpoints.map((cp) => {
          const isOpen = expanded === cp.name;
          const patches = patchesByCp[cp.name];
          const totalAdd = (patches || []).reduce((a, p) => a + p.additions, 0);
          const totalDel = (patches || []).reduce((a, p) => a + p.deletions, 0);
          return (
            <div key={cp.name} className="relative mb-3">
              <span
                className={`absolute -left-[18px] top-4 w-[13px] h-[13px] rounded-full border-2 ${
                  isOpen ? 'bg-emerald-400 border-emerald-300' : 'bg-slate-800 border-slate-600'
                }`}
              />
              <div className={`rounded-xl border transition-colors ${isOpen ? 'border-emerald-500/40 bg-slate-950/80' : 'border-slate-800 bg-slate-950/40'}`}>
                <button
                  onClick={() => toggleExpand(cp.name)}
                  className="w-full flex items-center justify-between px-4 py-3 text-left"
                >
                  <span className="flex items-center gap-2 text-xs min-w-0">
                    {isOpen ? <ChevronDown className="w-4 h-4 text-emerald-400 shrink-0" /> : <ChevronRight className="w-4 h-4 text-slate-500 shrink-0" />}
                    <Clock className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                    <span className="font-medium text-slate-200 truncate">{formatStamp(cp)}</span>
                    {sessionOf(cp) && (
                      <span className="font-mono text-[10px] text-slate-500 truncate">({sessionOf(cp)})</span>
                    )}
                  </span>
                  {patches && (
                    <span className="font-mono text-[10px] shrink-0 ml-2">
                      <span className="text-emerald-400">+{totalAdd}</span>{' '}
                      <span className="text-rose-400">−{totalDel}</span>
                    </span>
                  )}
                </button>

                {isOpen && (
                  <div className="px-4 pb-4">
                    {patches === undefined ? (
                      <p className="text-xs text-slate-500 flex items-center gap-2 py-2">
                        <FileDiff className="w-3.5 h-3.5 animate-pulse" /> Loading diff…
                      </p>
                    ) : patches.length === 0 ? (
                      <p className="text-xs text-slate-500 py-2">No differences vs current disk.</p>
                    ) : (
                      <>
                        <DiffView patches={patches} />
                        <button
                          onClick={() => revertStep(cp.name)}
                          disabled={reverting === cp.name}
                          className="mt-3 flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 text-rose-300 text-xs font-medium transition-colors disabled:opacity-50"
                        >
                          <RotateCcw className={`w-3.5 h-3.5 ${reverting === cp.name ? 'animate-spin' : ''}`} />
                          Revert step to this checkpoint
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
