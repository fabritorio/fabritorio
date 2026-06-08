'use client';

import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

export function MarkdownContent({ content }: { content: string }) {
    return (
        <div className="fab-md text-sm leading-relaxed">
            <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkMath]}
                rehypePlugins={[
                    rehypeKatex,
                    [rehypeHighlight, { detect: true, ignoreMissing: true }],
                ]}
            >
                {content}
            </ReactMarkdown>
        </div>
    );
}
