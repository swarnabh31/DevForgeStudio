import React, { useEffect, useState } from 'react';
import { X, Save, ScrollText, Check, AlertCircle } from 'lucide-react';

interface ProjectRulesModalProps {
  isOpen: boolean;
  onClose: () => void;
  sessionId?: string;
}

interface ProjectConfig {
  instructions?: string;
  writePolicy?: string;
  verifyCommands?: string[];
  ignoreGlobs?: string[];
}

const WRITE_POLICIES = [
  { value: '', label: 'Default (Ask)' },
  { value: 'ask', label: 'Ask every time' },
  { value: 'review', label: 'Review diffs' },
  { value: 'allow', label: 'Auto-approve writes' },
  { value: 'deny', label: 'Deny all writes' }
];

export const ProjectRulesModal: React.FC<ProjectRulesModalProps> = ({
  isOpen,
  onClose,
  sessionId = 'default'
}) => {
  const [instructions, setInstructions] = useState('');
  const [writePolicy, setWritePolicy] = useState('');
  const [verifyCommands, setVerifyCommands] = useState('');
  const [ignoreGlobs, setIgnoreGlobs] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  useEffect(() => {
    if (!isOpen) return;
    setStatus('idle');
    fetch(`/api/project/config?sessionId=${encodeURIComponent(sessionId)}`)
      .then((r) => r.json())
      .then((d) => {
        const c: ProjectConfig = d.config || {};
        setInstructions(c.instructions || '');
        setWritePolicy(c.writePolicy || '');
        setVerifyCommands((c.verifyCommands || []).join('\n'));
        setIgnoreGlobs((c.ignoreGlobs || []).join('\n'));
      })
      .catch(() => setStatus('error'));
  }, [isOpen, sessionId]);

  if (!isOpen) return null;

  const handleSave = async () => {
    setStatus('saving');
    try {
      const config: ProjectConfig = {
        ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
        ...(writePolicy ? { writePolicy } : {}),
        verifyCommands: verifyCommands.split('\n').map((l) => l.trim()).filter(Boolean),
        ignoreGlobs: ignoreGlobs.split('\n').map((l) => l.trim()).filter(Boolean)
      };
      const r = await fetch('/api/project/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, config })
      });
      const d = await r.json();
      setStatus(d.success ? 'saved' : 'error');
      if (d.success) setTimeout(onClose, 600);
    } catch {
      setStatus('error');
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 animate-fadeIn">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-xl w-full p-6 shadow-2xl text-slate-100 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between pb-4 mb-4 border-b border-slate-800">
          <div>
            <h3 className="font-bold text-base flex items-center gap-2 text-white">
              <ScrollText className="w-5 h-5 text-emerald-400" />
              Project Rules
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Saved to <code className="text-emerald-400">.devforge.json</code> in the workspace root. An
              AGENTS.md file in the root is also picked up automatically.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-4 text-xs">
          <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1.5">
            <span className="font-semibold text-slate-200 block text-sm">Project Instructions</span>
            <textarea
              rows={4}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="e.g. Use TypeScript strict mode. Never modify files under src/generated."
              className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-xs font-mono text-slate-200 focus:outline-none focus:border-emerald-500 resize-y"
            />
          </div>

          <div className="flex items-center justify-between p-3 rounded-xl bg-slate-950 border border-slate-800">
            <div>
              <span className="font-semibold text-slate-200 block text-sm">Default Write Policy</span>
              <span className="text-slate-400 text-[11px]">Used when the header dropdown is untouched.</span>
            </div>
            <select
              value={writePolicy}
              onChange={(e) => setWritePolicy(e.target.value)}
              className="px-2 py-1.5 bg-slate-900 border border-slate-800 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
            >
              {WRITE_POLICIES.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </div>

          <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1.5">
            <span className="font-semibold text-slate-200 block text-sm">Verify Commands</span>
            <span className="text-slate-400 text-[11px] block">One command per line. Runs first during auto-verification.</span>
            <textarea
              rows={3}
              value={verifyCommands}
              onChange={(e) => setVerifyCommands(e.target.value)}
              placeholder={'npm run typecheck\ncargo check'}
              className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-xs font-mono text-slate-200 focus:outline-none focus:border-emerald-500 resize-y"
            />
          </div>

          <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1.5">
            <span className="font-semibold text-slate-200 block text-sm">Ignore Globs</span>
            <span className="text-slate-400 text-[11px] block">One glob per line. Hidden from list/search/index.</span>
            <textarea
              rows={3}
              value={ignoreGlobs}
              onChange={(e) => setIgnoreGlobs(e.target.value)}
              placeholder={'dist/**\n**/*.min.js'}
              className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-xs font-mono text-slate-200 focus:outline-none focus:border-emerald-500 resize-y"
            />
          </div>
        </div>

        <div className="mt-6 pt-4 border-t border-slate-800 flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-[11px]">
            {status === 'saved' && (
              <span className="text-emerald-400 flex items-center gap-1"><Check className="w-3.5 h-3.5" />Saved</span>
            )}
            {(status === 'error') && (
              <span className="text-rose-400 flex items-center gap-1"><AlertCircle className="w-3.5 h-3.5" />Save failed</span>
            )}
          </span>
          <button
            onClick={handleSave}
            disabled={status === 'saving'}
            className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-semibold text-xs flex items-center gap-1.5 transition-all shadow-md"
          >
            <Save className="w-3.5 h-3.5" />
            <span>{status === 'saving' ? 'Saving…' : 'Save Rules'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
