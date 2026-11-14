import Difference from './Difference';

export default function FormattingDifferences({
  original,
  candidate,
}: {
  original: string;
  candidate: string;
}) {
  return (
    <details className="formatting-review">
      <summary>正文差异</summary>
      {original === candidate ? (
        <p>正文无改动</p>
      ) : (
        <div className="formatting-diff">
          <div>
            <h4>原稿 Markdown</h4>
            <Difference value={original} other={candidate} side="before" multiline />
          </div>
          <div>
            <h4>候选稿 Markdown</h4>
            <Difference value={candidate} other={original} side="after" multiline />
          </div>
        </div>
      )}
    </details>
  );
}
