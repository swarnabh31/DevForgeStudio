import React, { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import { BookOpen, FileText } from 'lucide-react';

/**
 * P5.4: in-app docs site. Renders the markdown files from /docs via
 * GET /api/docs (list) and GET /api/docs/:name (content).
 */

interface DocEntry {
  name: string;
  title: string;
}

export const DocsPanel: React.FC = () => {
  const [docs, setDocs] = useState<DocEntry[]>([]);
  const [active, setActive] = useState<string>('');
  const [content, setContent] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/docs')
      .then((r) => r.json())
      .then((d) => {
        if (d.success && d.docs?.length) {
          setDocs(d.docs);
          setActive(d.docs[0].name);
        } else {
          setError('No documentation found.');
        }
      })
      .catch(() => setError('Failed to load docs.'));
  }, []);

  useEffect(() => {
    if (!active) return;
    setContent('');
    fetch(`/api/docs/${encodeURIComponent(active)}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.success) setContent(d.content);
        else setError(d.error || 'Failed to load doc.');
      })
      .catch(() => setError('Failed to load doc.'));
  }, [active]);

  return (
    <div className="p-6 max-w-6xl mx-auto text-slate-100">
      <h2 className="text-lg font-bold flex items-center gap-2 mb-4">
        <BookOpen className="w-5 h-5 text-emerald-400" />
        Documentation
      </h2>
      {error && <p className="text-xs text-rose-400">{error}</p>}
      <div className="flex gap-4 items-start">
        <nav className="w-48 shrink-0 rounded-xl bg-slate-950/80 border border-slate-800 p-2 space-y-0.5">
          {docs.map((d) => (
            <button
              key={d.name}
              onClick={() => setActive(d.name)}
              className={`w-full flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs transition-colors ${
                active === d.name
                  ? 'bg-emerald-500/15 text-emerald-300 font-semibold'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
              }`}
            >
              <FileText className="w-3.5 h-3.5" /> {d.title}
            </button>
          ))}
        </nav>
        <article className="flex-1 min-w-0 rounded-xl bg-slate-950/80 border border-slate-800 p-6 prose prose-invert prose-sm max-w-none prose-headings:text-white prose-a:text-emerald-400 prose-code:text-emerald-300">
          <ReactMarkdown rehypePlugins={[rehypeHighlight]}>{content}</ReactMarkdown>
        </article>
      </div>
    </div>
  );
};
