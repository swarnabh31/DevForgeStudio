import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';

interface MarkdownMessageProps {
  content: string;
}

/** U1: markdown rendering with syntax-highlighted code blocks for agent replies. */
export const MarkdownMessage: React.FC<MarkdownMessageProps> = ({ content }) => (
  <div className="markdown-body font-sans text-sm leading-relaxed [&_h1]:text-base [&_h1]:font-bold [&_h1]:mt-3 [&_h1]:mb-1.5 [&_h2]:text-sm [&_h2]:font-bold [&_h2]:mt-3 [&_h2]:mb-1.5 [&_h3]:text-sm [&_h3]:font-semibold [&_p]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:my-1.5 [&_li]:my-0.5 [&_a]:text-cyan-400 [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-slate-700 [&_blockquote]:pl-3 [&_blockquote]:text-slate-400 [&_table]:text-xs [&_th]:border [&_th]:border-slate-700 [&_th]:px-2 [&_th]:py-1 [&_td]:border [&_td]:border-slate-700 [&_td]:px-2 [&_td]:py-1 [&_pre]:bg-[#0d1117] [&_pre]:rounded-lg [&_pre]:p-3 [&_pre]:overflow-x-auto [&_code]:text-[12px] [&_:not(pre)>code]:bg-slate-800/80 [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:rounded">
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}>
      {content}
    </ReactMarkdown>
  </div>
);
