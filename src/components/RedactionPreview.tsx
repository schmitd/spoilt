import type { RedactionStyle } from "../core/types";

export function RedactionPreview({ style }: { style: RedactionStyle }) {
  return (
    <div class={`redaction-preview redaction-preview--${style}`} aria-label={`${style} redaction preview`}>
      <p>
        The final score was <span class="redaction-sample">hidden before you saw it</span> while the rest stayed readable.
      </p>
      <div class="redaction-image" role="img" aria-label="Example of a concealed image">
        <span>Image concealed</span>
      </div>
    </div>
  );
}
