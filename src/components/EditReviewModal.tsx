import React, { useState } from 'react';
import { FileDiff, CheckSquare, Square, X, Check } from 'lucide-react';
import type { ReviewHunk } from '../../server/reviewGate';

export interface PendingReview {
  runId: string;
  toolName: string;
  path: string;
  isNewFile: boolean;
  hunks: ReviewHunk[];
}

interface EditReviewModalProps {
  review: PendingReview;
  /** Resolves the pending run; accepted = hunk ids to apply (empty = reject all) */
  onDecide: (accepted: number[]) => void;
}

/**
 * P2.2 Diff-review workflow: proposed edits are shown as per-hunk diffs with
 * accept/reject checkboxes BEFORE anything is written. Only accepted hunks
 * reach the patch engine.
 */
export const EditReviewModal: React.FC<EditReviewModalProps> = ({ review, onDecide }) => {
  const [rejected, setRejected] = useState<Set<number>>(new Set());

  const toggle = (id: number) => {
    setRejected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const totalAdd = review.hunks.reduce((a, h) => a + h.additions, 0);
  const totalDel = review.hunks.reduce((a, h) => a + h.deletions, 0);
  const acceptedIds = review.hunks.filter((h) => !rejected.has(h.id)).map((h) => h.id);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col text-slate-100">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800">
          <div>
            <h3 className="font-bold text-sm flex items-center gap-2">
              <FileDiff className="w-4 h-4 text-emerald-400" />
              Review proposed {review.toolName === 'write_file' ? 'write' : 'edit'}
            </h3>
            <p className="text-[11px] font-mono text-cyan-300 mt-0.5 truncate">
              {review.path}
              {review.isNewFile && <span className="ml-2 px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300">new file</span>}
              <span className="ml-2 font-sans text-slate-400">
                <span className="text-emerald-400">+{totalAdd}</span>{' '}
                <span className="text-rose-400">−{totalDel}</span>
              </span>
            </p>
          </div>
          <button
            onClick={() => onDecide([])}
            title="Reject all and continue"
            className="p-1.5 rounded-md hover:bg-slate-800 text-slate-400"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="overflow-y-auto p-4 space-y-3">
          {review.hunks.map((h) => {
            const accepted = !rejected.has(h.id);
            return (
              <div key={h.id} className={`rounded-lg border overflow-hidden ${accepted ? 'border-emerald-500/40' : 'border-slate-800 opacity-50'}`}>
                <button
                  onClick={() => toggle(h.id)}
                  className="w-full flex items-center justify-between px-3 py-1.5 bg-slate-800/70 hover:bg-slate-800 text-left"
                >
                  <span className="flex items-center gap-2 text-[11px]">
                    {accepted ? (
                      <CheckSquare className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <Square className="w-3.5 h-3.5 text-slate-500" />
                    )}
                    <span className="font-mono text-slate-300">{h.header}</span>
                    <span className="font-mono text-[10px]">
                      <span className="text-emerald-400">+{h.additions}</span>{' '}
                      <span className="text-rose-400">−{h.deletions}</span>
                    </span>
                  </span>
                  <span className={`text-[10px] font-medium ${accepted ? 'text-emerald-300' : 'text-slate-500'}`}>
                    {accepted ? 'ACCEPTED' : 'REJECTED'}
                  </span>
                </button>
                <pre className="p-2 text-[11px] font-mono overflow-x-auto leading-relaxed bg-slate-950">
                  {h.lines.map((l, i) => {
                    let cls = 'text-slate-500';
                    if (l.type === '+') cls = 'text-emerald-300 bg-emerald-500/10';
                    else if (l.type === '-') cls = 'text-rose-300 bg-rose-500/10';
                    return (
                      <div key={i} className={`${cls} px-1 whitespace-pre`}>
                        {l.type === ' ' ? ' ' : l.type}
                        {l.content || ' '}
                      </div>
                    );
                  })}
                </pre>
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-800">
          <button
            onClick={() => onDecide([])}
            className="px-3 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-medium"
          >
            Reject all
          </button>
          <button
            onClick={() => onDecide(acceptedIds)}
            disabled={acceptedIds.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 text-emerald-300 text-xs font-semibold disabled:opacity-40"
          >
            <Check className="w-3.5 h-3.5" />
            Apply {acceptedIds.length} of {review.hunks.length} hunks
          </button>
        </div>
      </div>
    </div>
  );
};
