import React from 'react';

export interface FilePatchInfo {
  filePath: string;
  patch: string;
  additions: number;
  deletions: number;
}

/** U3: unified diff renderer (- red / + green) */
export const DiffView: React.FC<{ patches: FilePatchInfo[] }> = ({ patches }) => {
  if (!patches.length) return null;
  return (
    <div className="mt-2 space-y-2">
      {patches.map((p) => (
        <div key={p.filePath} className="rounded-lg border border-slate-800 overflow-hidden bg-slate-950">
          <div className="flex items-center justify-between px-3 py-1.5 bg-slate-900 border-b border-slate-800">
            <span className="font-mono text-[11px] text-cyan-300 truncate">{p.filePath}</span>
            <span className="font-mono text-[10px] shrink-0 ml-2">
              <span className="text-emerald-400">+{p.additions}</span>{' '}
              <span className="text-rose-400">−{p.deletions}</span>
            </span>
          </div>
          <pre className="p-2 text-[11px] font-mono overflow-x-auto leading-relaxed">
            {p.patch.split('\n').map((line, i) => {
              let cls = 'text-slate-500';
              if (line.startsWith('+') && !line.startsWith('+++')) cls = 'text-emerald-300 bg-emerald-500/10';
              else if (line.startsWith('-') && !line.startsWith('---')) cls = 'text-rose-300 bg-rose-500/10';
              else if (line.startsWith('@@')) cls = 'text-cyan-400';
              return (
                <div key={i} className={`${cls} px-1 whitespace-pre`}>
                  {line || ' '}
                </div>
              );
            })}
          </pre>
        </div>
      ))}
    </div>
  );
};
