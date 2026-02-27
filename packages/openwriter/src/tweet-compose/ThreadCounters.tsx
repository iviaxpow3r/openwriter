/**
 * Thread character counters — splits editor content at horizontalRule nodes
 * and renders a mini CharacterCounter per tweet section.
 */

import { useEffect, useState } from 'react';
import type { Editor } from '@tiptap/react';
import CharacterCounter from './CharacterCounter';

/** Split editor doc at horizontalRule nodes, return plain text per section */
export function extractTweetsFromEditor(editor: Editor): string[] {
  const json = editor.getJSON();
  const content = json.content || [];
  const sections: string[][] = [[]];

  for (const node of content) {
    if (node.type === 'horizontalRule') {
      sections.push([]);
    } else {
      // Extract text from node (paragraphs, hardBreaks, etc.)
      const text = extractTextFromNode(node);
      sections[sections.length - 1].push(text);
    }
  }

  return sections
    .map(lines => lines.join('\n').trim())
    .filter(t => t.length > 0);
}

function extractTextFromNode(node: any): string {
  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak') return '\n';
  if (!node.content) return '';
  return node.content.map(extractTextFromNode).join('');
}

interface ThreadCountersProps {
  editor: Editor | null;
}

export default function ThreadCounters({ editor }: ThreadCountersProps) {
  const [tweets, setTweets] = useState<string[]>([]);

  useEffect(() => {
    if (!editor) return;
    const update = () => setTweets(extractTweetsFromEditor(editor));
    update();
    editor.on('update', update);
    return () => { editor.off('update', update); };
  }, [editor]);

  if (tweets.length === 0) return null;

  return (
    <div className="tweet-thread-counters">
      {tweets.map((text, i) => (
        <div key={i} className="tweet-thread-counter-item" title={`Tweet ${i + 1}`}>
          <span className="tweet-thread-counter-label">{i + 1}</span>
          <CharacterCounter count={text.length} />
        </div>
      ))}
    </div>
  );
}
