import React, { useEffect, useRef, useState } from 'react';
import { X, Cpu, Download, Sparkles, CheckCircle2, AlertCircle, Wand2 } from 'lucide-react';

/**
 * P4.1: onboarding wizard — hardware-aware model recommendation, one-click
 * `ollama pull` with live progress (proxied locally), and a sample task
 * gallery for the first run.
 */

interface CatalogModel {
  id: string;
  label: string;
  minVramMB: number;
  sizeHintGB: number;
  fitsHardware: boolean;
}

interface Profile {
  cpuModel?: string;
  cpuCores?: number;
  totalRamMB?: number;
  gpus?: Array<{ name: string; vramMB: number; vendor: string }>;
  totalVramMB?: number;
  acceleration?: string;
}

export interface SampleTask {
  title: string;
  prompt: string;
}

const SAMPLE_TASKS: SampleTask[] = [
  {
    title: 'Fix a failing test',
    prompt:
      'Run the test suite, pick the first failing test, diagnose the root cause in the source, fix it, and re-run the tests to confirm.'
  },
  {
    title: 'Add input validation',
    prompt:
      'Review the main entry points of this project and add sensible input validation where user-supplied data is used unchecked. Explain each change.'
  },
  {
    title: 'Write module docs',
    prompt:
      'Pick the most important module in this workspace and write a concise README-style doc comment block at the top: purpose, public API, and an example.'
  },
  {
    title: 'Refactor duplication',
    prompt:
      'Search the codebase for obviously duplicated logic and extract it into a shared helper. Keep changes small and verify they compile.'
  }
];

interface OnboardingWizardProps {
  isOpen: boolean;
  onClose: () => void;
  onRescanModels: () => void;
  onPickSampleTask?: (prompt: string) => void;
}

type PullState = { status: 'idle' | 'pulling' | 'done' | 'error'; message?: string; pct?: number };

