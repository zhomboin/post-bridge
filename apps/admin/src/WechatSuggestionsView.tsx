import type { WechatSuggestions } from './formatting-contract';

export default function WechatSuggestionsView({ suggestions }: { suggestions: WechatSuggestions }) {
  const { title, summary, structure, issues } = suggestions;
  if (!title && !summary && !structure.length && !issues.length) return null;
  const blockNumber = (id: string) => Number(/^b(\d+)-/.exec(id)?.[1]) + 1;
  return (
    <details className="formatting-review">
      <summary>AI 辅助建议</summary>
      {(title || summary) && (
        <dl>
          {title && (
            <>
              <dt>建议标题</dt>
              <dd>{title}</dd>
            </>
          )}
          {summary && (
            <>
              <dt>建议摘要</dt>
              <dd>{summary}</dd>
            </>
          )}
        </dl>
      )}
      {(
        [
          ['结构建议', structure],
          ['需核对的问题', issues],
        ] as const
      ).map(([heading, items]) =>
        items.length ? (
          <div key={heading}>
            <h4>{heading}</h4>
            <ul>
              {items.map((item) => (
                <li key={item.source_block_id}>
                  原稿第 {blockNumber(item.source_block_id)} 段：{item.text}
                </li>
              ))}
            </ul>
          </div>
        ) : null,
      )}
    </details>
  );
}
