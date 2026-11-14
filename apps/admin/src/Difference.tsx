import { useState } from 'react';

export default function Difference({
  value,
  other,
  side,
  multiline = false,
}: {
  value?: string;
  other?: string;
  side: 'before' | 'after';
  multiline?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  if (value === undefined) return <span className="muted">未采集</span>;
  const characters = Array.from(value),
    comparison = other === undefined ? undefined : Array.from(other);
  const visibleLength = expanded ? characters.length : Math.min(characters.length, 4000);
  const text = characters.slice(0, visibleLength).join('');
  let start = 0,
    end = 0;
  if (comparison && value !== other) {
    while (
      start < Math.min(characters.length, comparison.length) &&
      characters[start] === comparison[start]
    )
      start++;
    while (
      end < Math.min(characters.length, comparison.length) - start &&
      characters[characters.length - 1 - end] === comparison[comparison.length - 1 - end]
    )
      end++;
  }
  const changed = other !== undefined && value !== other;
  const changeStart = Math.min(start, visibleLength),
    changeEnd = Math.min(characters.length - end, visibleLength);
  return (
    <div className={multiline ? 'diff-text multiline' : 'diff-text'}>
      <div>
        {!value ? (
          '（空）'
        ) : changed ? (
          <>
            {characters.slice(0, changeStart).join('')}
            {changeEnd > changeStart && (
              <mark className={side}>{characters.slice(changeStart, changeEnd).join('')}</mark>
            )}
            {characters.slice(changeEnd, visibleLength).join('')}
          </>
        ) : (
          text
        )}
      </div>
      {characters.length > 4000 && (
        <button type="button" onClick={() => setExpanded(!expanded)}>
          {expanded ? '收起正文' : '展开全文'}
        </button>
      )}
    </div>
  );
}