export const OnboardingWizard: React.FC<OnboardingWizardProps> = ({
  isOpen,
  onClose,
  onRescanModels,
  onPickSampleTask
}) => {
  const [step, setStep] = useState(0);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [catalog, setCatalog] = useState<CatalogModel[]>([]);
  const [recommendedId, setRecommendedId] = useState<string>('');
  const [selected, setSelected] = useState<string>('');
  const [pull, setPull] = useState<PullState>({ status: 'idle' });
  const esRef = useRef<{ close: () => void } | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    fetch('/api/onboarding/catalog')
      .then((r) => r.json())
      .then((d) => {
        if (d.success) {
          setProfile(d.profile);
          setCatalog(d.catalog || []);
          setRecommendedId(d.recommendedId);
          setSelected(d.recommendedId);
        }
      })
      .catch(() => {});
    return () => esRef.current?.close();
  }, [isOpen]);

  if (!isOpen) return null;

  const startPull = () => {
    if (!selected || pull.status === 'pulling') return;
    setPull({ status: 'pulling', pct: 0 });
    // fetch-stream the NDJSON progress proxy
    const controller = new AbortController();
    esRef.current = { close: () => controller.abort() };
    fetch('/api/onboarding/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: selected }),
      signal: controller.signal
    })
      .then(async (resp) => {
        if (!resp.ok || !resp.body) throw new Error(`pull failed (${resp.status})`);
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            try {
              const evt = JSON.parse(line);
              if (evt.error) throw new Error(evt.error);
              if (evt.total && evt.completed != null) {
                setPull({ status: 'pulling', pct: Math.round((evt.completed / evt.total) * 100) });
              }
              if (evt.status === 'success') setPull({ status: 'done' });
            } catch (e: any) {
              if (e instanceof SyntaxError) continue;
              throw e;
            }
          }
        }
        setPull((p) => (p.status === 'pulling' ? { status: 'done' } : p));
      })
      .catch((e: any) => {
        if (e?.name === 'AbortError') return;
        setPull({ status: 'error', message: String(e?.message || e) });
      });
  };

  const finish = () => {
    esRef.current?.close();
    onRescanModels();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 animate-fadeIn">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-xl w-full p-6 shadow-2xl text-slate-100 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between pb-4 mb-4 border-b border-slate-800">
          <h3 className="font-bold text-base flex items-center gap-2 text-white">
            <Wand2 className="w-5 h-5 text-emerald-400" />
            Welcome to DevForge Studio
          </h3>
          <button onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Step indicator */}
        <div className="flex gap-1.5 mb-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className={`h-1 flex-1 rounded ${i <= step ? 'bg-emerald-500' : 'bg-slate-800'}`} />
          ))}
        </div>

        {step === 0 && (
          <div className="space-y-3 text-xs">
            <p className="text-slate-300 text-sm font-semibold">1 · Your machine</p>
            <p className="text-slate-400">
              Everything runs locally. Here is what we detected — no account, no cloud, ever.
            </p>
            <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1 font-mono text-[11px] text-slate-300">
              <div>CPU: {profile?.cpuModel || 'unknown'} ({profile?.cpuCores || '?'} cores)</div>
              <div>RAM: {profile?.totalRamMB ? `${Math.round(profile.totalRamMB / 1024)} GB` : 'unknown'}</div>
              {(profile?.gpus || []).map((g, i) => (
                <div key={i}>GPU: {g.name} ({Math.round(g.vramMB / 1024)} GB)</div>
              ))}
              <div>Acceleration: {profile?.acceleration || 'cpu'}</div>
            </div>
            {!profile && (
              <p className="text-[11px] text-amber-400 flex items-center gap-1">
                <AlertCircle className="w-3.5 h-3.5" /> Hardware profile unavailable — you can still continue.
              </p>
            )}
            <button onClick={() => setStep(1)} className="mt-2 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold">
              Continue
            </button>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-3 text-xs">
            <p className="text-slate-300 text-sm font-semibold">2 · Pick a coding model</p>
            <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
              {catalog.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setSelected(m.id)}
                  disabled={pull.status === 'pulling'}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-xl border text-left transition-colors ${
                    selected === m.id
                      ? 'border-emerald-500 bg-emerald-500/10'
                      : 'border-slate-800 bg-slate-950 hover:border-slate-700'
                  } ${!m.fitsHardware ? 'opacity-50' : ''}`}
                >
                  <span>
                    <span className="text-slate-200 text-sm">{m.label}</span>
                    {m.id === recommendedId && (
                      <span className="ml-2 text-[10px] text-emerald-400 flex items-center gap-0.5 inline-flex">
                        <Sparkles className="w-3 h-3" /> recommended for your hardware
                      </span>
                    )}
                  </span>
                  <span className="text-[10px] text-slate-500 font-mono">~{m.sizeHintGB} GB</span>
                </button>
              ))}
            </div>
            {pull.status !== 'idle' && (
              <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
                {pull.status === 'pulling' && (
                  <>
                    <div className="flex items-center gap-2 text-[11px] text-slate-300">
                      <Download className="w-3.5 h-3.5 animate-bounce text-emerald-400" />
                      Pulling {selected}… {pull.pct ?? 0}%
                    </div>
                    <div className="h-2 rounded-full bg-slate-800 overflow-hidden">
                      <div className="h-full bg-emerald-500 transition-all" style={{ width: `${pull.pct ?? 0}%` }} />
                    </div>
                  </>
                )}
                {pull.status === 'done' && (
                  <p className="text-emerald-400 text-[11px] flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5" /> Model pulled successfully.
                  </p>
                )}
                {pull.status === 'error' && (
                  <p className="text-rose-400 text-[11px] flex items-start gap-1">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {pull.message}
                  </p>
                )}
              </div>
            )}
            <div className="flex items-center gap-2">
              <button onClick={() => setStep(0)} disabled={pull.status === 'pulling'} className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs">
                Back
              </button>
              {pull.status !== 'done' ? (
                <button
                  onClick={startPull}
                  disabled={!selected || pull.status === 'pulling'}
                  className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-semibold"
                >
                  {pull.status === 'pulling' ? 'Pulling…' : 'Download & install'}
                </button>
              ) : null}
              <button
                onClick={() => (pull.status === 'done' ? finish() : setStep(2))}
                disabled={pull.status === 'pulling'}
                className="ml-auto px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs"
              >
                Skip / Continue →
              </button>
            </div>
            <p className="text-[10px] text-slate-500">
              Requires Ollama running locally (<code>ollama serve</code>). Already have the model? Just continue.
            </p>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-3 text-xs">
            <p className="text-slate-300 text-sm font-semibold">3 · Try your first task</p>
            <p className="text-slate-400">Load a workspace folder, then click a starter task:</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {SAMPLE_TASKS.map((t) => (
                <button
                  key={t.title}
                  onClick={() => {
                    onPickSampleTask?.(t.prompt);
                    finish();
                  }}
                  className="px-3 py-3 rounded-xl bg-slate-950 border border-slate-800 hover:border-emerald-600/60 text-left transition-colors"
                >
                  <span className="text-slate-200 text-sm block mb-0.5">{t.title}</span>
                  <span className="text-[10px] text-slate-500 line-clamp-2">{t.prompt.slice(0, 80)}…</span>
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 pt-1">
              <button onClick={() => setStep(1)} className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs">
                Back
              </button>
              <button onClick={finish} className="ml-auto px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center gap-1.5">
                <Cpu className="w-3.5 h-3.5" /> Start using DevForge
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
